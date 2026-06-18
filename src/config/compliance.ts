import { LeadProfile } from '../schemas/leadProfile';
import {
  DNC_PATTERN,
  BLOCKED_TAG_PATTERN,
  OWN_AGENT_NAME,
  hasTagMatching,
  hasNoteMatching,
  findOtherAgentName,
} from '../engines/qualificationEngine';

/**
 * Timestamps (ISO) of the most recent SMS/email Vern actually sent this
 * lead — the caller (state machine / send log) supplies this; compliance.ts
 * has no storage of its own.
 */
export interface OutreachHistory {
  lastSmsAt: string | null;
  lastEmailAt: string | null;
}

export type LeadStatusForCadence = 'hot' | 'warm' | 'ghost' | 'blocked' | 'unknown';

const ONE_DAY_MS = 1000 * 60 * 60 * 24;
const MAX_DATE = new Date(8640000000000000); // JS max date — used as a "never" sentinel

// A human agent can apply this tag in Lofty to explicitly mark a lead safe
// to contact despite what automated rules would otherwise say (e.g. a known
// personal contact who got miscategorized). Never inferred automatically.
const COMPLIANCE_BYPASS_TAG = 'COMPLIANCE-OVERRIDE';

// TCPA/CASL-driven frequency caps.
const SMS_HOT_CAP_DAYS = 3;
const SMS_WARM_CAP_DAYS = 7;
const EMAIL_CAP_DAYS = 7;
const BLANKET_COOLDOWN_HOURS = 24;

// SMS business-hours window (TCPA requires consent-aware, reasonable-hours
// contact; 8am-8pm in the recipient's time zone is the conventional safe
// harbor). Email has no such restriction.
const BUSINESS_TIMEZONE = 'America/New_York';
const SMS_WINDOW_START_HOUR = 8;
const SMS_WINDOW_END_HOUR = 20;
const QUEUED_SEND_HOUR = 9;
const BUSINESS_WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

const MARKETING_EMAIL_QUESTION_PATTERN = /marketing email/i;
const NEGATIVE_ANSWER_PATTERN = /^(no|none|n\/a|na|not applicable|nope)$/i;

// ---------------------------------------------------------------------------
// DNC / opt-out detection
// ---------------------------------------------------------------------------

function hasDncSignal(lead: LeadProfile): boolean {
  return hasTagMatching(lead.tags, DNC_PATTERN) || hasNoteMatching(lead.formResponses, DNC_PATTERN);
}

function declinedMarketingEmails(lead: LeadProfile): boolean {
  return lead.formResponses.some(
    (r) => MARKETING_EMAIL_QUESTION_PATTERN.test(r.question) && NEGATIVE_ANSWER_PATTERN.test(r.answer.trim()),
  );
}

/** A lead an agent has explicitly tagged safe — bypasses every other check below. */
export function shouldBypassCompliance(leadProfile: LeadProfile): boolean {
  return leadProfile.tags.some((tag) => tag.trim().toUpperCase() === COMPLIANCE_BYPASS_TAG);
}

/**
 * Detects an inbound SMS opt-out reply. Pure detection only — actually
 * tagging the lead DNC in Lofty requires the inbound-SMS webhook handler,
 * which is part of the not-yet-built Event Listener.
 */
export function detectSmsOptOut(messageBody: string): boolean {
  return /^\s*stop\s*$/i.test(messageBody);
}

/**
 * Detects an email-unsubscribe event from Lofty. Pure detection only — see
 * detectSmsOptOut() note above; writing the DNC tag back happens in the
 * Event Listener, not here.
 */
export function detectEmailUnsubscribe(eventType: string): boolean {
  return /unsubscribe/i.test(eventType);
}

export function logComplianceSkip(leadProfile: LeadProfile, violations: string[]): void {
  console.log(`[compliance] Skipping outreach to leadId=${leadProfile.leadId}: ${violations.join('; ')}`);
}

export function logOptOut(leadId: string, channel: 'sms' | 'email', trigger: string): void {
  console.log(`[compliance] Opt-out detected for leadId=${leadId} via ${channel} ("${trigger}") — DNC tag applied.`);
}

