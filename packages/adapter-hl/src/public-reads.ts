/**
 * Public reads — everything a shadow report needs, and nothing that requires a
 * key (docs/PRODUCT_ROADMAP.md F1.1).
 *
 * This is deliberately a SEPARATE class from HlAdapter. HlAdapter holds the
 * signing key and can move money; this one can only read, takes the account as
 * a parameter, and is safe to expose on a public host. Keeping those two
 * surfaces in different files is the cheapest possible way to make sure a
 * read-only deployment can never accidentally be a trading one.
 *
 * Every call is hashed on the way in and out. That is not decoration: the
 * shadow report quotes venue data, and a reader should be able to see exactly
 * which bytes produced a verdict.
 */

import { createHash } from "node:crypto";
import type { CashFlow, MarketMeta, ReplayFill } from "@vetoos/replay";

export type PublicNetwork = "mainnet" | "testnet";

const ENDPOINTS: Record<PublicNetwork, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};

/** One open perp position, as the venue reports it right now. */
export interface OpenPosition {
  coin: string;
  /** Signed size. Positive is long, negative is short. */
  size: number;
  entryPx: number;
  unrealizedPnlUsd: number;
  positionValueUsd: number;
}

export interface PublicReadProvenance {
  endpoint: string;
  requestHash: string;
  responseHash: string;
  fetchedAt: number;
  bytes: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class PublicReader {
  private readonly url: string;
  /** Per-call hashes, so the report can name the exact bytes it read. */
  readonly provenance: PublicReadProvenance[] = [];

  constructor(
    network: PublicNetwork = "mainnet",
    url?: string,
    private readonly attempts = 4,
  ) {
    this.url = url ?? ENDPOINTS[network];
  }

  /** POST to the info endpoint with bounded retries on the venue's rate limits. */
  private async info<T>(body: Record<string, unknown>): Promise<T> {
    const request = JSON.stringify(body);
    let lastError: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        const res = await fetch(this.url + "/info", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: request,
        });
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
          continue;
        }
        const text = await res.text();
        if (!res.ok) throw new Error("venue " + res.status + ": " + text.slice(0, 200));
        this.provenance.push({
          endpoint: this.url + "/info",
          requestHash: sha256(request),
          responseHash: sha256(text),
          fetchedAt: Date.now(),
          bytes: text.length,
        });
        return JSON.parse(text) as T;
      } catch (err) {
        lastError = err;
        if (attempt === this.attempts - 1) break;
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    throw new Error("public read failed: " + String(lastError instanceof Error ? lastError.message : lastError));
  }

  /**
   * The account's own fills — the raw material of a shadow report. The venue
   * caps this at the most recent 2000 per call, which is plenty for a first
   * look and is stated in the report rather than silently truncated.
   */
  async getUserFills(user: string, limit = 2000): Promise<ReplayFill[]> {
    const raw = await this.info<RawFill[]>({ type: "userFills", user });
    return raw
      .slice(0, limit)
      .map((f) => ({
        time: Number(f.time),
        coin: f.coin,
        side: (f.side === "B" ? "buy" : "sell") as "buy" | "sell",
        px: Number(f.px),
        sz: Number(f.sz),
        closedPnl: Number(f.closedPnl ?? 0),
        fee: Number(f.fee ?? 0),
        startPosition: Number(f.startPosition ?? 0),
        dir: String(f.dir ?? ""),
        oid: Number(f.oid),
      }))
      .sort((a, b) => a.time - b.time);
  }

  /** Current account value: the anchor the equity walk starts from. */
  async getAccountValue(user: string, dex?: string | null): Promise<number> {
    const state = await this.clearinghouse(user, dex);
    return state.equityUsd;
  }

  /**
   * Account value plus open positions for one clearinghouse.
   * The main book is `dex` omitted; a builder dex such as "xyz" is its own book.
   */
  async clearinghouse(user: string, dex?: string | null): Promise<{ equityUsd: number; positions: OpenPosition[] }> {
    const state = await this.info<RawClearinghouse>({
      type: "clearinghouseState",
      user,
      ...(dex ? { dex } : {}),
    });
    const positions: OpenPosition[] = [];
    for (const row of state.assetPositions ?? []) {
      const position = row.position;
      if (!position?.coin) continue;
      const size = Number(position.szi ?? 0);
      if (!Number.isFinite(size) || size === 0) continue;
      positions.push({
        coin: position.coin,
        size,
        entryPx: Number(position.entryPx ?? 0),
        unrealizedPnlUsd: Number(position.unrealizedPnl ?? 0),
        positionValueUsd: Number(position.positionValue ?? 0),
      });
    }
    return { equityUsd: Number(state.marginSummary?.accountValue ?? 0), positions };
  }

  /** szDecimals and maxLeverage per coin — needed to size and price honestly. */
  async getMeta(): Promise<Record<string, MarketMeta>> {
    const meta = await this.info<{ universe: { name: string; szDecimals: number; maxLeverage: number }[] }>({
      type: "meta",
    });
    const out: Record<string, MarketMeta> = {};
    for (const asset of meta.universe) {
      out[asset.name] = { szDecimals: asset.szDecimals, maxLeverage: asset.maxLeverage };
    }
    return out;
  }

  /** Funding payments — they move the account value and must be in the walk. */
  async getUserFunding(user: string, since: number): Promise<CashFlow[]> {
    const raw = await this.info<{ time: number; delta: { usdc?: string } }[]>({
      type: "userFunding",
      user,
      startTime: since,
    });
    return raw.map((f) => ({ time: Number(f.time), usdc: Number(f.delta?.usdc ?? 0) }));
  }

  /** Deposits, withdrawals and transfers — the rest of the account-value walk. */
  async getUserLedger(user: string, since: number): Promise<CashFlow[]> {
    const raw = await this.info<{ time: number; delta: { usdc?: string } }[]>({
      type: "userNonFundingLedgerUpdates",
      user,
      startTime: since,
    });
    return raw
      .map((f) => ({ time: Number(f.time), usdc: Number(f.delta?.usdc ?? 0) }))
      .filter((f) => Number.isFinite(f.usdc) && f.usdc !== 0);
  }
}

interface RawClearinghouse {
  marginSummary?: { accountValue?: string };
  assetPositions?: {
    position?: {
      coin?: string;
      szi?: string;
      entryPx?: string;
      unrealizedPnl?: string;
      positionValue?: string;
    };
  }[];
}

interface RawFill {
  time: number;
  coin: string;
  side: string;
  px: string;
  sz: string;
  closedPnl?: string;
  fee?: string;
  startPosition?: string;
  dir?: string;
  oid: number;
}
