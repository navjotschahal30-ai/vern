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
    const notesData = await fetchJson<{ notes: NormalizeArgs[1] }>(`https://api.lofty.com/v1.0/notes?leadId=${leadId}`, headers, {
      notes: [],
    });
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
    );
  } catch (error) {
    console.error(`fetchLeadProfile failed for leadId=${leadId}`, error);
    throw error;
  }
}

/**
 * Entry point all downstream agents (Mosaic Intelligence, IDX Stalker, CRM Agent) call.
 *
 * Receives a Lofty "lead updated" webhook payload and returns the
 * normalized LeadProfile those agents consume.
 */
export async function handleLoftyWebhook(payload: any): Promise<LeadProfile> {
  const leadId = payload.updatedLead[0].leadId;
  return fetchLeadProfile(leadId);
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
