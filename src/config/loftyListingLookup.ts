import { getLoftyHeaders } from './loftyClient';
import { buildListingDetailUrl } from './emailBrand';

const LISTING_SEARCH_URL = 'https://api.lofty.com/v1.0/listing';

export interface LoftyListingSummary {
  listingId: string;
  mlsListingId: string;
  address: string;
  city: string;
  state: string;
  zipCode?: string;
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
