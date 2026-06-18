import { LeadProfile } from '../schemas/leadProfile';
import { LeadQualification } from '../engines/qualificationEngine';
import { SMS_TEMPLATES, selectTemplateKey, TemplateVars } from '../config/templates';

export interface SendSmsResult {
  sent: true;
  messageId: string;
  timestamp: string;
}

function buildTemplateVars(leadProfile: LeadProfile): TemplateVars {
  return {
    firstName: leadProfile.firstName ?? 'there',
    property: leadProfile.propertiesViewed?.[0]?.address,
    city: leadProfile.currentHomeAddress?.city || undefined,
  };
}

/**
 * Sends a personalized SMS for a lead via the Lofty messaging API.
 */
export async function sendSMS(leadProfile: LeadProfile, qualification: LeadQualification): Promise<SendSmsResult> {
  const vars = buildTemplateVars(leadProfile);
  const templateKey = selectTemplateKey(leadProfile, qualification);
  const content = SMS_TEMPLATES[templateKey](vars);

  try {
    const response = await fetch('https://api.lofty.com/v1.0/message/sms/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LOFTY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ leadId: leadProfile.leadId, content }),
    });

    if (!response.ok) {
      throw new Error(`Lofty SMS send failed with status ${response.status}`);
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
