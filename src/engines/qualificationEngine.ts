import { LeadProfile, TouchEvent } from '../schemas/leadProfile';

export interface LeadQualification {
  status: 'hot' | 'warm' | 'ghost' | 'blocked';
  shouldContact: boolean;
  reason: string;
  nextAction: 'sms' | 'email' | 'call' | 'wait';
  nextContactWindow: number;
  personalizedMessage?: string;
  /** 0-100, for ranking within a status — does not affect hot/warm/ghost gating. */
  score: number;
}

// "Are we the right ones to contact this lead?" relies on Navjot being the
// single owner — any other agent name or assignee means someone else
// already has this relationship. Exported so compliance.ts enforces the
// exact same "is this lead off-limits" rules instead of a second copy.
export const OWN_AGENT_NAME = 'Navjot Singh';

// LeadProfile has no explicit "DNC" boolean — that signal only shows up as
// a free-text tag or note Q&A pair from Lofty, so we match on a pattern.
export const DNC_PATTERN = /\b(dnc|do[\s-]?not[\s-]?contact|do[\s-]?not[\s-]?call)\b/i;
export const BLOCKED_TAG_PATTERN = /\b(blocked|spam|opted[\s-]?out|unsubscribed)\b/i;
const AGENT_QUESTION_PATTERN = /agent|contract/i;
const NEGATIVE_ANSWER_PATTERN = /^(no|none|n\/a|na|not applicable|nope)$/i;

// Thresholds mirror navjot-crm-agent's qualifiesForHot/Warm/Ghost.
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const ENGAGEMENT_WINDOW_DAYS = 60;
const HOT_MAX_DAYS_SINCE_ENGAGEMENT = 90;
const GHOST_MIN_DAYS_NO_HUMAN_CONTACT = 180;
const WIN_BACK_MIN_DAYS = 30;
const WIN_BACK_MAX_DAYS = 90;

const BASE_CONTACT_WINDOW_HOURS: Record<Exclude<LeadQualification['status'], 'blocked'>, number> = {
  hot: 1,
  warm: 12,
  ghost: 72,
};

const SCORE_WEIGHTS = {
  ACTIVE_INTENT: 30,
  LAST_CONTACT_UNDER_7_DAYS: 25,
  LAST_CONTACT_7_TO_30_DAYS: 15,
  LAST_CONTACT_30_TO_90_DAYS: 5,
  REFERRAL_SOURCE: 20,
  HAS_PHONE: 10,
  HAS_LOGGED_NOTE: 5,
  UNKNOWN_INTENT_PENALTY: -10,
};

export function hasTagMatching(tags: string[], pattern: RegExp): boolean {
  return tags.some((tag) => pattern.test(tag));
}

export function hasNoteMatching(formResponses: LeadProfile['formResponses'], pattern: RegExp): boolean {
  return formResponses.some((r) => pattern.test(r.question) || pattern.test(r.answer));
}

/**
 * Looks for a formResponse answering an agent/contract question with an
 * actual agent name rather than a "No"/"None" style negative answer.
 */
export function findOtherAgentName(formResponses: LeadProfile['formResponses']): string | null {
  for (const r of formResponses) {
    if (!AGENT_QUESTION_PATTERN.test(r.question)) continue;
    const answer = r.answer.trim();
    if (!answer || NEGATIVE_ANSWER_PATTERN.test(answer)) continue;
    if (answer.toLowerCase() === OWN_AGENT_NAME.toLowerCase()) continue;
    return answer;
  }
  return null;
}

function daysSince(isoTimestamp: string | null): number | null {
  if (!isoTimestamp) return null;
  const then = new Date(isoTimestamp).getTime();
  if (Number.isNaN(then)) return null;
  return (Date.now() - then) / MS_PER_DAY;
}

function hasValidPhone(lead: LeadProfile): boolean {
  return !!lead.phone && lead.phone.trim().length > 0;
}

/** True only when every recorded touch is automated (no human touch at all). */
function isAutomatedOnlyActivity(lead: LeadProfile): boolean {
  return lead.touchHistory.length > 0 && lead.touchHistory.every((event) => !event.isHuman);
}

function hasRecentEventOfType(lead: LeadProfile, type: TouchEvent['type'], windowDays: number): boolean {
  return lead.touchHistory.some((event) => {
    if (event.type !== type) return false;
    const age = daysSince(event.timestamp);
    return age !== null && age <= windowDays;
  });
}

function hasPropertyView(lead: LeadProfile, windowDays: number): boolean {
  return hasRecentEventOfType(lead, 'property_view', windowDays);
}

function hasEmailEngagement(lead: LeadProfile, windowDays: number): boolean {
  return hasRecentEventOfType(lead, 'email_open', windowDays) || hasRecentEventOfType(lead, 'email_reply', windowDays);
}

