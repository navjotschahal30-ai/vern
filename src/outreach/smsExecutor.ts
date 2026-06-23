import { LeadProfile } from '../schemas/leadProfile';
import { LeadQualification } from '../engines/qualificationEngine';
import { SMS_TEMPLATES, selectTemplateKey, TemplateVars } from '../config/templates';
import { getLoftyHeaders } from '../config/loftyClient';
import { isTestMode, isNavjotPhone } from '../config/testMode';

export interface SendSmsResult {
  sent: true;
  messageId: string;
  timestamp: string;
}

export interface SkippedSmsResult {
  sent: false;
  testMode: true;
}

function buildTemplateVars(leadProfile: LeadProfile, marketData?: any): TemplateVars {
  return {
    firstName: leadProfile.firstName ?? 'there',
    property: leadProfile.propertiesViewed?.[0]?.address,
    city: leadProfile.currentHomeAddress?.city || undefined,
    marketData,
  };
}

/**
 * Sends a personalized SMS for a lead via the Lofty messaging API.
 */
export async function sendSMS(
  leadProfile: LeadProfile,
  qualification: LeadQualification,
  marketData?: any,
): Promise<SendSmsResult | SkippedSmsResult> {
  if (isTestMode() && !isNavjotPhone(leadProfile.phone)) {
    console.log(`[test] Skipping SMS to leadId=${leadProfile.leadId} (would send in production)`);
    return { sent: false, testMode: true };
  }

  const vars = buildTemplateVars(leadProfile, marketData);
  const templateKey = selectTemplateKey(leadProfile, qualification);
  const content = SMS_TEMPLATES[templateKey](vars);

  try {
    const response = await fetch('https://api.lofty.com/v1.0/message/sms/send', {
      method: 'POST',
      headers: getLoftyHeaders(),
      body: JSON.stringify({ leadId: leadProfile.leadId, content }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable body>');
      throw new Error(`Lofty SMS send failed with status ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = (await response.json()) as { messageId: string };

    return {
      sent: true,
      messageId: data.messageId,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`sendSMS failed for leadId=${leadProfile.leadId}`, error);
    throw error;
  }
}
