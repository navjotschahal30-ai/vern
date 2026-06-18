import { qualifyLead } from '../src/engines/qualificationEngine';
import { LeadProfile } from '../src/schemas/leadProfile';

const norwichLead: LeadProfile = {
  leadId: '99812345',
  source: 'Website',
  firstName: 'Prospect',
  lastName: null,
  phone: '555-0199',
  utmData: { utm_source: 'google', utm_campaign: 'norwich-buyers' },
  tags: ['Website Lead', 'High Intent'],
  leadIntent: 'buyer',
  buyingTimeframe: '1-3',
  sellingTimeframe: null,
  preApproved: true,
  hasHouseToSell: false,
  withBuyerAgent: 'No',
  withListingAgent: 'No',
  assignedUser: 'Navjot Singh',
  currentHomeAddress: null,
  propertiesViewed: [
    { address: '14 Sachem St, Norwich, CT', price: 289000, mls: 'CT123456' },
  ],
  inquiredProperties: {
    priceMin: 250000,
    priceMax: 320000,
    bedroomsMin: 3,
    propertyTypes: ['Single Family'],
  },
  formResponses: [
    { question: 'Are you working with an agent?', answer: 'No' },
  ],
  touchHistory: [],
  engagement: {
    lastHumanTouchAt: null,
    lastAnyTouchAt: null,
    touchCountLast60Days: 0,
    humanTouchCountLast60Days: 0,
  },
  capturedAt: '2026-06-15T14:00:00.000Z',
  lastUpdatedAt: '2026-06-16T18:00:00.000Z',
};

const leadWithBuyerAgent: LeadProfile = {
  ...norwichLead,
  leadId: '99812346',
  withBuyerAgent: 'Yes',
};

const leadUnderContract: LeadProfile = {
  ...norwichLead,
  leadId: '99812347',
  withBuyerAgent: 'No',
  formResponses: [
    { question: 'Who is the agent you are under contract with?', answer: 'George Dmitrovic' },
  ],
};

const cases: Array<[string, LeadProfile, Array<[string, boolean]>]> = [
  [
    'Norwich lead (no agent, assigned to Navjot)',
    norwichLead,
    (() => {
      const result = qualifyLead(norwichLead);
      return [
        ['status === hot', result.status === 'hot'],
        ['shouldContact === true', result.shouldContact === true],
        ['nextAction === sms', result.nextAction === 'sms'],
      ];
    })(),
  ],
  [
    'Lead with withBuyerAgent: Yes',
    leadWithBuyerAgent,
    (() => {
      const result = qualifyLead(leadWithBuyerAgent);
      return [
        ['shouldContact === false', result.shouldContact === false],
        ['reason === "Has buyer agent"', result.reason === 'Has buyer agent'],
      ];
    })(),
  ],
  [
    'Lead with note mentioning George Dmitrovic',
    leadUnderContract,
    (() => {
      const result = qualifyLead(leadUnderContract);
      return [
        ['shouldContact === false', result.shouldContact === false],
        [
          'reason === "Under contract with George Dmitrovic"',
          result.reason === 'Under contract with George Dmitrovic',
        ],
      ];
    })(),
  ],
];

let anyFailed = false;
for (const [label, lead, expectations] of cases) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(qualifyLead(lead), null, 2));
  const failed = expectations.filter(([, pass]) => !pass);
  if (failed.length) {
    anyFailed = true;
    console.error('FAILED:', failed.map(([name]) => name));
  } else {
    console.log('All assertions passed.');
  }
}

if (anyFailed) process.exit(1);