// ---------------------------------------------------------------------------
// checkHardViolations / checkTimingViolations
//
// Split deliberately: a hard violation means "don't contact this lead at
// all" (DNC, has an agent, blocked) — those leads get skipped outright. A
// timing violation means "don't contact *right now*" (frequency caps) — the
// lead is still contactable, just not yet, so it stays scheduled with a
// future sendAfter instead of being dropped from the list.
// ---------------------------------------------------------------------------

/**
 * Returns every reason outreach to this lead should never happen — DNC,
 * has a buyer/listing agent, under contract with someone else, assigned to
 * another agent, or manually blocked. Empty array means none of these
 * apply (the lead may still be timing-blocked — see checkTimingViolations).
 */
export function checkHardViolations(
  leadProfile: LeadProfile,
  // lastOutreach/status aren't used by hard checks — kept for a consistent
  // call signature alongside checkTimingViolations.
  _lastOutreach: OutreachHistory,
  _status: LeadStatusForCadence = 'unknown',
): string[] {
  if (shouldBypassCompliance(leadProfile)) return [];

  const violations: string[] = [];

  // Do Not Contact -----------------------------------------------------
  if (hasDncSignal(leadProfile)) {
    violations.push('DNC: tagged or noted do-not-contact');
  }
  if (declinedMarketingEmails(leadProfile)) {
    violations.push('DNC: declined marketing emails on intake form');
  }

  // Lead state validation -----------------------------------------------
  if (leadProfile.withBuyerAgent === 'Yes') {
    violations.push('Lead state: has buyer agent');
  }
  if (leadProfile.withListingAgent === 'Yes') {
    violations.push('Lead state: has listing agent');
  }
  const otherAgent = findOtherAgentName(leadProfile.formResponses);
  if (otherAgent) {
    violations.push(`Lead state: under contract with ${otherAgent}`);
  }
  if (leadProfile.assignedUser !== null && leadProfile.assignedUser !== OWN_AGENT_NAME) {
    violations.push('Lead state: assigned to another agent');
  }
  if (hasTagMatching(leadProfile.tags, BLOCKED_TAG_PATTERN) || hasNoteMatching(leadProfile.formResponses, BLOCKED_TAG_PATTERN)) {
    violations.push('Lead state: manually blocked in Lofty');
  }

  return violations;
}

/**
 * Returns every reason outreach to this lead is blocked *right now* —
 * frequency caps and the 24h blanket cooldown. Empty array means clear to
 * send immediately; a non-empty array doesn't mean skip, it means
 * getNextValidSendTime() will return a future time instead of now.
 * `status` is optional — when the caller doesn't have a qualification
 * result handy, the stricter 7-day warm SMS cap is assumed.
 */
export function checkTimingViolations(
  leadProfile: LeadProfile,
  lastOutreach: OutreachHistory,
  status: LeadStatusForCadence = 'unknown',
): string[] {
  if (shouldBypassCompliance(leadProfile)) return [];

  const violations: string[] = [];
  const now = Date.now();
  const lastTimestamps = [lastOutreach.lastSmsAt, lastOutreach.lastEmailAt]
    .filter((t): t is string => t !== null)
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t));

  if (lastTimestamps.length) {
    const hoursSinceLastMessage = (now - Math.max(...lastTimestamps)) / (1000 * 60 * 60);
    if (hoursSinceLastMessage < BLANKET_COOLDOWN_HOURS) {
      violations.push(`Frequency cap: previous message sent ${hoursSinceLastMessage.toFixed(1)}h ago (24h cooldown)`);
    }
  }

  if (lastOutreach.lastSmsAt) {
    const capDays = status === 'hot' ? SMS_HOT_CAP_DAYS : SMS_WARM_CAP_DAYS;
    const daysSinceLastSms = (now - new Date(lastOutreach.lastSmsAt).getTime()) / ONE_DAY_MS;
    if (daysSinceLastSms < capDays) {
      violations.push(`Frequency cap: SMS sent ${daysSinceLastSms.toFixed(1)}d ago, cap is ${capDays}d for ${status} leads`);
    }
  }

  if (lastOutreach.lastEmailAt) {
    const daysSinceLastEmail = (now - new Date(lastOutreach.lastEmailAt).getTime()) / ONE_DAY_MS;
    if (daysSinceLastEmail < EMAIL_CAP_DAYS) {
      violations.push(`Frequency cap: email sent ${daysSinceLastEmail.toFixed(1)}d ago, cap is ${EMAIL_CAP_DAYS}d`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// getNextValidSendTime
// ---------------------------------------------------------------------------

function getEtParts(date: Date): { year: number; month: number; day: number; hour: number; weekday: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    weekday: map.weekday ?? '',
  };
}

function getEtUtcOffsetMinutes(date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TIMEZONE, timeZoneName: 'shortOffset' });
  const offsetPart = formatter.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = offsetPart.match(/GMT([+-]\d+)(?::?(\d+))?/);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

function etWallClockToUtc(year: number, month: number, day: number, hour: number, minute: number, offsetReference: Date): Date {
  const offsetMinutes = getEtUtcOffsetMinutes(offsetReference);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60000);
}

