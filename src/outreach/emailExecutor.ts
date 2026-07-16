import { LeadProfile, resolveLeadAreaCity } from '../schemas/leadProfile';
import { LeadQualification } from '../engines/qualificationEngine';
import { EMAIL_TEMPLATES, selectTemplateKey, TemplateKey, TemplateVars } from '../config/templates';
import { MarketSnapshot } from '../schemas/marketSnapshot';
import { getLoftyHeaders } from '../config/loftyClient';
import { isTestMode, navjotEmail } from '../config/testMode';
import { resolveListingByMls, searchListingsByAddress } from '../config/loftyListingLookup';

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

// Distinct from SkippedEmailResult (test mode still renders and would have
// sent) — this means we deliberately withheld the send because we couldn't
// back the email with anything real: no confirmed listing link, no market
// numbers. No subject/body because none was ever rendered.
export interface NoDataSkippedEmailResult {
  sent: false;
  noData: true;
  templateKey: TemplateKey;
  reason: string;
}

interface ResolvedPropertyListing {
  mls: string;
  address: string;
  city?: string;
  state?: string;
}

/**
 * Confirms a lead's viewed property is a real, currently-resolvable listing
 * before it's used to build an email CTA — prevents sending a
 * property-specific email whose "View This Listing" button 404s because
 * the listing was delisted, or the raw Lofty leadPropertyList entry was
 * stale/typo'd. Tries the mls-number lookup first (authoritative), then
 * falls back to an address-text search (with NRCan typo correction) for
 * viewed properties that never carried an mls id at all.
 */
async function resolveViewedPropertyListing(leadProfile: LeadProfile): Promise<ResolvedPropertyListing | null> {
  const linkable = leadProfile.propertiesViewed?.find((property) => property.mls);
  if (linkable) {
    const resolved = await resolveListingByMls(linkable.mls).catch((error) => {
      console.warn(`[email] MLS lookup failed for ${linkable.mls}:`, error);
      return null;
    });
    if (resolved) {
      return { mls: resolved.listingId, address: resolved.address, city: resolved.city, state: resolved.state };
    }
  }

  const viewed = linkable ?? leadProfile.propertiesViewed?.[0];
  if (viewed?.address) {
    const { matches } = await searchListingsByAddress(viewed.address).catch((error) => {
      console.warn(`[email] Address search failed for "${viewed.address}":`, error);
      return { matches: [], queryUsed: viewed.address, corrected: false };
    });
    const match = matches[0];
    if (match) {
      return { mls: match.listingId, address: match.address, city: match.city, state: match.state };
    }
  }

  return null;
}

function buildTemplateVars(
  leadProfile: LeadProfile,
  marketData: MarketSnapshot | undefined,
  resolvedListing: ResolvedPropertyListing | null,
): TemplateVars {
  const viewed = leadProfile.propertiesViewed?.find((property) => property.mls) ?? leadProfile.propertiesViewed?.[0];
  return {
    firstName: leadProfile.firstName ?? 'there',
    property: resolvedListing?.address ?? viewed?.address,
    propertyListing: resolvedListing ?? undefined,
    city: resolveLeadAreaCity(leadProfile) ?? undefined,
    marketData,
  };
}

// Templates that only exist to present real numbers (market stats or a
// confirmed listing) — sending them with nothing behind the copy is exactly
// the bug this file exists to prevent, so treat missing data as a hard skip
// rather than falling through to hollow placeholder copy.
const MARKET_DATA_REQUIRED_TEMPLATES: TemplateKey[] = [
  'ghost_reactivation',
  'generic_warm',
  'generic_cold',
  'facebook_buyer_warm',
  'generic_hot',
];

/**
 * Sends a personalized email for a lead via the Lofty messaging API.
 */
export async function sendEmail(
  leadProfile: LeadProfile,
  qualification: LeadQualification,
  marketData?: MarketSnapshot,
): Promise<SendEmailResult | SkippedEmailResult | NoDataSkippedEmailResult> {
  let templateKey = selectTemplateKey(leadProfile, qualification);
  let resolvedListing: ResolvedPropertyListing | null = null;

  if (templateKey === 'website_buyer_hot') {
    resolvedListing = await resolveViewedPropertyListing(leadProfile);
    if (!resolvedListing) {
      // Can't back a property-specific email with a real listing link —
      // fall back to a data-driven generic template rather than sending a
      // "View This Listing" button that leads nowhere real.
      templateKey = qualification.status === 'hot' ? 'generic_hot' : 'generic_warm';
    }
  }

  if (MARKET_DATA_REQUIRED_TEMPLATES.includes(templateKey) && !marketData) {
    console.warn(`[email] Skipping leadId=${leadProfile.leadId} — template ${templateKey} needs market data and none is available`);
    return {
      sent: false,
      noData: true,
      templateKey,
      reason: 'No market data available for this lead\'s area — withholding send rather than sending placeholder copy',
    };
  }

  const vars = buildTemplateVars(leadProfile, marketData, resolvedListing);
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
