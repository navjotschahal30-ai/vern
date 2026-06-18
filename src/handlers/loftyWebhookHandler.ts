import { normalizeLeadProfile, LeadProfile } from '../schemas/leadProfile';
import { getLoftyHeaders } from '../config/loftyClient';

type NormalizeArgs = Parameters<typeof normalizeLeadProfile>;

async function fetchJson<T>(url: string, headers: Record<string, string>, fallback: T): Promise<T> {
  const response = await fetch(url, { headers });
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

    const [leadData, notesData, callHistoryData, emailHistoryData, activitiesData, textHistoryData] = await Promise.all([
      fetchJson<{ lead: NormalizeArgs[0] }>(`https://api.lofty.com/v1.0/leads/${leadId}`, headers, { lead: undefined as unknown as NormalizeArgs[0] }),
      fetchJson<{ notes: NormalizeArgs[1] }>(`https://api.lofty.com/v1.0/notes?leadId=${leadId}`, headers, { notes: [] }),
      fetchJson<{ calls: NormalizeArgs[2] }>(`https://api.lofty.com/v1.0/communication/call?leadId=${leadId}`, headers, {
        calls: [],
      }),
      fetchJson<{ emails: NormalizeArgs[3] }>(`https://api.lofty.com/v1.0/communication/email?leadId=${leadId}`, headers, {
        emails: [],
      }),
      fetchJson<{ activities: NormalizeArgs[4] }>(`https://api.lofty.com/v2.0/leads/${leadId}/activities`, headers, {
        activities: [],
      }),
      fetchJson<{ texts: NormalizeArgs[5] }>(`https://api.lofty.com/v1.0/communication/text?leadId=${leadId}`, headers, {
        texts: [],
      }),
    ]);

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
 * Entry point all downstream agents (Aria, IDX Stalker, CRM Agent) call.
 *
 * Receives a Lofty "lead updated" webhook payload and returns the
 * normalized LeadProfile those agents consume.
 */
export async function handleLoftyWebhook(payload: any): Promise<LeadProfile> {
  const leadId = payload.updatedLead[0].leadId;
  return fetchLeadProfile(leadId);
}
