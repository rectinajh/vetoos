/**
 * @vetoos/adapter-hl — the ONLY module that talks to Hyperliquid.
 *
 * Read path : mainnet InfoClient — real HIP-3 dexes, marks, funding, books.
 * Write path: testnet ExchangeClient — real fills, controlled size.
 *
 * The adapter never decides anything. It fetches truth and executes what
 * the Risk Broker — and only the Risk Broker — tells it to.
 */

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import {
  aggressiveLimitPx,
  computeHip3AssetId,
  depthWithinBand,
  parseMarket,
  roundSize,
  withBackoff,
  type BookLevels,
} from "./helpers.js";

export * from "./helpers.js";

export type Network = "mainnet" | "testnet";

export const DEFAULT_MAINNET_URL = "https://api.hyperliquid.xyz";
export const DEFAULT_TESTNET_URL = "https://api.hyperliquid-testnet.xyz";

export interface HlAdapterConfig {
  /** Private key (hex). Only ever held here — the signing component. */
  privateKey?: string;
  /** Account address the key trades for (defaults to the key's address). */
  accountAddress?: string;
  mainnetUrl?: string;
  testnetUrl?: string;
  /** Builder attribution (PRD §13.7 — placeholder allowed on testnet). */
  builderAddress?: string;
  builderFeeTenthsBps?: number;
}

export interface MarketContext {
  market: string;
  dex: string | null;
  perpDexIndex: number;
  metaIndex: number;
  assetId: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
  funding: number;
  openInterest: number;
}

export interface AccountState {
  equityUsd: number;
  availableMarginUsd: number;
  positions: Map<string, number>;
}

export interface PlaceOrderParams {
  market: string;
  side: "buy" | "sell";
  size: number;
  /** Explicit limit price; defaults to aggressive IOC around the mark. */
  limitPx?: string;
  reduceOnly?: boolean;
  tif?: "Gtc" | "Ioc" | "Alo";
}

export interface PlacedOrder {
  status: "filled" | "resting";
  oid: number;
  filledSize: number;
  avgPx: number;
  assetId: number;
  raw: unknown;
}

export class HlAdapter {
  private readonly mainnetInfo: InfoClient;
  private readonly testnetInfo: InfoClient;
  private readonly testnetExchange?: ExchangeClient;
  readonly config: HlAdapterConfig;

  constructor(config: HlAdapterConfig = {}) {
    this.config = config;
    const mainnetTransport = new HttpTransport({
      isTestnet: false,
      ...(config.mainnetUrl ? { url: config.mainnetUrl } : {}),
    });
    const testnetTransport = new HttpTransport({
      isTestnet: true,
      ...(config.testnetUrl ? { url: config.testnetUrl } : {}),
    });
    this.mainnetInfo = new InfoClient({ transport: mainnetTransport });
    this.testnetInfo = new InfoClient({ transport: testnetTransport });
    if (config.privateKey) {
      this.testnetExchange = new ExchangeClient({
        transport: testnetTransport,
        wallet: config.privateKey,
      });
    }
  }

  info(network: Network): InfoClient {
    return network === "mainnet" ? this.mainnetInfo : this.testnetInfo;
  }

  /** Dex names in perpDexs() order; null = main dex. Index = perp dex index. */
  async listPerpDexNames(network: Network): Promise<(string | null)[]> {
    const dexs = await withBackoff(() => this.info(network).perpDexs());
    return dexs.map((d) => (d === null ? null : d.name));
  }

  async findPerpDexIndex(dexName: string | null, network: Network): Promise<number> {
    if (dexName === null) return 0;
    const names = await this.listPerpDexNames(network);
    const idx = names.findIndex((n) => n === dexName);
    if (idx === -1) {
      throw new Error(
        `perp dex "${dexName}" not found on ${network}; available: ${names.filter(Boolean).join(", ") || "(none)"}`,
      );
    }
    return idx;
  }

