import { handleLoftyEvent } from '../src/handlers/eventListener';

process.env.LOFTY_API_KEY = 'mock-key';

const tagsByLead = new Map<string, string[]>([
  ['L1', ['Website Lead']],
  ['L2', ['Website Lead']],
  ['L3', ['Website Lead']],
]);

(globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const leadIdMatch = url.match(/leads\/([^/?]+)/);
  const leadId = leadIdMatch ? leadIdMatch[1] : null;
  if (!leadId) return { ok: true, json: async () => ({}) };

  if (init?.method === 'POST' && url.endsWith('/tags')) {
    const body = JSON.parse(init.body ?? '{}') as { tags: string[] };
    tagsByLead.set(leadId, body.tags);
    return { ok: true, json: async () => ({}) };
  }

  const tags = tagsByLead.get(leadId) ?? [];
  return { ok: true, json: async () => ({ lead: { tags: tags.map((t) => ({ tagName: t })) } }) };
};

async function main() {
  console.log('=== Case 1: SMS "STOP" -> expect DNC tag added, ghost state, opt-out logged ===');
  await handleLoftyEvent({ eventType: 'sms.received', leadId: 'L1', messageBody: 'STOP' });
  console.log('L1 tags after:', tagsByLead.get('L1'));
  console.log('Has DNC:', tagsByLead.get('L1')?.includes('DNC'), '(expect true)');
  console.log('Has VERN-STATE:ghost:', tagsByLead.get('L1')?.includes('VERN-STATE:ghost'), '(expect true)');

  console.log('\n=== Case 2: SMS "interested" -> expect no action ===');
  await handleLoftyEvent({ eventType: 'sms.received', leadId: 'L2', messageBody: 'interested, tell me more' });
  console.log('L2 tags after:', tagsByLead.get('L2'));
  console.log('Has DNC:', tagsByLead.get('L2')?.includes('DNC'), '(expect false)');

  console.log('\n=== Case 3: Email unsubscribe -> expect DNC tag added, ghost state, opt-out logged ===');
  await handleLoftyEvent({ eventType: 'email.unsubscribe', leadId: 'L3' });
  console.log('L3 tags after:', tagsByLead.get('L3'));
  console.log('Has DNC:', tagsByLead.get('L3')?.includes('DNC'), '(expect true)');
  console.log('Has VERN-STATE:ghost:', tagsByLead.get('L3')?.includes('VERN-STATE:ghost'), '(expect true)');

  console.log('\n=== Bonus: idempotency check — re-running case 1 should not duplicate DNC ===');
  await handleLoftyEvent({ eventType: 'sms.received', leadId: 'L1', messageBody: 'STOP' });
  const l1Tags = tagsByLead.get('L1') ?? [];
  const dncCount = l1Tags.filter((t) => t === 'DNC').length;
  console.log('L1 tags after re-run:', l1Tags);
  console.log(`DNC tag count: ${dncCount} (expect 1)`);
}

main();
