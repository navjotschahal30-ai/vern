/**
 * Shape Vern gets back from Content Agent's `/market/analyze` endpoint
 * (see fetchMarketData in cadenceManager.ts). Confirmed directly against
 * the real handler — navjot-content-agent/core/traps-analyzer.js,
 * analyzeMarket() / mockMarketData() / fallbackMarketData() — all three
 * return this exact shape, so it's safe to type as required rather than
 * `any`. Backed by the live Ampre/VOW feed (TRAPS_ENDPOINT =
 * query.ampre.ca) as of this writing; Cornerstone board data is planned
 * but not yet wired into Content Agent.
 *
 * Content Agent does NOT echo back the `city` it was asked about — the
 * caller (fetchMarketData in cadenceManager.ts) attaches it itself.
 *
 * If Content Agent's response shape changes, update this file to match —
 * that's what keeps drift from silently rendering broken emails instead
 * of a type error.
 */
export interface MarketSnapshot {
  city: string;
  marketType: 'buyer' | 'seller' | 'balanced';
  daysOnMarket: number;
  activeListings: number;
  soldLast30Days: number;
  pricePerSqft: number;
  absorption: number; // months of inventory (active / monthly sold pace)
  trend: string; // currently always 'stable' — Content Agent has this as a TODO
  buyerOpportunity: string; // human-readable takeaway sentence, already written
  timestamp: string; // ISO
}