function isWithinSmsBusinessHours(date: Date): boolean {
  const parts = getEtParts(date);
  return BUSINESS_WEEKDAYS.has(parts.weekday) && parts.hour >= SMS_WINDOW_START_HOUR && parts.hour < SMS_WINDOW_END_HOUR;
}

/** If `after` is outside the SMS business-hours window, pushes to 9am ET the next business day. */
function nextSmsBusinessWindowStart(after: Date): Date {
  if (isWithinSmsBusinessHours(after)) return after;

  const parts = getEtParts(after);
  let candidateNoonUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0));
  let candidateParts = getEtParts(candidateNoonUtc);

  while (!BUSINESS_WEEKDAYS.has(candidateParts.weekday)) {
    candidateNoonUtc = new Date(Date.UTC(candidateParts.year, candidateParts.month - 1, candidateParts.day + 1, 12, 0, 0));
    candidateParts = getEtParts(candidateNoonUtc);
  }

  return etWallClockToUtc(candidateParts.year, candidateParts.month, candidateParts.day, QUEUED_SEND_HOUR, 0, candidateNoonUtc);
}

/**
 * Earliest time it's safe to send `type` to this lead, accounting for
 * frequency caps, the 24h blanket cooldown, and (for SMS) business hours.
 * `lastOutreach`/`status` are optional so the call matches the literal
 * (leadProfile, type) signature when the caller has no history yet.
 */
export function getNextValidSendTime(
  leadProfile: LeadProfile,
  type: 'sms' | 'email',
  lastOutreach: OutreachHistory = { lastSmsAt: null, lastEmailAt: null },
  status: LeadStatusForCadence = 'unknown',
): Date {
  if (type === 'sms' && !leadProfile.phone) {
    return MAX_DATE;
  }

  const candidates: number[] = [Date.now()];

  const lastTimestamps = [lastOutreach.lastSmsAt, lastOutreach.lastEmailAt]
    .filter((t): t is string => t !== null)
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t));
  if (lastTimestamps.length) {
    candidates.push(Math.max(...lastTimestamps) + BLANKET_COOLDOWN_HOURS * 60 * 60 * 1000);
  }

  if (type === 'sms' && lastOutreach.lastSmsAt) {
    const capDays = status === 'hot' ? SMS_HOT_CAP_DAYS : SMS_WARM_CAP_DAYS;
    candidates.push(new Date(lastOutreach.lastSmsAt).getTime() + capDays * ONE_DAY_MS);
  }
  if (type === 'email' && lastOutreach.lastEmailAt) {
    candidates.push(new Date(lastOutreach.lastEmailAt).getTime() + EMAIL_CAP_DAYS * ONE_DAY_MS);
  }

  const earliestByFrequency = new Date(Math.max(...candidates));

  return type === 'sms' ? nextSmsBusinessWindowStart(earliestByFrequency) : earliestByFrequency;
}