function hasLoggedCallOrNote(lead: LeadProfile): boolean {
  return lead.touchHistory.some((event) => event.type === 'call' || event.type === 'note');
}

/** Proxy for crm-agent's "intake fields answered": structured fields Lofty captured directly, not free-text notes. */
function countIntakeFieldsAnswered(lead: LeadProfile): number {
  let count = 0;
  if (lead.buyingTimeframe !== null) count += 1;
  if (lead.sellingTimeframe !== null) count += 1;
  if (lead.preApproved !== null) count += 1;
  if (lead.hasHouseToSell !== null) count += 1;
  if (lead.inquiredProperties !== null) count += 1;
  return count;
}

function daysSinceLastHumanTouch(lead: LeadProfile): number | null {
  return daysSince(lead.engagement.lastHumanTouchAt);
}

function daysSinceLastActivity(lead: LeadProfile): number | null {
  const lastTouch = daysSince(lead.engagement.lastAnyTouchAt);
  const lastUpdated = daysSince(lead.lastUpdatedAt);
  if (lastTouch === null) return lastUpdated;
  if (lastUpdated === null) return lastTouch;
  return Math.min(lastTouch, lastUpdated);
}

interface Qualification {
  qualified: boolean;
  reason: string;
}

/** Mirrors navjot-crm-agent's qualifiesForHot(). */
function qualifiesForHot(lead: LeadProfile): Qualification {
  if (!hasValidPhone(lead)) {
    return { qualified: false, reason: 'Disqualifier: no phone on file' };
  }

  const daysSinceTouch = daysSinceLastHumanTouch(lead) ?? daysSinceLastActivity(lead);
  if (daysSinceTouch !== null && daysSinceTouch > HOT_MAX_DAYS_SINCE_ENGAGEMENT) {
    return { qualified: false, reason: `Disqualifier: ${Math.floor(daysSinceTouch)} days since last engagement` };
  }

  if (isAutomatedOnlyActivity(lead)) {
    return { qualified: false, reason: 'Disqualifier: automated activity only' };
  }

  const signals: string[] = [];
  if (countIntakeFieldsAnswered(lead) >= 2) signals.push('intake complete');
  if (hasPropertyView(lead, ENGAGEMENT_WINDOW_DAYS) || hasEmailEngagement(lead, ENGAGEMENT_WINDOW_DAYS)) {
    signals.push('recent listing/email engagement');
  }

  if (!signals.length) {
    return { qualified: false, reason: 'Disqualifier: no positive signal (intake or engagement)' };
  }

  return { qualified: true, reason: `Signal: ${signals[0]}` };
}

/** Mirrors navjot-crm-agent's qualifiesForWarm() — warm and cold are the same pool. */
function qualifiesForWarm(lead: LeadProfile): Qualification {
  if (!hasValidPhone(lead)) {
    return { qualified: false, reason: 'Disqualifier: no phone on file' };
  }
  if (isAutomatedOnlyActivity(lead)) {
    return { qualified: false, reason: 'Disqualifier: automated activity only' };
  }

  const signals: string[] = [];
  if (countIntakeFieldsAnswered(lead) >= 1) signals.push('partial intake');
  if (hasPropertyView(lead, ENGAGEMENT_WINDOW_DAYS) || hasEmailEngagement(lead, ENGAGEMENT_WINDOW_DAYS)) {
    signals.push('recent listing/email engagement');
  }
  if (!hasLoggedCallOrNote(lead)) signals.push('phone on file, never called');

  if (!signals.length) {
    return { qualified: false, reason: 'Disqualifier: no positive signal (intake, engagement, or uncalled phone)' };
  }

  return { qualified: true, reason: `Signal: ${signals[0]}` };
}

/** Mirrors navjot-crm-agent's qualifiesForGhost() — 180+ days since a real human touch. */
function qualifiesForGhost(lead: LeadProfile): Qualification {
  const daysSinceHuman = daysSinceLastHumanTouch(lead);
  if (daysSinceHuman !== null && daysSinceHuman < GHOST_MIN_DAYS_NO_HUMAN_CONTACT) {
    return { qualified: false, reason: `Disqualifier: ${Math.floor(daysSinceHuman)} days since real human contact` };
  }

  if (daysSinceHuman === null) {
    const daysInCrm = daysSince(lead.capturedAt);
    if (daysInCrm !== null && daysInCrm < GHOST_MIN_DAYS_NO_HUMAN_CONTACT) {
      return { qualified: false, reason: 'Disqualifier: no human contact but lead too new in CRM' };
    }
  }

  return { qualified: true, reason: `${GHOST_MIN_DAYS_NO_HUMAN_CONTACT}+ days since real human contact` };
}

