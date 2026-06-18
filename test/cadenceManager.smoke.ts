import { buildCadence } from '../src/engines/cadenceManager';

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

// A: hot, recently active, never texted by Vern -> should send SMS now-ish
addLead(
  'A',
  {
    source: 'Website',
    firstName: 'Alice',
    phones: ['555-0001'],
    leadTypes: [2],
    buyingTimeFrame: '1-3',
    preQual: 'Yes',
    houseToSell: 'No',
    assignedUser: 'Navjot Singh',
    createTime: daysAgoIso(20),
    lastUpdateTime: daysAgoIso(1),
  },
  { notes: [{ content: 'Called and left voicemail', createTime: daysAgoIso(1) }] },
);

// F: also hot-qualifying but lower score (touched 50 days ago, recency bucket is weaker)
addLead('F', {
  source: 'Website',
  firstName: 'Fred',
  phones: ['555-0006'],
  leadTypes: [2],
  buyingTimeFrame: '1-3',
  preQual: 'Yes',
  houseToSell: 'No',
  assignedUser: 'Navjot Singh',
  createTime: daysAgoIso(100),
  lastUpdateTime: daysAgoIso(50),
});

// B: warm — exactly 1 intake field, no engagement, never called
addLead('B', {
  source: 'Website',
  firstName: 'Bob',
  phones: ['555-0002'],
  leadTypes: [2],
  buyingTimeFrame: '1-3',
  assignedUser: 'Navjot Singh',
  createTime: daysAgoIso(10),
  lastUpdateTime: daysAgoIso(2),
});

// C: ghost — 200+ days in CRM, never a human touch
addLead('C', {
  source: 'Website',
  firstName: 'Carol',
  phones: ['555-0003'],
  leadTypes: [2],
  assignedUser: 'Navjot Singh',
  createTime: daysAgoIso(200),
  lastUpdateTime: daysAgoIso(200),
});

// D: DNC tag -> must be skipped entirely
addLead(
  'D',
  {
    source: 'Website',
    firstName: 'Dave',
    phones: ['555-0004'],
    leadTypes: [2],
    buyingTimeFrame: '1-3',
    preQual: 'Yes',
    assignedUser: 'Navjot Singh',
    createTime: daysAgoIso(20),
    lastUpdateTime: daysAgoIso(1),
  },
  { tags: ['DNC'] },
);

// E: hot-qualifying but Vern already texted 1 hour ago -> frequency cap + cooldown should skip it
addLead(
  'E',
  {
    source: 'Website',
    firstName: 'Eve',
    phones: ['555-0005'],
    leadTypes: [2],
    buyingTimeFrame: '1-3',
    preQual: 'Yes',
    houseToSell: 'No',
    assignedUser: 'Navjot Singh',
    createTime: daysAgoIso(20),
    lastUpdateTime: daysAgoIso(1),
  },
  { tags: [`VERN-LAST-SMS:${new Date(Date.now() - 60 * 60 * 1000).toISOString()}`] },
);

(globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const pathMatch = url.match(/leads\/([^/?]+)/);
  const queryMatch = url.match(/leadId=([^&]+)/);
  const leadId = pathMatch ? pathMatch[1] : queryMatch ? queryMatch[1] : null;

  // G: simulates a real network/API failure on the main lead fetch.
  if (leadId === 'G' && url.includes('/v1.0/leads/')) {
    throw new Error('Network timeout contacting Lofty');
  }

  const lead = leadId ? leads.get(leadId) : undefined;

  if (init?.method === 'PUT' && lead) {
    const body = JSON.parse(init.body ?? '{}') as { tags: string[] };
    lead.tags = body.tags;
    return { ok: true, json: async () => ({}) };
  }

  if (!lead) return { ok: true, json: async () => ({}) };

  if (url.includes('/notes')) return { ok: true, json: async () => ({ notes: lead.notes }) };
  if (url.includes('/communication/call')) return { ok: true, json: async () => ({ calls: [] }) };
  if (url.includes('/communication/email')) return { ok: true, json: async () => ({ emails: [] }) };
  if (url.includes('/communication/text')) return { ok: true, json: async () => ({ texts: [] }) };
  if (url.includes('/activities')) return { ok: true, json: async () => ({ activities: [] }) };

  // GET /v1.0/leads/{leadId} — used by both fetchLeadProfile and getLeadState
  return {
    ok: true,
    json: async () => ({ lead: { ...lead.raw, tags: lead.tags.map((t) => ({ tagName: t })) } }),
  };
};

async function main() {
  const result = await buildCadence(['A', 'F', 'B', 'C', 'D', 'E', 'G']);

  console.log('\n=== scheduled ===');
  for (const entry of result.scheduled) {
    console.log(`${entry.leadId}: channel=${entry.channel} sendAfter=${entry.sendAfter.toISOString()} reason="${entry.reason}"`);
  }
  console.log(
    '\nOrder:',
    result.scheduled.map((e) => e.leadId).join(', '),
    '(expect A, E, F, B, C — hot>warm>ghost, score desc within hot; E is frequency-capped but still scheduled, delayed)',
  );

  console.log('\n=== skipped (expect D, G — E moved to scheduled since frequency caps are timing delays, not skips) ===');
  for (const entry of result.skipped) {
    console.log(`${entry.leadId}: ${entry.reason}`);
  }
}

main();
