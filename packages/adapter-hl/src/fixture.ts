/**
 * FixtureAdapter — an OFFLINE stand-in for the venue so judges can run the
 * whole stack (engine, broker, console, four-act demo) with no keys, no
 * faucet and no network. Same Risk Broker, same rules, same reconciliation;
 * only the venue is canned. Every response is labelled `fixture` in the raw
 * payload so nothing offline can be mistaken for a real fill.
 */

import { HlAdapter, type AccountState, type MarketContext, type Network, type PlaceOrderParams, type PlacedOrder } from "./index.js";
import { depthWithinBand, parseMarket, roundPrice, roundSize, type BookLevels } from "./helpers.js";

interface FixtureMarket {
  dex: string | null;
  perpDexIndex: number;
  metaIndex: number;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
  funding: number;
  openInterest: number;
  /** Resting size per level on each side (same for bids/asks), 10 levels. */
  levelSize: number;
}

const MARKETS: Record<string, FixtureMarket> = {
  "xyz:XYZ100": { dex: "xyz", perpDexIndex: 1, metaIndex: 0, szDecimals: 4, maxLeverage: 20, markPx: 30932, funding: 0.0000125, openInterest: 7520.7, levelSize: 1.5 },
  BTC: { dex: null, perpDexIndex: 0, metaIndex: 0, szDecimals: 5, maxLeverage: 40, markPx: 82524, funding: 0.0000125, openInterest: 25000, levelSize: 2.0 },
};

export class FixtureAdapter extends HlAdapter {
  private readonly positions = new Map<string, number>();
  private readonly fills: { ts: number; coin: string; side: string; size: number; px: number; oid: number; closedPnl: number; fee: number }[] = [];
  private equityUsd: number;
  private nextOid = 900_000_001;
  /** Drift the mark a little on every read so the console looks alive. */
  private ticks = 0;

  constructor(opts: { equityUsd?: number } = {}) {
    super({});
    this.equityUsd = opts.equityUsd ?? 1_000;
  }

  private fixture(market: string): FixtureMarket {
    const m = MARKETS[market];
    if (!m) {
      throw new Error(`asset "${parseMarket(market).coin}" not in fixture universe: ${Object.keys(MARKETS).join(", ")}`);
    }
    return m;
  }

  private mark(market: string): number {
    const m = this.fixture(market);
    this.ticks++;
    return m.markPx * (1 + 0.0004 * Math.sin(this.ticks / 7));
  }

  override async listPerpDexNames(): Promise<(string | null)[]> {
    return [null, "xyz"];
  }

  override async findPerpDexIndex(dexName: string | null): Promise<number> {
    return dexName === null ? 0 : dexName === "xyz" ? 1 : Promise.reject(new Error(`perp dex "${dexName}" not in fixture`));
  }

  override async getMarketContext(market: string, _network: Network): Promise<MarketContext> {
    const m = this.fixture(market);
    return {
      market,
      dex: m.dex,
      perpDexIndex: m.perpDexIndex,
      metaIndex: m.metaIndex,
      assetId: m.perpDexIndex === 0 ? m.metaIndex : 100000 + m.perpDexIndex * 10000 + m.metaIndex,
      name: market,
      szDecimals: m.szDecimals,
      maxLeverage: m.maxLeverage,
      markPx: this.mark(market),
      funding: m.funding,
      openInterest: m.openInterest,
    };
  }

  override async getBook(market: string, _network: Network): Promise<BookLevels> {
    const m = this.fixture(market);
    const mark = m.markPx;
    const level = (px: number) => ({ px: roundPrice(px, m.szDecimals), sz: roundSize(m.levelSize, m.szDecimals), n: 3 });
    const bids = Array.from({ length: 10 }, (_, i) => level(mark * (1 - 0.0002 * (i + 1))));
    const asks = Array.from({ length: 10 }, (_, i) => level(mark * (1 + 0.0002 * (i + 1))));
    return { levels: [bids, asks] };
  }

  override async getMarketSnapshot(market: string, network: Network, side: "buy" | "sell", bandBps = 50) {
    const ctx = await this.getMarketContext(market, network);
    const book = await this.getBook(market, network);
    return {
      market,
      markPx: ctx.markPx,
      funding: ctx.funding,
      openInterest: ctx.openInterest,
      depthWithinBand: depthWithinBand(book, side, ctx.markPx, bandBps),
      szDecimals: ctx.szDecimals,
      assetId: ctx.assetId,
    };
  }

  override async getAccountState(_network: Network, dex?: string | null): Promise<AccountState> {
    let used = 0;
    const positions = new Map<string, number>();
    // Mirrors the venue: each builder dex has its own clearinghouse, the main
    // dex is the default — a query without `dex` never shows builder positions.
    for (const [coin, szi] of this.positions) {
      const parsed = parseMarket(coin);
      if ((dex ?? null) !== parsed.dex) continue;
      positions.set(coin, szi);
      used += Math.abs(szi) * this.fixture(coin).markPx / this.fixture(coin).maxLeverage;
    }
    return { equityUsd: this.equityUsd, availableMarginUsd: Math.max(0, this.equityUsd - used), positions };
  }

  override async getPositionSize(market: string, _network: Network): Promise<number> {
    return this.positions.get(market) ?? 0;
  }

  override async getPositionDetail(market: string, _network: Network) {
    const size = this.positions.get(market) ?? 0;
    if (size === 0) return null;
    const m = this.fixture(market);
    return { size, entryPx: m.markPx, positionValue: Math.abs(size) * m.markPx, unrealizedPnl: 0, leverage: 1 };
  }

  override async getRecentFills(_network: Network, limit = 10) {
    return this.fills.slice(-limit).reverse().map(({ ts, coin, side, size, px, oid }) => ({ ts, coin, side, size, px, oid }));
  }

  override async getRealizedPnlSince(_network: Network, sinceMs: number): Promise<number> {
    return this.fills.filter((f) => f.ts >= sinceMs).reduce((acc, f) => acc + f.closedPnl - f.fee, 0);
  }

  override async getOpenOrders(_network: Network, _dex?: string | null) {
    return [];
  }

  override async placeOrder(params: PlaceOrderParams): Promise<PlacedOrder> {
    const m = this.fixture(params.market);
    const sz = Number(roundSize(params.size, m.szDecimals));
    const px = m.markPx * (params.side === "buy" ? 1.0001 : 0.9999);
    const before = this.positions.get(params.market) ?? 0;
    const delta = params.side === "buy" ? sz : -sz;
    if (params.reduceOnly && Math.sign(before) === Math.sign(delta)) {
      throw new Error("venue rejected order: reduce-only order would increase position (fixture)");
    }
    const after = before + delta;
    this.positions.set(params.market, Number(after.toFixed(m.szDecimals)));
    const oid = this.nextOid++;
    const fee = sz * px * 0.00045;
    this.fills.push({ ts: Date.now(), coin: params.market, side: params.side === "buy" ? "B" : "A", size: sz, px, oid, closedPnl: 0, fee });
    this.equityUsd -= fee;
    return {
      status: "filled",
      oid,
      filledSize: sz,
      avgPx: Number(roundPrice(px, m.szDecimals)),
      assetId: (await this.getMarketContext(params.market, "testnet")).assetId,
      raw: { fixture: true, cloid: params.cloid ?? null },
    };
  }
}
