// ---------------------------------------------------------------------------
// Tracks Vern's own lead state directly in Lofty tags, so the cadence
// manager and event listener (and Lofty itself, for visibility) all read
// from one place. Lofty tags carry no separate value field, so
// value-carrying state is encoded as "PREFIX:value" tag strings (e.g.
// "VERN-STATE:hot") and parsed back out by prefix — every write here
// replaces the existing tag with that prefix rather than appending, which
// is what makes recordOutreach/updateLeadState idempotent and prevents
// duplicate tags from piling up.
// ---------------------------------------------------------------------------

import { getLoftyHeaders } from '../config/loftyClient';

const LOFTY_BASE_URL = 'https://api.lofty.com/v1.0';

const VERN_STATE_PREFIX = 'VERN-STATE:';
const VERN_LAST_SMS_PREFIX = 'VERN-LAST-SMS:';
const VERN_LAST_EMAIL_PREFIX = 'VERN-LAST-EMAIL:';
const VERN_CONTACTED_TODAY_TAG = 'VERN-CONTACTED-TODAY';

export interface LeadState {
  state: 'hot' | 'warm' | 'ghost';
  lastSmsAt: string | null;
  lastEmailAt: string | null;
}

const VALID_STATES: ReadonlySet<string> = new Set(['hot', 'warm', 'ghost']);

interface LoftyLeadTagsResponse {
  lead: {
    tags?: Array<{ tagName: string }>;
  };
}

async function fetchLeadTags(leadId: string): Promise<string[]> {
  const response = await fetch(`${LOFTY_BASE_URL}/leads/${leadId}`, { headers: getLoftyHeaders() });
  if (!response.ok) {
    throw new Error(`Lofty lead fetch failed for leadId=${leadId} with status ${response.status}`);
  }
  const data = (await response.json()) as LoftyLeadTagsResponse;
  return (data.lead.tags ?? []).map((tag) => tag.tagName);
}

async function writeLeadTags(leadId: string, tags: string[]): Promise<void> {
  const response = await fetch(`${LOFTY_BASE_URL}/leads/${leadId}`, {
    method: 'PUT',
    headers: getLoftyHeaders(),
    body: JSON.stringify({ tags }),
  });
  if (!response.ok) {
    throw new Error(`Lofty tag update failed for leadId=${leadId} with status ${response.status}`);
  }
}

/**
 * Removes any tag starting with `prefix`, then appends `newTag` if given.
 * `newTag: null` just removes. Operates on the lead's full tag list so
 * non-Vern tags (DNC, source tags, etc.) are always preserved untouched.
 */
function replaceTagsWithPrefix(tags: string[], prefix: string, newTag: string | null): string[] {
  const withoutPrefix = tags.filter((tag) => !tag.startsWith(prefix));
  return newTag !== null ? [...withoutPrefix, newTag] : withoutPrefix;
}

function parseTagValue(tags: string[], prefix: string): string | null {
  const match = tags.find((tag) => tag.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

/** Reads Vern's tracked state for a lead straight from its current Lofty tags. */
export async function getLeadState(leadId: string): Promise<LeadState> {
  try {
    const tags = await fetchLeadTags(leadId);
    const rawState = parseTagValue(tags, VERN_STATE_PREFIX);

    // No VERN-STATE tag yet (lead never evaluated by Vern) defaults to
    // 'warm' — the least-aggressive bucket — rather than assuming hot/ghost.
    const state: LeadState['state'] = VALID_STATES.has(rawState ?? '') ? (rawState as LeadState['state']) : 'warm';

    return {
      state,
      lastSmsAt: parseTagValue(tags, VERN_LAST_SMS_PREFIX),
      lastEmailAt: parseTagValue(tags, VERN_LAST_EMAIL_PREFIX),
    };
  } catch (error) {
    console.error(`getLeadState failed for leadId=${leadId}`, error);
    throw error;
  }
}

/**
 * Records that Vern just sent `type` to this lead: stamps VERN-LAST-SMS or
 * VERN-LAST-EMAIL with the current timestamp and sets VERN-CONTACTED-TODAY.
 * Idempotent — re-running this overwrites the same prefixed tags rather
 * than accumulating duplicates.
 */
export async function recordOutreach(leadId: string, type: 'sms' | 'email'): Promise<void> {
  try {
    const tags = await fetchLeadTags(leadId);
    const timestamp = new Date().toISOString();
    const prefix = type === 'sms' ? VERN_LAST_SMS_PREFIX : VERN_LAST_EMAIL_PREFIX;

    let updatedTags = replaceTagsWithPrefix(tags, prefix, `${prefix}${timestamp}`);
    updatedTags = replaceTagsWithPrefix(updatedTags, VERN_CONTACTED_TODAY_TAG, VERN_CONTACTED_TODAY_TAG);

    await writeLeadTags(leadId, updatedTags);
  } catch (error) {
    console.error(`recordOutreach failed for leadId=${leadId}, type=${type}`, error);
    throw error;
  }
}

/** Updates VERN-STATE in Lofty, replacing any prior state tag rather than accumulating. */
export async function updateLeadState(leadId: string, state: 'hot' | 'warm' | 'ghost' | 'blocked'): Promise<void> {
  try {
    const tags = await fetchLeadTags(leadId);
    const updatedTags = replaceTagsWithPrefix(tags, VERN_STATE_PREFIX, `${VERN_STATE_PREFIX}${state}`);
    await writeLeadTags(leadId, updatedTags);
  } catch (error) {
    console.error(`updateLeadState failed for leadId=${leadId}, state=${state}`, error);
    throw error;
  }
}

/**
 * Adds a plain (non-Vern-prefixed) tag to a lead if not already present —
 * e.g. 'DNC' from the Event Listener on an opt-out. Idempotent: re-adding
 * an existing tag is a no-op rather than a duplicate.
 */
export async function addTag(leadId: string, tag: string): Promise<void> {
  try {
    const tags = await fetchLeadTags(leadId);
    if (tags.includes(tag)) return;
    await writeLeadTags(leadId, [...tags, tag]);
  } catch (error) {
    console.error(`addTag failed for leadId=${leadId}, tag=${tag}`, error);
    throw error;
  }
}

/** Removes VERN-CONTACTED-TODAY. Intended to run once nightly via a midnight job. */
export async function clearDailyContactMarker(leadId: string): Promise<void> {
  try {
    const tags = await fetchLeadTags(leadId);
    const updatedTags = replaceTagsWithPrefix(tags, VERN_CONTACTED_TODAY_TAG, null);
    await writeLeadTags(leadId, updatedTags);
  } catch (error) {
    console.error(`clearDailyContactMarker failed for leadId=${leadId}`, error);
    throw error;
  }
}
