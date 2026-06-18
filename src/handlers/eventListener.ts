import { detectSmsOptOut, detectEmailUnsubscribe, logOptOut } from '../config/compliance';
import { updateLeadState, addTag } from '../engines/stateEngine';

// "or similar" per spec — Lofty's exact eventType strings aren't documented
// anywhere available, so these match loosely on intent rather than an
// exact string.
const SMS_RECEIVED_PATTERN = /sms.*(received|reply|inbound)/i;
const EMAIL_UNSUBSCRIBE_PATTERN = /email.*unsubscribe/i;
const LOW_PRIORITY_EVENT_PATTERN = /call|note|stage/i;

const DNC_TAG = 'DNC';

function extractLeadId(payload: any): string {
  const leadId = payload?.leadId ?? payload?.lead?.leadId ?? payload?.message?.leadId ?? payload?.updatedLead?.[0]?.leadId;

  if (leadId === undefined || leadId === null) {
    throw new Error('Unable to extract leadId from webhook payload');
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

/**
 * Single entry point for every Lofty webhook Vern subscribes to. Routes by
 * payload.eventType: SMS replies and email-unsubscribe events are checked
 * for opt-out and, if so, the lead is tagged ghost + DNC. Call/note/stage
 * events are logged only for now — cadence-rebuild-on-event is real work
 * for a later pass, not stubbed out here by accident.
 */
export async function handleLoftyEvent(payload: any): Promise<void> {
  const eventType: string = payload?.eventType ?? 'unknown';
  let leadId: string | null = null;

  try {
    leadId = extractLeadId(payload);

    if (SMS_RECEIVED_PATTERN.test(eventType)) {
      const messageBody = extractMessageBody(payload);

      if (detectSmsOptOut(messageBody)) {
        await handleOptOut(leadId, 'sms', messageBody);
        console.log(`[event] leadId=${leadId} eventType=${eventType} opt-out detected — tagged ghost + DNC`);
      } else {
        console.log(`[event] leadId=${leadId} eventType=${eventType} no action needed`);
      }
      return;
    }

    if (EMAIL_UNSUBSCRIBE_PATTERN.test(eventType)) {
      if (detectEmailUnsubscribe(eventType)) {
        await handleOptOut(leadId, 'email', eventType);
        console.log(`[event] leadId=${leadId} eventType=${eventType} opt-out detected — tagged ghost + DNC`);
      } else {
        console.log(`[event] leadId=${leadId} eventType=${eventType} no action needed`);
      }
      return;
    }

    if (LOW_PRIORITY_EVENT_PATTERN.test(eventType)) {
      // Stubbed: should trigger a cadence rebuild for this lead once the
      // job-scheduling layer exists. Logging only for now.
      console.log(`[event] leadId=${leadId} eventType=${eventType} logged, cadence rebuild not yet wired`);
      return;
    }

    console.log(`[event] leadId=${leadId} eventType=${eventType} unrecognized — no action taken`);
  } catch (error) {
    console.error(`[event] leadId=${leadId ?? 'unknown'} eventType=${eventType} FAILED`, error);
    throw error;
  }
}
