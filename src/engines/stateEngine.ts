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
import { fetchLeadProfile } from '../handlers/loftyWebhookHandler';
import type { LeadQualification } from './qualificationEngine';

const LOFTY_BASE_URL = 'https://api.lofty.com/v1.0';

const VERN_STATE_PREFIX = 'VERN-STATE:';
const VERN_LAST_SMS_PREFIX = 'VERN-LAST-SMS:';
const VERN_LAST_EMAIL_PREFIX = 'VERN-LAST-EMAIL:';
const VERN_CONTACTED_TODAY_TAG = 'VERN-CONTACTED-TODAY';
const VERN_QUAL_PREFIX = 'VERN-QUAL-';
const VERN_LAST_EVAL_PREFIX = 'VERN-LAST-EVAL:';

// Marks Vern's own status note so syncActivityNote can find and replace it
// without ever touching a real note a human wrote — the API key writes as
// the same Lofty user as any manual note, so creatorId can't tell them
// apart, only this content prefix can.
const VERN_NOTE_MARKER = '[VERN-ACTIVITY]';

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

export async function tagLeadByQualification(leadId: string, qualification: LeadQualification): Promise<void> {
  const lead = await fetchLeadProfile(leadId);
  const tags = lead.tags || [];

  const qualificationTag = `VERN-QUAL-${qualification.status.toUpperCase()}`;
  let updatedTags = replaceTagsWithPrefix(tags, VERN_QUAL_PREFIX, qualificationTag);
  // Stamped in the same write as the classification tag (not a separate
  // API call) — clearQualificationTags() below reads this to rank leads by
  // staleness so each rotation favors whoever hasn't been tagged recently.
  updatedTags = replaceTagsWithPrefix(updatedTags, VERN_LAST_EVAL_PREFIX, `${VERN_LAST_EVAL_PREFIX}${new Date().toISOString()}`);

  await writeLeadTags(leadId, updatedTags);
}

/**
 * Strips a lead's classification tags (VERN-QUAL-*, VERN-STATE:) and
 * returns its previous VERN-LAST-EVAL timestamp (null if Vern has never
 * tagged it). Used ahead of a fresh tagging pass so a lead that falls out
 * of this cycle's rotation doesn't keep a stale hot/warm/ghost label
 * forever, and so the caller can rank the full book by staleness to decide
 * who gets re-evaluated next. VERN-LAST-EVAL itself is left untouched here
 * — it only advances when tagLeadByQualification actually re-tags a lead.
 * Skips the write entirely when nothing needs to change.
 */
export async function clearQualificationTags(leadId: string): Promise<{ lastEvaluatedAt: string | null }> {
  const tags = await fetchLeadTags(leadId);
  const lastEvaluatedAt = parseTagValue(tags, VERN_LAST_EVAL_PREFIX);

  const cleaned = tags.filter((tag) => !tag.startsWith(VERN_QUAL_PREFIX) && !tag.startsWith(VERN_STATE_PREFIX));

  if (cleaned.length !== tags.length) {
    await writeLeadTags(leadId, cleaned);
  }

  return { lastEvaluatedAt };
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

interface LoftyNote {
  noteId: number;
  content: string;
}

async function fetchLeadNotes(leadId: string): Promise<LoftyNote[]> {
  const response = await fetch(`${LOFTY_BASE_URL}/notes?leadId=${leadId}`, { headers: getLoftyHeaders() });
  if (!response.ok) {
    throw new Error(`Lofty notes fetch failed for leadId=${leadId} with status ${response.status}`);
  }
  const data = (await response.json()) as { notes?: LoftyNote[] };
  return data.notes ?? [];
}

async function deleteNote(noteId: number): Promise<void> {
  const response = await fetch(`${LOFTY_BASE_URL}/notes/${noteId}`, {
    method: 'DELETE',
    headers: getLoftyHeaders(),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Lofty note delete failed for noteId=${noteId} with status ${response.status}`);
  }
}

async function createNote(leadId: string, content: string): Promise<void> {
  const response = await fetch(`${LOFTY_BASE_URL}/notes`, {
    method: 'POST',
    headers: getLoftyHeaders(),
    body: JSON.stringify({ leadId: Number(leadId), content: content.slice(0, 2000), isPin: true }),
  });
  if (!response.ok) {
    throw new Error(`Lofty note create failed for leadId=${leadId} with status ${response.status}`);
  }
}

/**
 * Replaces Vern's single status note on a lead with a fresh one — deletes
 * whatever Vern wrote last time (matched by VERN_NOTE_MARKER) before
 * creating the new one, so the lead's note timeline never accumulates more
 * than one Vern-authored note no matter how many cadence runs touch it.
 * Best-effort: a note-sync failure is logged and swallowed rather than
 * thrown, since this is visibility only and must never block real
 * outreach (recordOutreach/tagLeadByQualification already happened).
 */
export async function syncActivityNote(leadId: string, summaryLines: string[]): Promise<void> {
  try {
    const notes = await fetchLeadNotes(leadId);
    const existing = notes.find((note) => note.content.startsWith(VERN_NOTE_MARKER));
    if (existing) {
      await deleteNote(existing.noteId);
    }
    const content = [`${VERN_NOTE_MARKER} Auto-generated by Vern — do not edit manually.`, ...summaryLines].join('\n');
    await createNote(leadId, content);
  } catch (error) {
    console.error(`syncActivityNote failed for leadId=${leadId}`, error);
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