/** Ranking-only score, 0-100. Never used to gate hot/warm/ghost status. */
function scoreLead(lead: LeadProfile): number {
  let score = 0;

  if (lead.leadIntent === 'buyer' || lead.leadIntent === 'seller') {
    score += SCORE_WEIGHTS.ACTIVE_INTENT;
  }

  const days = daysSinceLastActivity(lead);
  if (days !== null) {
    if (days < 7) score += SCORE_WEIGHTS.LAST_CONTACT_UNDER_7_DAYS;
    else if (days < 30) score += SCORE_WEIGHTS.LAST_CONTACT_7_TO_30_DAYS;
    else if (days < 90) score += SCORE_WEIGHTS.LAST_CONTACT_30_TO_90_DAYS;
  }

  if (lead.source.toLowerCase().includes('referral')) {
    score += SCORE_WEIGHTS.REFERRAL_SOURCE;
  }
  if (hasValidPhone(lead)) {
    score += SCORE_WEIGHTS.HAS_PHONE;
  }
  if (lead.touchHistory.some((event) => event.type === 'note')) {
    score += SCORE_WEIGHTS.HAS_LOGGED_NOTE;
  }
  if (lead.leadIntent === 'unknown') {
    score += SCORE_WEIGHTS.UNKNOWN_INTENT_PENALTY;
  }

  return Math.max(0, Math.min(100, score));
}

function contactWindowFor(status: Exclude<LeadQualification['status'], 'blocked'>, hoursSinceLastTouch: number): number {
  const base = BASE_CONTACT_WINDOW_HOURS[status];
  return Math.max(0, Math.round((base - hoursSinceLastTouch) * 10) / 10);
}

function blocked(reason: string): Omit<LeadQualification, 'score'> {
  return {
    status: 'blocked',
    shouldContact: false,
    reason,
    nextAction: 'wait',
    nextContactWindow: Infinity,
  };
}

/**
 * Determines how (and whether) Vern should follow up with a lead, based on
 * its normalized LeadProfile.
 */
export function qualifyLead(leadProfile: LeadProfile): LeadQualification {
  const { tags, formResponses, withBuyerAgent, withListingAgent, assignedUser, propertiesViewed } = leadProfile;
  const score = scoreLead(leadProfile);

  if (hasTagMatching(tags, DNC_PATTERN) || hasNoteMatching(formResponses, DNC_PATTERN)) {
    return { ...blocked('Lead is marked DNC (do-not-contact).'), score };
  }
  if (withBuyerAgent === 'Yes') {
    return { ...blocked('Has buyer agent'), score };
  }
  if (withListingAgent === 'Yes') {
    return { ...blocked('Has listing agent'), score };
  }
  const otherAgentName = findOtherAgentName(formResponses);
  if (otherAgentName) {
    return { ...blocked(`Under contract with ${otherAgentName}`), score };
  }
  if (assignedUser !== null && assignedUser !== OWN_AGENT_NAME) {
    return { ...blocked('Assigned to another agent'), score };
  }
  if (hasTagMatching(tags, BLOCKED_TAG_PATTERN) || hasNoteMatching(formResponses, BLOCKED_TAG_PATTERN)) {
    return { ...blocked('Lead is blocked/opted out.'), score };
  }

  const hoursSinceLastTouch = (daysSinceLastActivity(leadProfile) ?? Infinity) * 24;

  const greetingName = leadProfile.firstName ?? 'there';

  const ghost = qualifiesForGhost(leadProfile);
  if (ghost.qualified) {
    return {
      status: 'ghost',
      shouldContact: true,
      reason: ghost.reason,
      nextAction: 'email',
      nextContactWindow: contactWindowFor('ghost', hoursSinceLastTouch),
      personalizedMessage: `${greetingName}, a few new listings just came up that fit what you were after before. Want me to send them over?`,
      score,
    };
  }

  const hot = qualifiesForHot(leadProfile);
  if (hot.qualified) {
    const daysSinceHuman = daysSinceLastHumanTouch(leadProfile);
    const isWinBack = daysSinceHuman !== null && daysSinceHuman >= WIN_BACK_MIN_DAYS && daysSinceHuman <= WIN_BACK_MAX_DAYS;
    const property = propertiesViewed?.[0];
    return {
      status: 'hot',
      shouldContact: true,
      reason: isWinBack ? `Win-back: ${hot.reason}` : hot.reason,
      nextAction: 'sms',
      nextContactWindow: contactWindowFor('hot', hoursSinceLastTouch),
      personalizedMessage: property
        ? `${greetingName}, ${property.address} is priced right for what's moving right now. Want me to set up a walkthrough?`
        : `${greetingName}, inventory's moving fast right now and a few places fit exactly what you're after. Want first look?`,
      score,
    };
  }

  const warm = qualifiesForWarm(leadProfile);
  return {
    status: 'warm',
    shouldContact: warm.qualified,
    reason: warm.reason,
    nextAction: warm.qualified ? 'call' : 'wait',
    nextContactWindow: warm.qualified ? contactWindowFor('warm', hoursSinceLastTouch) : Infinity,
    score,
  };
}
