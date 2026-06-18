import { LeadProfile } from '../schemas/leadProfile';
import { LeadQualification } from '../engines/qualificationEngine';
import { EMAIL_TEMPLATES, selectTemplateKey, TemplateVars } from '../config/templates';
import { getLoftyHeaders } from '../config/loftyClient';
import { isTestMode, navjotEmail } from '../config/testMode';

export interface SendEmailResult {
  sent: true;
  messageId: string;
  timestamp: string;
}

export interface SkippedEmailResult {
  sent: false;
  testMode: true;
}

// Matches the sign-off IDX Stalker already uses for Navjot's outbound email
// (core/message-generator.js), so Vern's outreach stays consistent with it.
const AGENT_SIGNATURE = '\n\n--\nNavjot Singh\nnavjotchahal.ca\n519-505-5832';

function buildTemplateVars(leadProfile: LeadProfile): TemplateVars {
  return {
    firstName: leadProfile.firstName ?? 'there',
    property: leadProfile.propertiesViewed?.[0]?.address,
    city: leadProfile.currentHomeAddress?.city || undefined,
  };
}

/**
 * Sends a personalized email for a lead via the Lofty messaging API.
 */
export async function sendEmail(
  leadProfile: LeadProfile,
  qualification: LeadQualification,
): Promise<SendEmailResult | SkippedEmailResult> {
  if (isTestMode() && leadProfile.email !== navjotEmail) {
    console.log(`[test] Skipping email to leadId=${leadProfile.leadId} (would send in production)`);
    return { sent: false, testMode: true };
  }

  const vars = buildTemplateVars(leadProfile);
  const templateKey = selectTemplateKey(leadProfile, qualification);
  const { subject, body } = EMAIL_TEMPLATES[templateKey](vars);
  const fullBody = `${body}${AGENT_SIGNATURE}`;

  try {
    const response = await fetch('https://api.lofty.com/v1.0/message/email/send', {
      method: 'POST',
      headers: getLoftyHeaders(),
      body: JSON.stringify({ leadId: leadProfile.leadId, subject, body: fullBody }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable body>');
      throw new Error(`Lofty email send failed with status ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = (await response.json()) as { messageId: string };

    return {
      sent: true,
      messageId: data.messageId,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`sendEmail failed for leadId=${leadProfile.leadId}`, error);
    throw error;
  }
}
