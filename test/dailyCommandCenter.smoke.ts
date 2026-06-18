import { generateDailyCommandCenter } from '../src/engines/dailyCommandCenter';

const ONE_DAY_MS = 1000 * 60 * 60 * 24;
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * ONE_DAY_MS).toISOString();
}

process.env.LOFTY_API_KEY = 'mock-key';

interface MockLead {
  raw: Record<string, unknown>;
  notes: Array<{ content: string; createTime: string }>;
  tags: string[];
}

const leads = new Map<string, MockLead>();
function addLead(leadId: string, raw: Record<string, unknown>, opts: { notes?: MockLead['notes']; tags?: string[] } = {}) {
  leads.set(leadId, { raw: { leadId, ...raw }, notes: opts.notes ?? [], tags: opts.tags ?? [] });
}

// Prospect: hot, never texted, top score
addLead(
  'P1',
  {
    source: 'Website',
    firstName: 'Prospect',
    phone: '555-0123',
    leadTypes: [2],
    buyingTimeFrame: '1-3',
    preQual: 'Yes',
    houseToSell: 'No',
    assignedUser: 'Navjot Singh',
    leadPropertyList: [{ streetAddress: '25 Sunview Drive', price: 299000, listingId: 'CT1' }],
    createTime: daysAgoIso(20),
    lastUpdateTime: daysAgoIso(1),
  },
  { notes: [{ content: 'Viewed listing', createTime: daysAgoIso(1) }] },
);

// Bob: hot-qualifying but already texted 1 day ago -> frequency-cap delay
addLead(
  'P2',
  {
    source: 'Website',
    firstName: 'Bob Li',
    phone: '555-0199',
    leadTypes: [2],
    buyingTimeFrame: '1-3',
    preQual: 'Yes',
    houseToSell: 'No',
    assignedUser: 'Navjot Singh',
    createTime: daysAgoIso(20),
    lastUpdateTime: daysAgoIso(2),
  },
  { tags: [`VERN-LAST-SMS:${daysAgoIso(2)}`] },
);

// W1, W2: warm leads still queued (1 intake field, no engagement)
for (const id of ['W1', 'W2']) {
  addLead(id, {
    source: 'Website',
    firstName: `Warm-${id}`,
    phone: '555-0200',
    leadTypes: [2],
    buyingTimeFrame: '1-3',
    assignedUser: 'Navjot Singh',
    createTime: daysAgoIso(10),
    lastUpdateTime: daysAgoIso(2),
  });
}

// W3: warm lead already emailed today -> frequency-cap skip, counts toward "emailed today"
addLead(
  'W3',
  {
    source: 'Website',
    firstName: 'Warm-W3',
    phone: '555-0201',
    leadTypes: [2],
    buyingTimeFrame: '1-3',
    assignedUser: 'Navjot Singh',
    createTime: daysAgoIso(10),
    lastUpdateTime: daysAgoIso(2),
  },
  { tags: [`VERN-LAST-EMAIL:${daysAgoIso(0.1)}`] },
);

// G1: ghost, queued for reactivation
addLead('G1', {
  source: 'Website',
  firstName: 'Ghost-G1',
  phone: '555-0300',
  leadTypes: [2],
  assignedUser: 'Navjot Singh',
  createTime: daysAgoIso(200),
  lastUpdateTime: daysAgoIso(200),
});

// D1: DNC -> skipped
addLead('D1', { source: 'Website', firstName: 'Dnc-D1', phone: '555-0400', leadTypes: [2], assignedUser: 'Navjot Singh' }, { tags: ['DNC'] });

(globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const pathMatch = url.match(/leads\/([^/?]+)/);
  const queryMatch = url.match(/leadId=([^&]+)/);
  const leadId = pathMatch ? pathMatch[1] : queryMatch ? queryMatch[1] : null;
  const lead = leadId ? leads.get(leadId) : undefined;

  if (init?.method === 'POST' && url.endsWith('/tags') && lead) {
    const body = JSON.parse(init.body ?? '{}') as { tags: string[] };
    lead.tags = body.tags;
    return { ok: true, json: async () => ({}) };
  }

  if (!lead) return { ok: true, json: async () => ({}) };

  if (url.includes('/notes')) return { ok: true, json: async () => ({ notes: lead.notes }) };
  if (url.includes('/communication/call-history')) return { ok: true, json: async () => ({ callHistory: [] }) };
  if (url.includes('/communication/email')) return { ok: true, json: async () => ({ emails: [] }) };
  if (url.includes('/activities')) return { ok: true, json: async () => ({ activities: [] }) };

  return { ok: true, json: async () => ({ lead: { ...lead.raw, tags: lead.tags.map((t) => ({ tagName: t })) } }) };
};

async function main() {
  const report = await generateDailyCommandCenter(['P1', 'P2', 'W1', 'W2', 'W3', 'G1', 'D1']);
  console.log(report);
}

main();
