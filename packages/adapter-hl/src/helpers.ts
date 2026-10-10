/**
 * Pure helpers for the Hyperliquid HIP-3 adapter. No I/O — everything here
 * is unit-testable without touching the network.
 */

/**
 * HIP-3 asset id rule (docs/ARCHITECTURE.md §7.1):
 *   builder dexes (index >= 1): asset = 100000 + perp_dex_index * 10000 + index_in_meta
 *   main dex (index 0):         asset = index_in_meta   (plain, e.g. BTC = 0)
 */
export function computeHip3AssetId(perpDexIndex: number, metaIndex: number): number {
  if (!Number.isInteger(perpDexIndex) || perpDexIndex < 0) {
    throw new Error(`invalid perp dex index: ${perpDexIndex}`);
  }
  if (!Number.isInteger(metaIndex) || metaIndex < 0) {
    throw new Error(`invalid meta index: ${metaIndex}`);
  }
  if (perpDexIndex === 0) return metaIndex;
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

/** True for venue/transport errors worth retrying (rate limits, 5xx, network). */
export function isRetryableError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return /429|rate.?limit|5\d\d|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

export interface BackoffOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Exponential backoff for READ calls. Never wrap order placement with this:
 * a retried order can become a double fill — reads retry, writes fail loud.
 */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || i === attempts - 1) throw err;
      await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}
