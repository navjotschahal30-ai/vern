import { normalizeLeadProfile, LeadProfile } from '../schemas/leadProfile';
import { getLoftyHeaders } from '../config/loftyClient';

type NormalizeArgs = Parameters<typeof normalizeLeadProfile>;

export class LoftyRateLimitError extends Error {
  constructor(url: string) {
    super(`Lofty rate limit (429) on ${url}`);
    this.name = 'LoftyRateLimitError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string, headers: Record<string, string>, fallback: T): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn(`[lofty] timeout (>15s) on ${url}`);
      throw new Error(`Lofty request timeout on ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 429) {
    console.warn(`[lofty] 429 rate limited: GET ${url}`);
    throw new LoftyRateLimitError(url);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>');
    console.error(`[lofty] GET ${url} failed: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`);
    return fallback;
  }
  return (await response.json()) as T;
}

/**
 * Fetches a lead plus its notes, call history, email history, and activity
 * timeline from the Lofty API and returns the normalized LeadProfile.
 * Nothing else should talk to the raw Lofty API directly — this (and
 * handleLoftyWebhook, which just resolves a leadId from a webhook payload
 * and delegates here) is the single point of entry.
 */
export async function fetchLeadProfile(leadId: string): Promise<LeadProfile> {
  try {
    const headers = getLoftyHeaders();

    // Sequential with delays, not Promise.all — firing all 6 requests at once
    // triggers Lofty's per-second rate limit on cadence runs that hit many leads.
    const leadData = await fetchJson<{ lead: NormalizeArgs[0] }>(`https://api.lofty.com/v1.0/leads/${leadId}`, headers, {
      lead: undefined as unknown as NormalizeArgs[0],
    });
    await sleep(80);
    // Explicit limit=100 (Lofty's documented max) — omitting it defaults to a
    // small page size that silently drops older notes on any lead with more
    // than a handful logged, which is how a manual call-log note went missing
    // from a prior fetch.
    const notesData = await fetchJson<{ notes: NormalizeArgs[1] }>(
      `https://api.lofty.com/v1.0/notes?leadId=${leadId}&limit=100`,
      headers,
      { notes: [] },
    );
    await sleep(80);
    const callHistoryData = await fetchJson<{ calls: NormalizeArgs[2] }>(
      `https://api.lofty.com/v1.0/communication/call?leadId=${leadId}`,
      headers,
      { calls: [] },
    );
    await sleep(80);
    const emailHistoryData = await fetchJson<{ emails: NormalizeArgs[3] }>(
      `https://api.lofty.com/v1.0/communication/email?leadId=${leadId}`,
      headers,
      { emails: [] },
    );
    await sleep(80);
    const activitiesData = await fetchJson<{ activities: NormalizeArgs[4] }>(
      // Default limit is 10, sorted ascending — that's the OLDEST 10
      // activities, not the most recent. 1000 is the documented max and
      // comfortably covers any real lead's full history.
      `https://api.lofty.com/v2.0/leads/${leadId}/activities?limit=1000`,
      headers,
      { activities: [] },
    );
    await sleep(80);
    const textHistoryData = await fetchJson<{ texts: NormalizeArgs[5] }>(
      `https://api.lofty.com/v1.0/communication/text?leadId=${leadId}`,
      headers,
      { texts: [] },
    );
    await sleep(80);
    // Stage/assignment/routing change audit trail — explicitly excludes
    // calls/texts/emails/notes (those come from the endpoints above), so this
    // is the only source for "lead moved to Warm on <date>" type signals.
    const systemLogsData = await fetchJson<{ timeLines: NormalizeArgs[6] }>(
      `https://api.lofty.com/v1.0/systemLogs?leadId=${leadId}&pageSize=100`,
      headers,
      { timeLines: [] },
    );
    await sleep(80);
    const tasksData = await fetchJson<{ tasks: NormalizeArgs[7] }>(
      `https://api.lofty.com/v2.0/tasks?leadId=${leadId}`,
      headers,
      { tasks: [] },
    );
    await sleep(80);
    // Showings/appointments tied to this lead (as opposed to /v2.0/tasks,
    // which is agent to-dos) — a booked appointment is a strong signal
    // qualificationEngine currently has no way to see.
    const calendarData = await fetchJson<{ data: { items: NormalizeArgs[8] } }>(
      `https://api.lofty.com/v2.0/calendar?leadId=${leadId}&pageSize=100`,
      headers,
      { data: { items: [] } },
    );

    if (!leadData.lead) {
      throw new Error(`Lofty returned no lead data for leadId=${leadId} — see [lofty] log line above for the HTTP status`);
    }

    return normalizeLeadProfile(
      leadData.lead,
      notesData.notes,
      callHistoryData.calls,
      emailHistoryData.emails,
      activitiesData.activities,
      textHistoryData.texts,
      systemLogsData.timeLines,
      tasksData.tasks,
      calendarData.data.items,
    );
  } catch (error) {
    console.error(`fetchLeadProfile failed for leadId=${leadId}`, error);
    throw error;
  }
}

/**
 * Entry point all downstream agents (Aria, IDX Stalker, CRM Agent) call.
 *
 * Receives a Lofty "lead updated" webhook payload and returns the
 * normalized LeadProfile those agents consume.
 */
export async function handleLoftyWebhook(payload: any): Promise<LeadProfile> {
  const leadId = payload.updatedLead[0].leadId;
  return fetchLeadProfile(leadId);
}

export interface CallSummary {
  status: number;
  text: string;
  summary: string;
  score: number;
  comment: string;
  keywords: Array<{ content: string; type: string }>;
}

/**
 * Fetches an AI-generated transcript + summary for a recorded call. Only
 * populated for dialer-recorded calls (status 2 = finished processing) — a
 * manually logged call with no recording will 404 or return an empty
 * summary. Per-call, not per-lead, so it's not part of fetchLeadProfile's
 * batch fetch; callers pass a callRecordId pulled from /v1.0/calls.
 */
export async function getCallSummary(callRecordId: string): Promise<CallSummary | null> {
  const headers = getLoftyHeaders();
  const response = await fetchJson<{ data: CallSummary | null }>(
    `https://api.lofty.com/v2.0/ai/call-summary?callRecordId=${callRecordId}`,
    headers,
    { data: null },
  );
  return response.data;
}

// Lofty rejects limit values above 100 (errorCode=20042 "Limit must be between 1 and 100"),
// so we page through offsets and stop once _metadata.total has been covered.
const LOFTY_LEADS_PAGE_SIZE = 100;

/**
 * Lists leadIds assigned to a given user, for batch cadence runs that need
 * "all of Navjot's leads" rather than an explicit leadIds list.
 */
export async function fetchAssignedLeadIds(assignedUserId: string): Promise<string[]> {
  const headers = getLoftyHeaders();

  const leadIds: string[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `https://api.lofty.com/v1.0/leads?assignedUserId=${assignedUserId}&limit=${LOFTY_LEADS_PAGE_SIZE}&offset=${offset}`;
    const { leads, _metadata } = await fetchJson<{
      leads: Array<{ leadId: number | string }>;
      _metadata?: { total?: number };
    }>(url, headers, { leads: [] });

    if (leads.length === 0) break;

    leadIds.push(...leads.map((lead) => String(lead.leadId)));
    offset += leads.length;
    total = _metadata?.total ?? leadIds.length;
  }

  return leadIds;
}
