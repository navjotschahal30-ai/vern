import { getLoftyHeaders } from './loftyClient';
import { buildListingDetailUrl, getAgentIdentity } from './emailBrand';

const LISTING_SEARCH_URL = 'https://api.lofty.com/v1.0/listing';
const LISTING_SEARCH_V2_URL = 'https://api.lofty.com/v2.0/listings/search';

export interface LoftyListingSummary {
  listingId: string;
  mlsListingId: string;
  address: string;
  city: string;
  state: string;
  zipCode?: string;
}

export interface LoftyAddressMatch extends LoftyListingSummary {
  price?: number;
  // Lofty returns this ready-made — same value buildListingDetailUrl()
  // would construct, but authoritative straight from the source, so we
  // pass it through rather than rebuilding it.
  url: string;
}

interface RawListing {
  listingId: string;
  mlsListingId: string;
  listingStreetName: string;
  listingCity: string;
  listingState: string;
  listingZipcode?: string[];
}

interface ListingSearchResponse {
  listIng?: RawListing[] | null;
}

/**
 * Resolves MLS board listing numbers (e.g. "W13533604") to their Lofty
 * internal listingId via GET /v1.0/listing?mlsListingIds=... — the numeric
 * ID that navjotchahal.ca/listing-detail/<id>/<slug> URLs actually resolve
 * on (confirmed live: the slug is cosmetic, only the ID matters).
 *
 * Returns a Map keyed by MLS number. An MLS number with no match (delisted,
 * wrong board, typo) is simply absent from the map rather than throwing —
 * a partial batch result is still useful to the caller.
 */
export async function resolveListingsByMls(mlsListingIds: string[]): Promise<Map<string, LoftyListingSummary>> {
  const results = new Map<string, LoftyListingSummary>();
  if (mlsListingIds.length === 0) return results;

  const url = `${LISTING_SEARCH_URL}?${new URLSearchParams({ mlsListingIds: mlsListingIds.join(',') })}`;
  const response = await fetch(url, { headers: getLoftyHeaders() });

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(`Lofty listing search failed with status ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as ListingSearchResponse;

  for (const listing of data.listIng ?? []) {
    // Lofty can return more than one record for the same MLS ID (e.g. a
    // co-agent duplicate) — they describe the same property, so keep
    // whichever one is seen first.
    if (!results.has(listing.mlsListingId)) {
      results.set(listing.mlsListingId, {
        listingId: listing.listingId,
        mlsListingId: listing.mlsListingId,
        address: listing.listingStreetName,
        city: listing.listingCity,
        state: listing.listingState,
        zipCode: listing.listingZipcode?.[0],
      });
    }
  }

  return results;
}

export async function resolveListingByMls(mlsListingId: string): Promise<LoftyListingSummary | null> {
  const results = await resolveListingsByMls([mlsListingId]);
  return results.get(mlsListingId) ?? null;
}

/**
 * One-shot: MLS number -> live navjotchahal.ca listing-detail link. Returns
 * null (rather than a guessed/broken URL) when Lofty has no record for that
 * MLS number under this account's data.
 */
export async function buildListingUrlByMls(website: string, mlsListingId: string): Promise<string | null> {
  const listing = await resolveListingByMls(mlsListingId);
  if (!listing) return null;
  return buildListingDetailUrl(website, {
    mls: listing.listingId,
    address: listing.address,
    city: listing.city,
    state: listing.state,
  });
}

// ---------------------------------------------------------------------------
// Address-text search (no MLS# needed) — board-wide, not limited to this
// account's own listings.
// ---------------------------------------------------------------------------

interface RawAddressListing {
  id: number | string;
  mlsListingId: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode?: string;
  price?: number;
  // Ready-made link straight from Lofty, same shape buildListingDetailUrl()
  // constructs — not guaranteed present on every listing type, so callers
  // still fall back to building it from listingId when absent.
  siteDetailLink?: string;
}

interface ListingSearchV2Response {
  listing?: RawAddressListing[] | null;
}

async function searchListingsRaw(address: string, limit: number): Promise<RawAddressListing[]> {
  const response = await fetch(LISTING_SEARCH_V2_URL, {
    method: 'POST',
    headers: getLoftyHeaders(),
    body: JSON.stringify({
      // 'all' = board-wide (this is what the site's own search bar queries),
      // not scoped to this account's own listings — required for looking up
      // an arbitrary lead-mentioned or off-roster address.
      searchScope: 'all',
      filterConditions: { location: { streetAddress: [address] } },
      pageNum: 1,
      pageSize: limit,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(`Lofty address search failed with status ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as ListingSearchV2Response;
  return data.listing ?? [];
}

const GEOLOCATOR_URL = 'https://geogratis.gc.ca/services/geolocation/en/locate';
// Only street-level results carry a real civic address — matches
// core/address-lookup.js's filter in MOSAIC_INTELLIGENCE, which uses the
// same free NRCan endpoint for the same reason.
const GEOLOCATOR_STREET_TYPE = 'ca.gc.nrcan.geoloc.data.model.Street';
const MUNICIPALITY_PREFIX =
  /^(city|town|township|village|municipality|regional municipality|county|district|district municipality) of\s+/i;

interface GeolocatorResult {
  title: string;
  type: string;
  qualifier?: string;
}

/**
 * Best-effort address correction via NRCan's free, keyless Geolocator
 * (Canada Post's own upstream source for the National Address Register) —
 * catches typos, a missing city, or an abbreviated street type before
 * retrying a Lofty address search that came back empty. Returns null
 * (never a guess) when nothing street-level matches, so the caller can fail
 * cleanly instead of retrying on junk.
 */
async function normalizeAddress(rawAddress: string): Promise<string | null> {
  const trimmed = rawAddress.trim();
  if (trimmed.length < 3) return null;

  const url = `${GEOLOCATOR_URL}?${new URLSearchParams({ q: trimmed, num: '5' })}`;
  let results: unknown;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'VernOutreachAgent/1.0 (navjot@teammosaic.ca)' },
      signal: AbortSignal.timeout(3000),
    });
    results = await response.json();
  } catch {
    return null;
  }

  if (!Array.isArray(results)) return null;
  const streets = (results as GeolocatorResult[]).filter((r) => r.type === GEOLOCATOR_STREET_TYPE);
  if (streets.length === 0) return null;

  // A civic-numbered match is a more useful correction than a bare street
  // name — prefer those when multiple candidates come back.
  const sorted = [...streets].sort((a, b) => {
    const aPos = a.qualifier === 'INTERPOLATED_POSITION' ? 0 : 1;
    const bPos = b.qualifier === 'INTERPOLATED_POSITION' ? 0 : 1;
    return aPos - bPos;
  });
  const best = sorted[0];
  if (!best) return null;

  const [street, municipality] = best.title.split(',').map((part) => part.trim());
  if (!street) return null;
  return municipality ? `${street}, ${municipality.replace(MUNICIPALITY_PREFIX, '')}` : street;
}

