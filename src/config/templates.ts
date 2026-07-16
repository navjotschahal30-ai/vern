import { LeadProfile } from '../schemas/leadProfile';
import { LeadQualification } from '../engines/qualificationEngine';
import { MarketSnapshot } from '../schemas/marketSnapshot';
import { getAgentIdentity, buildListingDetailUrl } from './emailBrand';
import {
  emailShell,
  heroHeader,
  reportHeader,
  paragraph,
  ctaButton,
  calloutBox,
  metricCardRow,
  sectionHeading,
  signatureBlock,
  caslFooter,
  escapeHtml,
  MetricCard,
} from './htmlEmailComponents';

export type TemplateKey =
  | 'website_buyer_hot'
  | 'facebook_buyer_warm'
  | 'ghost_reactivation'
  | 'generic_hot'
  | 'generic_warm'
  | 'generic_cold';

export interface TemplateVars {
  firstName: string;
  property?: string;
  // Structured version of `property` — populated whenever the lead has a
  // propertiesViewed[0] entry, used to link the CTA to the actual listing
  // page instead of a generic booking page. See buildListingDetailUrl().
  propertyListing?: { mls: string; address: string; city?: string; state?: string };
  city?: string;
  marketData?: MarketSnapshot;
}

type SmsTemplate = (vars: TemplateVars) => string;
type EmailTemplate = (vars: TemplateVars) => { subject: string; body: string };

// ---------------------------------------------------------------------------
// SMS stays plain text — no HTML rendering, no CASL footer (SMS opt-out is
// handled by "reply STOP", already enforced in compliance.ts/eventListener.ts).
// ---------------------------------------------------------------------------
export const SMS_TEMPLATES: Record<TemplateKey, SmsTemplate> = {
  website_buyer_hot: (vars) =>
    `${vars.firstName}, ${vars.property ?? 'that one you viewed'} is priced right for what's moving right now. Want me to set up a walkthrough?`,
  facebook_buyer_warm: (vars) =>
    `${vars.firstName}, ${vars.city ?? 'your search area'} has had some quiet movement lately worth a look. Want me to send what's new?`,
  ghost_reactivation: (vars) =>
    `${vars.firstName}, a few solid options just hit the market in ${vars.city ?? 'your area'}. Want me to send them over?`,
  generic_hot: (vars) =>
    `${vars.firstName}, inventory's moving fast right now and a few places fit exactly what you're after. Want first look?`,
  generic_warm: (vars) =>
    `${vars.firstName}, things have shifted a bit in the market lately, worth a quick look at what's new. Want me to send a few?`,
  generic_cold: (vars) =>
    `${vars.firstName}, a couple of fresh listings line up with what you'd looked at before. Want a peek?`,
};

// ---------------------------------------------------------------------------
// HTML email — two visual families sharing the same brand system
// (src/config/emailBrand.ts, src/config/htmlEmailComponents.ts):
//
//   "hero"   — direct-response welcome style (navy/gold), used for
//              first-contact/high-intent sends where the lead already has
//              a specific property or source signal to reference.
//   "report" — data-forward market-snapshot style (navy/coral + charts),
//              used for nurture/reactivation sends where the value is the
//              market data itself (VOW feed today, Cornerstone board data
//              once wired into Content Agent).
//
// Every template ends in signatureBlock() + caslFooter() — do not build a
// new template that skips either; caslFooter() carries the sender identity,
// mailing address, and unsubscribe link CASL requires on every commercial
// electronic message.
// ---------------------------------------------------------------------------

function heroEmail(opts: {
  eyebrow: string;
  titleHtml: string;
  paragraphs: string[];
  metricCards?: MetricCard[];
  ctaLabel: string;
  ctaHref: string;
  afterCta?: string;
}): string {
  const inner =
    heroHeader({ eyebrow: opts.eyebrow, titleHtml: opts.titleHtml }) +
    `<tr><td style="padding:36px 40px; color:${'#001D3D'};">` +
    opts.paragraphs.map((p) => paragraph(p)).join('') +
    (opts.metricCards?.length ? metricCardRow(opts.metricCards) : '') +
    ctaButton({ label: opts.ctaLabel, href: opts.ctaHref }) +
    (opts.afterCta ? paragraph(opts.afterCta, { muted: true, size: 13 }) : '') +
    `</td></tr>` +
    signatureBlock() +
    caslFooter();
  return emailShell(inner);
}

