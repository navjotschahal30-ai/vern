import { qualifyLead, LeadQualification } from '../src/engines/qualificationEngine';
import { LeadProfile, TouchEvent, LeadEngagement } from '../src/schemas/leadProfile';
import navjotLeadFixture from './fixtures/navjotLead.json';

type Expectation = [string, boolean];

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const ENGAGEMENT_WINDOW_DAYS = 60;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

function buildEngagement(touchHistory: TouchEvent[]): LeadEngagement {
  let lastHumanTouchAt: string | null = null;
  let lastAnyTouchAt: string | null = null;
  let touchCountLast60Days = 0;
  let humanTouchCountLast60Days = 0;
  const now = Date.now();

  for (const event of touchHistory) {
    const t = new Date(event.timestamp).getTime();
    if (Number.isNaN(t)) continue;
    if (lastAnyTouchAt === null || t > new Date(lastAnyTouchAt).getTime()) lastAnyTouchAt = event.timestamp;
    if (event.isHuman && (lastHumanTouchAt === null || t > new Date(lastHumanTouchAt).getTime())) {
      lastHumanTouchAt = event.timestamp;
    }
    if ((now - t) / MS_PER_DAY <= ENGAGEMENT_WINDOW_DAYS) {
      touchCountLast60Days += 1;
      if (event.isHuman) humanTouchCountLast60Days += 1;
    }
  }

  return { lastHumanTouchAt, lastAnyTouchAt, touchCountLast60Days, humanTouchCountLast60Days };
}

let anyFailed = false;

function report(label: string, qualification: LeadQualification, expectations: Expectation[]): void {
  console.log(`\n=== ${label} ===`);
  console.log('Qualification:', JSON.stringify(qualification, null, 2));
  console.log(`Decision reasoning: ${qualification.reason}`);
  const failed = expectations.filter(([, pass]) => !pass);
  if (failed.length) {
    anyFailed = true;
    console.log(`RESULT: FAIL — ${failed.map(([name]) => name).join(', ')}`);
  } else {
    console.log('RESULT: PASS');
  }
}

function makeMockLead(overrides: Partial<LeadProfile> = {}): LeadProfile {
  const touchHistory = overrides.touchHistory ?? [{ type: 'note', timestamp: daysAgoIso(2), isHuman: true }];
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
    propertiesViewed: [{ address: '1 Mock St', price: 300000, mls: 'MOCK1' }],
    inquiredProperties: { priceMin: 200000, priceMax: 400000, bedroomsMin: 3, propertyTypes: ['Single Family'] },
    formResponses: [],
    touchHistory,
    engagement: buildEngagement(touchHistory),
    capturedAt: daysAgoIso(20),
    lastUpdatedAt: daysAgoIso(2),
    openTasks: [],
    upcomingAppointments: [],
    stageHistory: [],
    ...overrides,
  };
}

console.log('############################################################');
console.log('# 1. Navjot lead (leadId 1147598340391757)');
console.log('# Mocked with realistic Navjot lead structure, not fetched from Lofty API');
console.log('############################################################');

const navjotLead = navjotLeadFixture as LeadProfile;
console.log('LeadProfile:', JSON.stringify(navjotLead, null, 2));

report('1. Navjot lead (1147598340391757)', qualifyLead(navjotLead), [
  ['status === hot', qualifyLead(navjotLead).status === 'hot'],
  ['shouldContact === true', qualifyLead(navjotLead).shouldContact === true],
  ['nextAction === sms', qualifyLead(navjotLead).nextAction === 'sms'],
]);

console.log('\n############################################################');
console.log('# 2. Re-validated + new edge case tests (crm-agent thresholds)');
console.log('############################################################');

const dncLead = makeMockLead({ tags: ['DNC'] });
report('2. DNC lead', qualifyLead(dncLead), [
  ['shouldContact === false', qualifyLead(dncLead).shouldContact === false],
  ['reason includes "DNC"', qualifyLead(dncLead).reason.includes('DNC')],
]);

const buyerAgentLead = makeMockLead({ withBuyerAgent: 'Yes' });
report('3. Lead with buyer agent', qualifyLead(buyerAgentLead), [
  ['shouldContact === false', qualifyLead(buyerAgentLead).shouldContact === false],
  ['reason === "Has buyer agent"', qualifyLead(buyerAgentLead).reason === 'Has buyer agent'],
]);

const underContractLead = makeMockLead({
  formResponses: [
    { question: 'What is the name of the agent you are under contract with?', answer: 'George Dmitrovic' },
  ],
});
report('4. Under contract with another agent', qualifyLead(underContractLead), [
  ['shouldContact === false', qualifyLead(underContractLead).shouldContact === false],
  [
    'reason === "Under contract with George Dmitrovic"',
    qualifyLead(underContractLead).reason === 'Under contract with George Dmitrovic',
  ],
]);

const assignedToOtherLead = makeMockLead({ assignedUser: 'Jane Doe' });
report('5. Assigned to another agent', qualifyLead(assignedToOtherLead), [
  ['shouldContact === false', qualifyLead(assignedToOtherLead).shouldContact === false],
  ['reason === "Assigned to another agent"', qualifyLead(assignedToOtherLead).reason === 'Assigned to another agent'],
]);

// Old engine treated 35 days untouched as ghost (30-day threshold). Under
// crm-agent's 180-day ghost threshold this is no longer a ghost — it still
// qualifies hot off intake completeness, demonstrating the threshold moved.
const formerGhostLead = makeMockLead({
  touchHistory: [{ type: 'note', timestamp: daysAgoIso(35), isHuman: true }],
  capturedAt: daysAgoIso(60),
});
report('6. Lead untouched 35 days (no longer ghost — threshold moved 30 -> 180 days)', qualifyLead(formerGhostLead), [
  ['status !== ghost', qualifyLead(formerGhostLead).status !== 'ghost'],
  ['status === hot', qualifyLead(formerGhostLead).status === 'hot'],
]);

const ghostLead = makeMockLead({
  touchHistory: [],
  capturedAt: daysAgoIso(200),
  lastUpdatedAt: daysAgoIso(200),
});
report('7. NEW — Ghost: 180+ days, no human touch', qualifyLead(ghostLead), [
  ['status === ghost', qualifyLead(ghostLead).status === 'ghost'],
  ['shouldContact === true', qualifyLead(ghostLead).shouldContact === true],
]);

const winBackLead = makeMockLead({
  touchHistory: [{ type: 'call', timestamp: daysAgoIso(45), isHuman: true }],
});
report('8. NEW — Hot win-back: 30-90 days + human touch history', qualifyLead(winBackLead), [
  ['status === hot', qualifyLead(winBackLead).status === 'hot'],
  ['shouldContact === true', qualifyLead(winBackLead).shouldContact === true],
  ['reason starts with "Win-back:"', qualifyLead(winBackLead).reason.startsWith('Win-back:')],
]);

const warmOnlyLead = makeMockLead({
  buyingTimeframe: '1-3',
  sellingTimeframe: null,
  preApproved: null,
  hasHouseToSell: null,
  inquiredProperties: null,
  touchHistory: [],
});
report('9. NEW — Warm: 1 intake field answered, no engagement', qualifyLead(warmOnlyLead), [
  ['status === warm', qualifyLead(warmOnlyLead).status === 'warm'],
  ['shouldContact === true', qualifyLead(warmOnlyLead).shouldContact === true],
]);

console.log('\n############################################################');
console.log(anyFailed ? '# SOME TESTS FAILED' : '# ALL TESTS PASSED');
console.log('############################################################');

if (anyFailed) process.exit(1);
