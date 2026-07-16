import { LeadProfile, resolveLeadAreaCity } from '../schemas/leadProfile';
import { LeadQualification } from '../engines/qualificationEngine';
import { EMAIL_TEMPLATES, selectTemplateKey, TemplateKey, TemplateVars } from '../config/templates';
import { MarketSnapshot } from '../schemas/marketSnapshot';
import { getLoftyHeaders } from '../config/loftyClient';
import { isTestMode, navjotEmail } from '../config/testMode';

// Every result carries what was actually rendered (subject/body/template),
// not just whether it sent — this is what lets a caller (cadenceManager,
// then the /cadence/daily job status endpoint) show a human what email a
// lead would have gotten, without going to Lofty's UI to check.
export interface SendEmailResult {
  sent: true;
  messageId: string;
  timestamp: string;
  templateKey: TemplateKey;
  subject: string;
  body: string;
}

export interface SkippedEmailResult {
  sent: false;
  testMode: true;
  templateKey: TemplateKey;
  subject: string;
  body: string;
}

function buildTemplateVars(leadProfile: LeadProfile, marketData?: MarketSnapshot): TemplateVars {
  const viewed = leadProfile.propertiesViewed?.[0];
  return {
    firstName: leadProfile.firstName ?? 'there',
    property: viewed?.address,
    propertyListing: viewed ? { mls: viewed.mls, address: viewed.address, city: viewed.city, state: viewed.state } : undefined,
    city: resolveLeadAreaCity(leadProfile) ?? undefined,
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
  const vars = buildTemplateVars(leadProfile, marketData);
  const templateKey = selectTemplateKey(leadProfile, qualification);
  // body is already a complete branded HTML email (signature + CASL
  // footer + unsubscribe link included) — do not append anything after it.
  const { subject, body } = EMAIL_TEMPLATES[templateKey](vars);

  if (isTestMode() && leadProfile.email !== navjotEmail) {
    console.log(`[test] Skipping email to leadId=${leadProfile.leadId} (would send in production)`);
    return { sent: false, testMode: true, templateKey, subject, body };
  }

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
      templateKey,
      subject,
      body,
    };
  } catch (error) {
    console.error(`sendEmail failed for leadId=${leadProfile.leadId}`, error);
    throw error;
  }
}
