import { detectSmsOptOut, detectEmailUnsubscribe, logOptOut } from '../config/compliance';
import { updateLeadState, addTag } from '../engines/stateEngine';

const SMS_RECEIVED_PATTERN = /sms.*(received|reply|inbound)/i;
const EMAIL_UNSUBSCRIBE_PATTERN = /email.*unsubscribe/i;
const LOW_PRIORITY_EVENT_PATTERN = /call|note|stage/i;
const DNC_TAG = 'DNC';

function extractLeadId(payload: any): string | null {
  const leadId = payload?.leadId ?? payload?.lead?.leadId ?? payload?.message?.leadId ?? payload?.updatedLead?.[0]?.leadId;
  if (leadId === undefined || leadId === null) {
    // Log payload structure for debugging instead of throwing
    console.warn('[event] Unable to extract leadId. Payload keys:', Object.keys(payload || {}));
    console.warn('[event] Full payload (first 500 chars):', JSON.stringify(payload).slice(0, 500));
    return null;
  }
  return String(leadId);
}

function extractMessageBody(payload: any): string {
  return payload?.messageBody ?? payload?.message?.body ?? payload?.body ?? '';
}

async function handleOptOut(leadId: string, channel: 'sms' | 'email', trigger: string): Promise<void> {
  await updateLeadState(leadId, 'ghost');
  await addTag(leadId, DNC_TAG);
  logOptOut(leadId, channel, trigger);
}

export async function handleLoftyEvent(payload: any): Promise<{ status: string; leadId?: string }> {
  const eventType: string = payload?.eventType ?? 'unknown';
  let leadId: string | null = null;

  try {
    leadId = extractLeadId(payload);

    // If we can't extract leadId, return unroutable (don't throw, so Lofty stops retrying)
    if (!leadId) {
      console.log(`[event] eventType=${eventType} — unroutable (no leadId found)`);
      return { status: 'unroutable' };
    }

    if (SMS_RECEIVED_PATTERN.test(eventType)) {
      const messageBody = extractMessageBody(payload);
      if (detectSmsOptOut(messageBody)) {
        await handleOptOut(leadId, 'sms', messageBody);
        console.log(`[event] leadId=${leadId} eventType=${eventType} opt-out detected — tagged ghost + DNC`);
      } else {
        console.log(`[event] leadId=${leadId} eventType=${eventType} no action needed`);
      }
      return { status: 'processed', leadId };
    }

    if (EMAIL_UNSUBSCRIBE_PATTERN.test(eventType)) {
      if (detectEmailUnsubscribe(eventType)) {
        await handleOptOut(leadId, 'email', eventType);
        console.log(`[event] leadId=${leadId} eventType=${eventType} opt-out detected — tagged ghost + DNC`);
      } else {
        console.log(`[event] leadId=${leadId} eventType=${eventType} no action needed`);
      }
      return { status: 'processed', leadId };
    }

    if (LOW_PRIORITY_EVENT_PATTERN.test(eventType)) {
      console.log(`[event] leadId=${leadId} eventType=${eventType} logged, cadence rebuild not yet wired`);
      return { status: 'logged', leadId };
    }

    console.log(`[event] leadId=${leadId} eventType=${eventType} unrecognized — no action taken`);
    return { status: 'unrecognized', leadId };
  } catch (error) {
    console.error(`[event] leadId=${leadId ?? 'unknown'} eventType=${eventType} FAILED`, error);
    throw error;
  }
}
