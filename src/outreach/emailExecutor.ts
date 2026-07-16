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
  // Lofty's leadPropertyList doesn't always carry a listingId (e.g. properties
  // synced before the listing was indexed) — prefer the first viewed property
  // that actually has one so the CTA links to a real page instead of a
  // broken /listing-detail/<empty>/... URL. Fall back to [0] for the display
  // label only when nothing in the list has a usable listingId.
  const linkable = leadProfile.propertiesViewed?.find((property) => property.mls);
  const viewed = linkable ?? leadProfile.propertiesViewed?.[0];
  return {
    firstName: leadProfile.firstName ?? 'there',
    property: viewed?.address,
    propertyListing: linkable
      ? { mls: linkable.mls, address: linkable.address, city: linkable.city, state: linkable.state }
      : undefined,
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