export interface AddressSearchResult {
  matches: LoftyAddressMatch[];
  queryUsed: string;
  corrected: boolean;
}

/**
 * Address text -> live listing link(s). Searches board-wide (not limited to
 * this account's own listings — same data your site's own search bar
 * queries) via Lofty's v2.0 search. Tries the address as given first; if
 * that comes back empty, retries once against an NRCan-corrected form
 * before giving up, so a typo'd or loosely-formatted lead-provided address
 * doesn't fail outright. `corrected` tells the caller whether the
 * as-given text actually matched, or the correction was what worked.
 */
export async function searchListingsByAddress(rawAddress: string, limit = 5): Promise<AddressSearchResult> {
  const agent = getAgentIdentity();
  const toMatch = (item: RawAddressListing): LoftyAddressMatch => ({
    listingId: String(item.id),
    mlsListingId: item.mlsListingId,
    address: item.streetAddress,
    city: item.city,
    state: item.state,
    zipCode: item.zipCode,
    price: item.price,
    url:
      item.siteDetailLink ??
      buildListingDetailUrl(agent.website, {
        mls: String(item.id),
        address: item.streetAddress,
        city: item.city,
        state: item.state,
      }),
  });

  const direct = await searchListingsRaw(rawAddress, limit);
  if (direct.length > 0) {
    return { matches: direct.map(toMatch), queryUsed: rawAddress, corrected: false };
  }

  const normalized = await normalizeAddress(rawAddress);
  if (!normalized || normalized.toLowerCase() === rawAddress.trim().toLowerCase()) {
    return { matches: [], queryUsed: rawAddress, corrected: false };
  }

  const retried = await searchListingsRaw(normalized, limit);
  return { matches: retried.map(toMatch), queryUsed: normalized, corrected: retried.length > 0 };
}
