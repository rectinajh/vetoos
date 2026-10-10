/**
 * Pure helpers for the Hyperliquid HIP-3 adapter. No I/O — everything here
 * is unit-testable without touching the network.
 */

/**
 * HIP-3 asset id rule (docs/ARCHITECTURE.md §7.1):
 *   asset = 100000 + perp_dex_index * 10000 + index_in_meta
 * The main dex is index 0; the first builder dex (e.g. xyz) is index 1.
 */
export function computeHip3AssetId(perpDexIndex: number, metaIndex: number): number {
  if (!Number.isInteger(perpDexIndex) || perpDexIndex < 0) {
    throw new Error(`invalid perp dex index: ${perpDexIndex}`);
  }
  if (!Number.isInteger(metaIndex) || metaIndex < 0) {
    throw new Error(`invalid meta index: ${metaIndex}`);
  }
  return 100000 + perpDexIndex * 10000 + metaIndex;
}

export interface ParsedMarket {
  /** Builder dex name, or null for the main perp book. */
  dex: string | null;
  /** Asset name without the dex prefix, e.g. "XYZ100". */
  coin: string;
  /** Canonical venue-side coin string, e.g. "xyz:XYZ100" or "BTC". */
  venueCoin: string;
}

/** Parse "xyz:XYZ100" or "BTC" into dex + coin parts. */
export function parseMarket(market: string): ParsedMarket {
  const idx = market.indexOf(":");
  if (idx === -1) {
    return { dex: null, coin: market, venueCoin: market };
  }
  const dex = market.slice(0, idx);
  const coin = market.slice(idx + 1);
  if (!dex || !coin) throw new Error(`invalid market: ${market}`);
  return { dex, coin, venueCoin: market };
}

export interface BookLevel {
  px: string;
  sz: string;
  n: number;
}

export interface BookLevels {
  /** index 0 = bids, index 1 = asks */
  levels: [BookLevel[], BookLevel[]];
}

/**
 * Aggregate resting size on the side an order would hit, within `bandBps`
 * of the mark. A buy lifts asks at px <= mark*(1+band); a sell hits bids
 * at px >= mark*(1-band).
 */
export function depthWithinBand(
  book: BookLevels,
  side: "buy" | "sell",
  markPx: number,
  bandBps: number,
): number {
  const [bids, asks] = book.levels;
  const band = bandBps / 10_000;
  if (side === "buy") {
    const cap = markPx * (1 + band);
    return asks.reduce((acc, l) => (Number(l.px) <= cap ? acc + Number(l.sz) : acc), 0);
  }
  const floor = markPx * (1 - band);
  return bids.reduce((acc, l) => (Number(l.px) >= floor ? acc + Number(l.sz) : acc), 0);
}

/** Round a price to Hyperliquid's 5-significant-figure rule. */
export function toSigFigs(value: number, sigFigs = 5): string {
  if (!(value > 0)) throw new Error(`price must be positive, got ${value}`);
  return Number(value.toPrecision(sigFigs)).toString();
}

/** Round a base-asset size down to the market's lot size. */
export function roundSize(size: number, szDecimals: number): string {
  const factor = Math.pow(10, szDecimals);
  const rounded = Math.floor(size * factor) / factor;
  return rounded.toFixed(szDecimals);
}

/** Aggressive IOC price that behaves like a market order, slippage-capped. */
export function aggressiveLimitPx(
  side: "buy" | "sell",
  markPx: number,
  slippageBps = 500,
): string {
  const band = slippageBps / 10_000;
  const px = side === "buy" ? markPx * (1 + band) : markPx * (1 - band);
  return toSigFigs(px);
}