// Field names match navjot-content-agent/core/traps-analyzer.js's
// analyzeMarket() return shape exactly — no property-type breakdown or
// price-band data exists upstream, so don't reintroduce those here.
function marketMetricCards(marketData: MarketSnapshot | undefined): MetricCard[] {
  if (!marketData) return [];
  return [
    { label: 'Active listings', value: String(marketData.activeListings) },
    { label: 'Sold last 30 days', value: String(marketData.soldLast30Days), subColor: '#27ae60' },
    { label: 'Avg days on market', value: String(marketData.daysOnMarket) },
    {
      label: 'Est. $/sqft',
      value: marketData.pricePerSqft ? `$${marketData.pricePerSqft.toLocaleString('en-US')}` : '—',
    },
  ];
}

// MarketSnapshot has no "period" field (Content Agent returns a live
// snapshot, not a monthly rollup) — derive a display label from timestamp
// instead of inventing a period string.
function marketDateline(marketData: MarketSnapshot | undefined): string {
  if (!marketData) return 'Latest data';
  return new Date(marketData.timestamp).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

const MARKET_TYPE_LABEL: Record<MarketSnapshot['marketType'], string> = {
  buyer: "buyer's market",
  seller: "seller's market",
  balanced: 'balanced market',
};

function marketHeadline(marketData: MarketSnapshot | undefined, cityFallback: string): string {
  if (!marketData) {
    return `Whenever you're ready, I can pull exactly what's moving in ${escapeHtml(cityFallback)} right now — and what it means if you're buying or selling.`;
  }
  const typeLabel = MARKET_TYPE_LABEL[marketData.marketType] ?? 'market';
  return (
    `<span style="color:#f1645f; font-weight:600">${marketData.absorption.toFixed(1)} months of inventory</span> in ${escapeHtml(marketData.city)} right now — a ${typeLabel}. ` +
    escapeHtml(marketData.buyerOpportunity)
  );
}

function reportEmail(opts: {
  dateline: string;
  titleHtml: string;
  subtitle: string;
  greetingName: string;
  city: string;
  intro: string;
  marketData?: MarketSnapshot;
  ctaLinks: Array<{ label: string; sublabel: string; href: string }>;
}): string {
  const cards = marketMetricCards(opts.marketData);

  const ctaRows = opts.ctaLinks
    .map(
      (link, i) =>
        `<tr><td style="padding-bottom:${i < opts.ctaLinks.length - 1 ? '10px' : '0'};"><a target="_blank" style="display:block;padding:12px 16px;background:rgba(241,100,95,0.05);border:1px solid rgba(241,100,95,0.3);border-radius:6px;text-decoration:none;color:#1d3c68;font-size:13px;font-weight:600;" href="${escapeHtml(link.href)}"><strong style="color:#f1645f; display:block; font-size:10px; font-weight:700; letter-spacing:0.1em; margin-bottom:2px; text-transform:uppercase">${escapeHtml(link.label)}</strong>${escapeHtml(link.sublabel)} &rarr;</a></td></tr>`,
    )
    .join('');

  const inner =
    reportHeader({ dateline: opts.dateline, titleHtml: opts.titleHtml, subtitle: opts.subtitle }) +
    `<tr><td style="padding:36px 40px;">` +
    paragraph(`Hi ${escapeHtml(opts.greetingName)},`, { color: '#1d3c68', size: 15 }) +
    paragraph(opts.intro) +
    calloutBox(marketHeadline(opts.marketData, opts.city)) +
    (cards.length ? metricCardRow(cards) : '') +
    sectionHeading('What this means for you') +
    paragraph(
      opts.marketData
        ? `If you're thinking about selling, pricing against current absorption matters more than it did a few months ago. If you're buying, knowing how fast things are moving right now tells you how aggressive to be with an offer.`
        : `I can pull the exact numbers for your street or building the moment you want them — just reply and let me know what you're weighing.`,
    ) +
    `<table width="100%" cellpadding="0" cellspacing="0"><tbody>${ctaRows}</tbody></table>` +
    `</td></tr>` +
    signatureBlock() +
    caslFooter();

  return emailShell(inner);
}

export const EMAIL_TEMPLATES: Record<TemplateKey, EmailTemplate> = {
  website_buyer_hot: (vars) => {
    const agent = getAgentIdentity();
    const propertyLabel = vars.property ?? 'that listing';
    const md = vars.marketData;
    // Real listing-detail link when we have the Lofty listingId (mls) for
    // the viewed property; falls back to the general search page rather
    // than a broken/guessed URL if we don't. Guard on `.mls` (not just
    // object presence) in case a caller ever builds propertyListing without
    // confirming a listingId is present.
    const listingHref = vars.propertyListing?.mls
      ? buildListingDetailUrl(agent.website, vars.propertyListing)
      : agent.searchUrl;
    return {
      subject: `${propertyLabel} you viewed`,
      body: heroEmail({
        eyebrow: 'Following Up',
        titleHtml: `${escapeHtml(propertyLabel)} is still worth a look, ${escapeHtml(vars.firstName)}.`,
        paragraphs: [
          md
            ? `Not sure if you're still interested, but I wanted to share <strong>${escapeHtml(propertyLabel)}</strong> with you. Homes like it in ${escapeHtml(md.city)} are averaging just ${md.daysOnMarket} days on market right now, so it's worth acting on while it's still available.`
            : `Not sure if you're still interested, but I wanted to share <strong>${escapeHtml(propertyLabel)}</strong> with you.`,
          `Take another look while it's still available — I can also line up something similar if it's no longer a fit.`,
        ],
        metricCards: marketMetricCards(md),
        ctaLabel: 'View This Listing',
        ctaHref: listingHref,
        afterCta: `Prefer to talk it through first? Reply with a good time and I'll call — ${escapeHtml(agent.phone)}.`,
      }),
    };
  },

  facebook_buyer_warm: (vars) => {
    const agent = getAgentIdentity();
    const md = vars.marketData;
    const city = vars.city ?? md?.city ?? 'your search area';
    return {
      subject: `${city} update`,
      body: heroEmail({
        eyebrow: 'Worth A Look',
        titleHtml: md
          ? `${escapeHtml(city)} is moving, ${escapeHtml(vars.firstName)}.`
          : `${escapeHtml(city)} update, ${escapeHtml(vars.firstName)}.`,
        paragraphs: [
          md
            ? `${escapeHtml(city)} has ${md.activeListings} active listings and ${md.soldLast30Days} sales in the last 30 days — closer to what you were originally searching for than what's on the surface right now.`
            : `Been meaning to check back in on ${escapeHtml(city)} for you — happy to pull the latest numbers if it'd help.`,
          `No pressure to book anything — take a look at what's active right now and reply if any of it's worth a closer look.`,
        ],
        metricCards: marketMetricCards(md),
        ctaLabel: 'Browse What\'s New',
        ctaHref: agent.searchUrl,
        afterCta: `Prefer I just send over a short list instead? Reply and I'll put one together.`,
      }),
    };
  },

  generic_hot: (vars) => {
    const agent = getAgentIdentity();
    const md = vars.marketData;
    const city = vars.city ?? md?.city;
    return {
      subject: 'Worth a look right now',
      body: heroEmail({
        eyebrow: 'Inventory Moving',
        titleHtml: md
          ? `Inventory's moving fast in ${escapeHtml(city ?? 'your area')}, ${escapeHtml(vars.firstName)}.`
          : `Worth a look right now, ${escapeHtml(vars.firstName)}.`,
        paragraphs: [
          md
            ? `A few places fit exactly what you've been after, and with just ${md.daysOnMarket} average days on market${city ? ` in ${escapeHtml(city)}` : ''}, homes matching your search criteria aren't sitting long.`
            : `A few places on the market right now likely fit what you've been after based on your search criteria.`,
          `Want first look before they're gone? A short call is the fastest way to get you something useful.`,
        ],
        metricCards: marketMetricCards(md),
        ctaLabel: 'Book a 10-Minute Call',
        ctaHref: agent.bookingUrl,
      }),
    };
  },

  ghost_reactivation: (vars) => {
    const agent = getAgentIdentity();
    const city = vars.city ?? vars.marketData?.city ?? 'your area';
    return {
      subject: `The ${city} numbers — what they mean for you`,
      body: reportEmail({
        dateline: `${city} • ${marketDateline(vars.marketData)}`,
        titleHtml: `The ${escapeHtml(city)} numbers.<br />What they actually mean.`,
        subtitle: vars.marketData ? `Live residential MLS data — VOW feed` : `A quick check-in on ${escapeHtml(city)} since we last talked`,
        greetingName: vars.firstName,
        city,
        intro: vars.marketData
          ? `It's been a while, so I pulled the current numbers for ${escapeHtml(city)} rather than just checking in empty-handed. Here's what's actually happening.`
          : `It's been a while, so I wanted to check in rather than let things go quiet.`,
        marketData: vars.marketData,
        ctaLinks: [
          { label: 'Book a call', sublabel: `${agent.website}/appointment`, href: agent.bookingUrl },
          { label: 'Seller strategy', sublabel: `${agent.website}/sell`, href: `https://${agent.website}/sell` },
          { label: 'Search active listings', sublabel: `${agent.website}/listing`, href: `https://${agent.website}/listing` },
        ],
      }),
    };
  },

  generic_warm: (vars) => {
    const agent = getAgentIdentity();
    const city = vars.city ?? vars.marketData?.city ?? 'your area';
    return {
      subject: 'A quick market update',
      body: reportEmail({
        dateline: `${city} • ${marketDateline(vars.marketData)}`,
        titleHtml: `Here's what's new in ${escapeHtml(city)}.`,
        subtitle: vars.marketData ? `Live residential MLS data — VOW feed` : `A short update, nothing to act on unless you want to`,
        greetingName: vars.firstName,
        city,
        intro: vars.marketData
          ? `Things have shifted a bit in the market lately — worth a quick look at what's new before you decide anything.`
          : `Just a quick check-in — happy to pull current numbers for ${escapeHtml(city)} if it'd help while you decide anything.`,
        marketData: vars.marketData,
        ctaLinks: [
          { label: 'Book a call', sublabel: `${agent.website}/appointment`, href: agent.bookingUrl },
          { label: 'Search active listings', sublabel: `${agent.website}/listing`, href: `https://${agent.website}/listing` },
        ],
      }),
    };
  },

  generic_cold: (vars) => {
    const agent = getAgentIdentity();
    const city = vars.city ?? vars.marketData?.city ?? 'your area';
    return {
      subject: 'A few fresh listings',
      body: reportEmail({
        dateline: `${city}`,
        titleHtml: `A couple of things worth a peek.`,
        subtitle: `Matched loosely to what you'd looked at before`,
        greetingName: vars.firstName,
        city,
        intro: `A couple of fresh listings line up with what you'd looked at before. No pressure either way — just flagging them in case the timing's better now.`,
        marketData: vars.marketData,
        ctaLinks: [{ label: 'Search active listings', sublabel: `${agent.website}/listing`, href: `https://${agent.website}/listing` }],
      }),
    };
  },
};

/**
 * Picks which template to use based on source + intent for the named
 * combos, falling back to a generic template per qualification status for
 * everything else.
 */
export function selectTemplateKey(leadProfile: LeadProfile, qualification: LeadQualification): TemplateKey {
  if (qualification.status === 'ghost') return 'ghost_reactivation';

  const source = leadProfile.source.toLowerCase();
  if (source === 'website' && leadProfile.leadIntent === 'buyer' && qualification.status === 'hot') {
    return 'website_buyer_hot';
  }
  if (source === 'facebook' && leadProfile.leadIntent === 'buyer' && qualification.status === 'warm') {
    return 'facebook_buyer_warm';
  }

  switch (qualification.status) {
    case 'hot':
      return 'generic_hot';
    case 'warm':
      return 'generic_warm';
    default:
      return 'generic_cold';
  }
}
