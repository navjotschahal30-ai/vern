import { LeadProfile } from '../schemas/leadProfile';
import { LeadQualification } from '../engines/qualificationEngine';
import { EMAIL_TEMPLATES, selectTemplateKey, TemplateVars } from '../config/templates';
import { MarketSnapshot } from '../schemas/marketSnapshot';
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

function buildTemplateVars(leadProfile: LeadProfile, marketData?: MarketSnapshot): TemplateVars {
  const viewed = leadProfile.propertiesViewed?.[0];
  return {
    firstName: leadProfile.firstName ?? 'there',
    property: viewed?.address,
    propertyListing: viewed ? { mls: viewed.mls, address: viewed.address, city: viewed.city, state: viewed.state } : undefined,
    city: leadProfile.currentHomeAddress?.city || undefined,
    marketData,
  };
}

/**
 * Sends a personalized email for a lead via the Lofty messaging API.
 */
export async function sendEmail(
  leadProfile: LeadProfile,
  qualification: LeadQualification,
  marketData?: MarketSnapshot,
): Promise<SendEmailResult | SkippedEmailResult> {
  if (isTestMode() && leadProfile.email !== navjotEmail) {
    console.log(`[test] Skipping email to leadId=${leadProfile.leadId} (would send in production)`);
    return { sent: false, testMode: true };
  }

  const vars = buildTemplateVars(leadProfile, marketData);
  const templateKey = selectTemplateKey(leadProfile, qualification);
  // body is already a complete branded HTML email (signature + CASL
  // footer + unsubscribe link included) — do not append anything after it.
  const { subject, body } = EMAIL_TEMPLATES[templateKey](vars);

  try {
    const response = await fetch('https://api.lofty.com/v1.0/message/email/send', {
      method: 'POST',
      headers: getLoftyHeaders(),
      body: JSON.stringify({ leadId: leadProfile.leadId, subject, content: body }),
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
