import { getLeadState, recordOutreach, updateLeadState, clearDailyContactMarker } from '../src/engines/stateEngine';

const leadId = 'mock-lead-1';
let mockTags: string[] = ['Website Lead', 'High Intent'];

process.env.LOFTY_API_KEY = 'mock-key';

(globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  if (init?.method === 'PUT') {
    const body = JSON.parse(init.body ?? '{}') as { tags: string[] };
    mockTags = body.tags;
    return { ok: true, json: async () => ({}) };
  }
  return { ok: true, json: async () => ({ lead: { tags: mockTags.map((t) => ({ tagName: t })) } }) };
};

async function main() {
  console.log('Initial tags:', mockTags);

  console.log('\n1. getLeadState (no Vern tags yet) ->', await getLeadState(leadId));

  await updateLeadState(leadId, 'hot');
  console.log('\n2. After updateLeadState("hot"), tags:', mockTags);
  console.log('   getLeadState ->', await getLeadState(leadId));

  await updateLeadState(leadId, 'warm');
  console.log('\n3. After updateLeadState("warm") — replaced, not accumulated, tags:', mockTags);

  await recordOutreach(leadId, 'sms');
  console.log('\n4. After recordOutreach("sms") once, tags:', mockTags);

  await recordOutreach(leadId, 'sms');
  const smsTagCount = mockTags.filter((t) => t.startsWith('VERN-LAST-SMS:')).length;
  console.log('\n5. After recordOutreach("sms") again — idempotency check, tags:', mockTags);
  console.log(`   VERN-LAST-SMS tag count: ${smsTagCount} (expect 1)`);

  await recordOutreach(leadId, 'email');
  console.log('\n6. After recordOutreach("email"), tags:', mockTags);

  console.log('\n7. getLeadState ->', await getLeadState(leadId));

  await clearDailyContactMarker(leadId);
  console.log('\n8. After clearDailyContactMarker, tags:', mockTags);
  console.log('   Still has VERN-CONTACTED-TODAY:', mockTags.includes('VERN-CONTACTED-TODAY'), '(expect false)');
  console.log(
    '   Original CRM tags preserved:',
    mockTags.includes('Website Lead') && mockTags.includes('High Intent'),
    '(expect true)',
  );
}

main();