  /**
   * Resolve a market ("xyz:XYZ100" or "BTC") to its real on-venue context.
   * Throws when the venue has no such market — callers must fail closed.
   */
  async getMarketContext(market: string, network: Network): Promise<MarketContext> {
    const parsed = parseMarket(market);
    const perpDexIndex = await this.findPerpDexIndex(parsed.dex, network);
    const [meta, ctxs] = await withBackoff(() =>
      this.info(network).metaAndAssetCtxs(parsed.dex ? { dex: parsed.dex } : {}),
    );
    const metaIndex = meta.universe.findIndex(
      (u) => u.name === parsed.coin || u.name === parsed.venueCoin,
    );
    if (metaIndex === -1) {
      throw new Error(
        `asset "${parsed.coin}" not in ${parsed.dex ?? "main"} universe on ${network}: ` +
          meta.universe.map((u) => u.name).join(", "),
      );
    }
    const universe = meta.universe[metaIndex]!;
    const ctx = ctxs[metaIndex];
    if (!ctx) throw new Error(`no asset ctx for ${market} on ${network}`);
    return {
      market,
      dex: parsed.dex,
      perpDexIndex,
      metaIndex,
      assetId: computeHip3AssetId(perpDexIndex, metaIndex),
      name: universe.name,
      szDecimals: universe.szDecimals,
      maxLeverage: universe.maxLeverage,
      markPx: Number(ctx.markPx),
      funding: Number(ctx.funding),
      openInterest: Number(ctx.openInterest),
    };
  }

  async getBook(market: string, network: Network): Promise<BookLevels> {
    const { venueCoin } = parseMarket(market);
    const book = await withBackoff(() => this.info(network).l2Book({ coin: venueCoin }));
    if (!book) throw new Error(`no l2Book for ${venueCoin} on ${network} — failing closed`);
    return { levels: book.levels as BookLevels["levels"] };
  }

  /** Real market snapshot for the risk engine: mark + depth on the hit side. */
  async getMarketSnapshot(
    market: string,
    network: Network,
    side: "buy" | "sell",
    bandBps = 50,
  ) {
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

  private accountAddress(): string {
    const addr = this.config.accountAddress;
    if (!addr) {
      throw new Error("HL_ACCOUNT_ADDRESS is required to read account state");
    }
    return addr;
  }

  /** Real account state (equity / margin / positions) on the given network. */
  async getAccountState(network: Network, dex?: string | null): Promise<AccountState> {
    const state = await withBackoff(() =>
      this.info(network).clearinghouseState({
        user: this.accountAddress() as `0x${string}`,
        ...(dex ? { dex } : {}),
      }),
    );
    const equityUsd = Number(state.marginSummary.accountValue);
    const availableMarginUsd = Number(state.withdrawable);
    const positions = new Map<string, number>();
    for (const ap of state.assetPositions) {
      positions.set(ap.position.coin, Number(ap.position.szi));
    }
    return { equityUsd, availableMarginUsd, positions };
  }

  /** Signed position size for one market (0 when flat). */
  async getPositionSize(market: string, network: Network): Promise<number> {
    const parsed = parseMarket(market);
    const state = await this.getAccountState(network, parsed.dex);
    for (const [coin, szi] of state.positions) {
      if (coin === parsed.coin || coin === parsed.venueCoin) return szi;
    }
    return 0;
  }

  /**
   * Place a real order on testnet. Only callable with a configured key —
   * and in this codebase, only the Risk Broker ever calls it.
   */
  async placeOrder(params: PlaceOrderParams): Promise<PlacedOrder> {
    if (!this.testnetExchange) {
      throw new Error("no HL_PRIVATE_KEY configured — order signing unavailable");
    }
    const network: Network = "testnet";
    const ctx = await this.getMarketContext(params.market, network);
    const markPx = ctx.markPx;
    const px =
      params.limitPx ??
      aggressiveLimitPx(params.side, markPx);
    const sz = roundSize(params.size, ctx.szDecimals);
    const builder =
      this.config.builderAddress && this.config.builderFeeTenthsBps !== undefined
        ? { b: this.config.builderAddress as `0x${string}`, f: this.config.builderFeeTenthsBps }
        : undefined;

    const response = await this.testnetExchange.order({
      orders: [
        {
          a: ctx.assetId,
          b: params.side === "buy",
          p: px,
          s: sz,
          r: params.reduceOnly ?? false,
          t: { limit: { tif: params.tif ?? "Ioc" } },
        },
      ],
      grouping: "na",
      ...(builder ? { builder } : {}),
    });

    const status = response.response.data.statuses[0];
    if (!status) throw new Error("venue returned no order status");
    if ("error" in status) {
      throw new Error(`venue rejected order: ${String(status.error)}`);
    }
    if ("filled" in status && status.filled) {
      return {
        status: "filled",
        oid: Number(status.filled.oid),
        filledSize: Number(status.filled.totalSz),
        avgPx: Number(status.filled.avgPx),
        assetId: ctx.assetId,
        raw: status,
      };
    }
    const resting = "resting" in status ? status.resting : undefined;
    return {
      status: "resting",
      oid: Number(resting?.oid ?? 0),
      filledSize: 0,
      avgPx: 0,
      assetId: ctx.assetId,
      raw: status,
    };
  }
}
