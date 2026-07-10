/**
 * Central brand identity for outbound email. Every field is env-driven so
 * the same template code serves any agent onboarded onto Vern (multi-agent
 * support — see AGENT_NAME/AGENT_PHONE/AGENT_WEBSITE in crmAdapterFactory).
 */
export const BRAND = {
  colors: {
    navy: '#001D3D',
    navySoft: '#1d3c68',
    gold: '#D4AF37',
    coral: '#f1645f',
    slate: '#334155',
    muted: '#64748b',
    bg: '#f4f4f4',
    bgCard: '#f8fafc',
    border: 'rgba(29,60,104,0.12)',
    green: '#27ae60',
    red: '#c0392b',
  },
  fontStack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif`,
  serifStack: `Georgia, 'Times New Roman', serif`,
};

function env(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

export function getAgentIdentity() {
  return {
    name: env('AGENT_NAME', 'Navjot Singh'),
    title: env('AGENT_TITLE', 'REALTOR®'),
    team: env('AGENT_TEAM', 'Team Mosaic'),
    brokerage: env('AGENT_BROKERAGE', 'eXp Realty, Brokerage'),
    phone: env('AGENT_PHONE', '519-505-5832'),
    website: env('AGENT_WEBSITE', 'navjotchahal.ca'),
    email: env('AGENT_EMAIL', 'navjot@teammosaic.ca'),
    address: env('AGENT_ADDRESS', '675 Riverbend Dr, Kitchener, ON N2K 3S3'),
    instagram: env('AGENT_INSTAGRAM', ''),
    // CASL requires a working unsubscribe mechanism on every commercial
    // electronic message; this points at the agent's own static page
    // rather than a Vern-hosted endpoint (see docs/VERN_STATUS.md).
    unsubscribeUrl: env('UNSUBSCRIBE_URL', `https://${env('AGENT_WEBSITE', 'navjotchahal.ca')}/unsubscribe`),
    bookingUrl: env('AGENT_BOOKING_URL', `https://${env('AGENT_WEBSITE', 'navjotchahal.ca')}/appointment`),
    searchUrl: env('AGENT_SEARCH_URL', `https://${env('AGENT_WEBSITE', 'navjotchahal.ca')}/listing`),
  };
}

/**
 * Builds a listing-detail page URL on the agent's site, e.g.
 * https://www.navjotchahal.ca/listing-detail/1182833690/25-Sunview-Drive-Norwich-ON
 *
 * The numeric ID is Lofty's own `listingId` (mapped onto LeadProfile as
 * `mls` in leadProfile.ts) — confirmed against a real listing URL from the
 * site. The trailing slug is address-derived and cosmetic on most IDX
 * platforms (the ID is what actually resolves the page), so it degrades
 * gracefully to street-only if city/state weren't present on the lead's
 * viewed-property record.
 */
export function buildListingDetailUrl(
  website: string,
  listing: { mls: string; address: string; city?: string; state?: string },
): string {
  const slug = [listing.address, listing.city, listing.state]
    .filter(Boolean)
    .join(' ')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `https://www.${website}/listing-detail/${encodeURIComponent(listing.mls)}/${slug}`;
}
