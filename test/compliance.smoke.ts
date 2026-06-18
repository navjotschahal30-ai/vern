import {
  shouldBypassCompliance,
  checkHardViolations,
  checkTimingViolations,
  getNextValidSendTime,
  detectSmsOptOut,
  detectEmailUnsubscribe,
} from '../src/config/compliance';
import { LeadProfile, TouchEvent, LeadEngagement } from '../src/schemas/leadProfile';

const ONE_DAY_MS = 1000 * 60 * 60 * 24;
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * ONE_DAY_MS).toISOString();
}

function buildEngagement(touchHistory: TouchEvent[]): LeadEngagement {
  const last = touchHistory[touchHistory.length - 1];
  return {
    lastHumanTouchAt: last?.isHuman ? last.timestamp : null,
    lastAnyTouchAt: last?.timestamp ?? null,
    touchCountLast60Days: touchHistory.length,
    humanTouchCountLast60Days: touchHistory.filter((e) => e.isHuman).length,
  };
}

function makeLead(overrides: Partial<LeadProfile> = {}): LeadProfile {
  const touchHistory = overrides.touchHistory ?? [];
  return {
    leadId: 'mock-lead',
    source: 'Website',
    firstName: 'Prospect',
    lastName: null,
    phone: '555-0100',
    utmData: {},
    tags: [],
    leadIntent: 'buyer',
    buyingTimeframe: '1-3',
    sellingTimeframe: null,
    preApproved: true,
    hasHouseToSell: false,
    withBuyerAgent: null,
    withListingAgent: null,
    assignedUser: 'Navjot Singh',
    currentHomeAddress: null,
    propertiesViewed: null,
    inquiredProperties: null,
    formResponses: [],
    touchHistory,
    engagement: buildEngagement(touchHistory),
    capturedAt: daysAgoIso(20),
    lastUpdatedAt: daysAgoIso(2),
    ...overrides,
  };
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// 1. DNC tag -> hard violation
section('1. DNC tag (hard violation)');
const dncLead = makeLead({ tags: ['DNC'] });
console.log(checkHardViolations(dncLead, { lastSmsAt: null, lastEmailAt: null }));

// 2. Declined marketing emails on intake form -> hard violation
section('2. Declined marketing emails on intake form (hard violation)');
const declinedLead = makeLead({
  formResponses: [{ question: 'Can we send you marketing emails?', answer: 'No' }],
});
console.log(checkHardViolations(declinedLead, { lastSmsAt: null, lastEmailAt: null }));

// 3. Under contract with another agent -> hard violation
section('3. Under contract with another agent (hard violation)');
const underContractLead = makeLead({
  formResponses: [{ question: 'Who is the agent you are under contract with?', answer: 'George Dmitrovic' }],
});
console.log(checkHardViolations(underContractLead, { lastSmsAt: null, lastEmailAt: null }));

// 4. SMS sent 12 hours ago to a hot lead -> timing violation (3-day hot cap AND 24h cooldown), not a hard one
section('4. Hot lead, SMS sent 12h ago (timing violation: 3d cap + 24h cooldown)');
const recentSmsHotLead = makeLead();
console.log('hard:', checkHardViolations(recentSmsHotLead, { lastSmsAt: daysAgoIso(0.5), lastEmailAt: null }, 'hot'));
console.log('timing:', checkTimingViolations(recentSmsHotLead, { lastSmsAt: daysAgoIso(0.5), lastEmailAt: null }, 'hot'));

// 5. SMS sent 4 days ago to a hot lead -> clears the 3-day hot cap
section('5. Hot lead, SMS sent 4 days ago (clears 3d hot cap)');
const olderSmsHotLead = makeLead();
console.log(checkTimingViolations(olderSmsHotLead, { lastSmsAt: daysAgoIso(4), lastEmailAt: null }, 'hot'));

// 6. Same 4-day-old SMS, but a warm lead -> still violates the 7-day warm cap
section('6. Warm lead, SMS sent 4 days ago (still violates 7d warm cap)');
console.log(checkTimingViolations(olderSmsHotLead, { lastSmsAt: daysAgoIso(4), lastEmailAt: null }, 'warm'));

// 7. COMPLIANCE-OVERRIDE tag bypasses everything, even an active DNC tag
section('7. COMPLIANCE-OVERRIDE tag bypasses all checks');
const overrideLead = makeLead({ tags: ['DNC', 'COMPLIANCE-OVERRIDE'] });
console.log('hard:', checkHardViolations(overrideLead, { lastSmsAt: daysAgoIso(0.1), lastEmailAt: null }, 'hot'));
console.log('timing:', checkTimingViolations(overrideLead, { lastSmsAt: daysAgoIso(0.1), lastEmailAt: null }, 'hot'));
console.log('shouldBypassCompliance:', shouldBypassCompliance(overrideLead));

// 8. getNextValidSendTime — clean lead, no history -> "now"
section('8. getNextValidSendTime — clean lead, no prior outreach');
const cleanLead = makeLead();
console.log('SMS:', getNextValidSendTime(cleanLead, 'sms').toISOString());
console.log('Email:', getNextValidSendTime(cleanLead, 'email').toISOString());

// 9. getNextValidSendTime — hot lead, SMS sent 1 day ago -> next valid time is 3d after that SMS
section('9. getNextValidSendTime — hot lead, SMS 1 day ago');
const lastSmsAt = daysAgoIso(1);
console.log(
  'Next SMS:',
  getNextValidSendTime(cleanLead, 'sms', { lastSmsAt, lastEmailAt: null }, 'hot').toISOString(),
);

// 10. getNextValidSendTime — no phone on file -> SMS never valid
section('10. getNextValidSendTime — SMS, no phone on file');
const noPhoneLead = makeLead({ phone: null });
console.log('SMS:', getNextValidSendTime(noPhoneLead, 'sms').toISOString());

// 11. Opt-out detection (pure — does not write the DNC tag, see compliance.ts comments)
section('11. Opt-out detection');
console.log('detectSmsOptOut("STOP"):', detectSmsOptOut('STOP'));
console.log('detectSmsOptOut("stop please"):', detectSmsOptOut('stop please'));
console.log('detectSmsOptOut("sounds good"):', detectSmsOptOut('sounds good'));
console.log('detectEmailUnsubscribe("email.unsubscribe"):', detectEmailUnsubscribe('email.unsubscribe'));
