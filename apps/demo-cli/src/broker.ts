/**
 * RiskBroker — the single signing exit. Strategies and AI proposers submit
 * intents; this process is the only one holding keys, applying deterministic
 * rules, placing orders, and reconciling fills against the venue.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HlAdapter, parseMarket, type Network, type PlacedOrder } from "@vetoos/adapter-hl";
import { AuditLog } from "@vetoos/audit";
import { validateIntent, type Intent } from "@vetoos/intent";
import {
  evaluateIntent,
  type Decision,
  type HistoryEvent,
  type LoadedPolicy,
} from "@vetoos/risk";
import {
  LedgerStore,
  reconcileFills,
  type FillRecord,
  type ReconcileResult,
} from "@vetoos/truth";

export const READ_NETWORK: Network = "mainnet"; // real HIP-3 data drives vetoes
export const WRITE_NETWORK: Network = "testnet"; // real fills, controlled size

const RECONCILE_TOLERANCE_PCT = 0.005; // 0.5% or 1 lot, whichever is larger

interface BrokerState {
  frozen: boolean;
  freezeReason?: string;
  history: HistoryEvent[];
  /** Position baseline for whole-session reconciliation. */
  baseline?: { market: string; size: number; ts: number };
  dailyRealizedPnlUsd: number;
  day: string;
}

export interface SubmitResult {
  validationError?: string;
  decision?: Decision;
  placed?: PlacedOrder;
  reconcile?: ReconcileResult;
}

export class RiskBroker {
  private readonly statePath: string;
  private state: BrokerState;

  constructor(
    private readonly policy: LoadedPolicy,
    private readonly adapter: HlAdapter,
    private readonly audit: AuditLog,
    stateDir: string,
    readonly ledger: LedgerStore = new LedgerStore(join(stateDir, "ledger.jsonl")),
  ) {
    this.statePath = join(stateDir, "broker-state.json");
    this.state = this.loadState();
  }

  private loadState(): BrokerState {
    const today = new Date().toISOString().slice(0, 10);
    if (existsSync(this.statePath)) {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as BrokerState;
      if (parsed.day !== today) {
        parsed.dailyRealizedPnlUsd = 0;
        parsed.day = today;
      }
      return parsed;
    }
    return {
      frozen: false,
      history: [],
      dailyRealizedPnlUsd: 0,
      day: today,
    };
  }

  private saveState(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  get frozen(): boolean {
    return this.state.frozen;
  }

  /**
   * Fail-closed startup: the broker refuses to run unless it can pull the
   * real HIP-3 market context it will evaluate against.
   */
  async init(): Promise<void> {
    const market = this.policy.policy.default_market;
    const ctx = await this.adapter.getMarketContext(market, READ_NETWORK);
    this.audit.recordAndSay(
      "startup",
      {
        policy: this.policy.path,
        market,
        asset_id: ctx.assetId,
        mark_px: ctx.markPx,
        funding: ctx.funding,
        open_interest: ctx.openInterest,
      },
      `[startup] policy ${this.policy.contentHash.slice(0, 12)}… loaded; ` +
        `real ${market} context OK (mark ${ctx.markPx}, OI ${ctx.openInterest})`,
    );
  }

  /** Snapshot of everything the demo/status command needs to show. */
  status(): Record<string, unknown> {
    return {
      frozen: this.state.frozen,
      freezeReason: this.state.freezeReason,
      policyHash: this.policy.contentHash,
      ledgerFills: this.ledger.list().length,
      historyEvents: this.state.history.length,
      baseline: this.state.baseline,
    };
  }

  private pushHistory(event: HistoryEvent): void {
    this.state.history.push(event);
    // Keep the state file small: trailing 24h is plenty for every guard.
    const cutoff = Date.now() - 24 * 3_600_000;
    this.state.history = this.state.history.filter((h) => h.ts >= cutoff);
  }

  /** Same-side fills in the trailing hour — the FOMO guard's counter. */
  sameSideFillsLastHour(market: string, side: "buy" | "sell"): number {
    const cutoff = Date.now() - 3_600_000;
    return this.state.history.filter(
      (h) => h.kind === "fill" && h.market === market && h.side === side && h.ts >= cutoff,
    ).length;
  }

  async submitIntent(raw: unknown): Promise<SubmitResult> {
    // 1. Intent IR validation — tampering attempts die here.
    const validation = validateIntent(raw);
    if (!validation.ok) {
      this.audit.recordAndSay(
        "decision",
        { error: validation.error, raw },
        `[deny] 意图不合法 / invalid intent: ${validation.error}`,
      );
      return { validationError: validation.error };
    }
    const intent = validation.intent;
    const now = Date.now();
    this.pushHistory({ ts: now, market: intent.market, side: intent.side, kind: "intent" });
    this.audit.record("intent_received", { intent });

    // 2. Gather REAL inputs for the deterministic engine.
    const snapshot = await this.adapter.getMarketSnapshot(intent.market, READ_NETWORK, intent.side);
    const account = await this.adapter.getAccountState(WRITE_NETWORK);
    // Venue position keys may be "BTC" or "xyz:XYZ100" — match both forms.
    const parsed = parseMarket(intent.market);
    let positionSize = 0;
    for (const [coin, szi] of account.positions) {
      if (coin === parsed.venueCoin || coin === parsed.coin) {
        positionSize = szi;
        break;
      }
    }
    const ctx = {
      now,
      frozen: this.state.frozen,
      freezeReason: this.state.freezeReason,
      market: {
        market: intent.market,
        markPx: snapshot.markPx,
        funding: snapshot.funding,
        openInterest: snapshot.openInterest,
        depthWithinBand: snapshot.depthWithinBand,
        szDecimals: snapshot.szDecimals,
      },
      account: {
        equityUsd: account.equityUsd,
        availableMarginUsd: account.availableMarginUsd,
        dailyRealizedPnlUsd: this.state.dailyRealizedPnlUsd,
        currentPositionNotionalUsd: Math.abs(positionSize) * snapshot.markPx,
      },
      history: this.state.history,
    };

    // 3. Deterministic evaluation — the model never gets a vote here.
    const decision = evaluateIntent(intent, this.policy.policy, ctx);
    this.audit.recordAndSay(
      "decision",
      { intent_id: intent.id, ...decision },
      `[${decision.decision}] ${decision.message_zh} / ${decision.message_en}`,
    );
    if (decision.decision === "deny") {
      this.pushHistory({ ts: now, market: intent.market, side: intent.side, kind: "deny" });
      this.saveState();
      return { decision };
    }

    // 4. Allowed → real testnet fill, wrapped by position snapshots.
    const positionBefore = await this.adapter.getPositionSize(intent.market, WRITE_NETWORK);
    const placed = await this.adapter.placeOrder({
      market: intent.market,
      side: intent.side,
      size: Number(intent.size),
      ...(intent.limit_px !== undefined ? { limitPx: intent.limit_px } : {}),
      reduceOnly: intent.reduce_only,
    });
    if (placed.filledSize > 0) {
      // Only REAL fills count — a resting/unfilled order must never feed
      // the FOMO counter or the ledger.
      this.pushHistory({ ts: Date.now(), market: intent.market, side: intent.side, kind: "fill" });
      this.audit.recordAndSay(
        "order_placed",
        { intent_id: intent.id, ...placed },
        `[fill] 测试网成交 / testnet fill: ${placed.filledSize} @ ${placed.avgPx} (oid ${placed.oid})`,
      );
    } else {
      this.audit.recordAndSay(
        "order_placed",
        { intent_id: intent.id, ...placed },
        `[order] 未成交 / allowed but not filled (status ${placed.status}, oid ${placed.oid})`,
      );
    }

    if (placed.filledSize > 0) {
      const fill: FillRecord = {
        intentId: intent.id,
        market: intent.market,
        side: intent.side,
        size: placed.filledSize,
        avgPx: placed.avgPx,
        oid: placed.oid,
        ts: Date.now(),
        szDecimals: snapshot.szDecimals,
      };
      this.ledger.append(fill);
    }

    // 5. Fill Truth: the venue, not the ledger, decides what happened.
    const reconcile = await this.reconcileWindow(intent.market, positionBefore, [
      {
        intentId: intent.id,
        market: intent.market,
        side: intent.side,
        size: placed.filledSize,
        avgPx: placed.avgPx,
        oid: placed.oid,
        ts: Date.now(),
        szDecimals: snapshot.szDecimals,
      },
    ]);
    this.saveState();
    return { decision, placed, reconcile };
  }

  private async reconcileWindow(
    market: string,
    positionBefore: number,
    fills: FillRecord[],
  ): Promise<ReconcileResult> {
    const positionAfter = await this.adapter.getPositionSize(market, WRITE_NETWORK);
    const szDecimals = fills[0]?.szDecimals ?? 4;
    const result = reconcileFills(fills, positionBefore, positionAfter, szDecimals, {
      tolerancePct: RECONCILE_TOLERANCE_PCT,
      freezeOnMismatch: this.policy.policy.freeze_on_reconcile_mismatch,
    });
    this.audit.record("reconcile", {
      market,
      positionBefore,
      positionAfter,
      fills: fills.length,
      ok: result.ok,
      mismatches: result.mismatches,
    });
    if (result.shouldFreeze) {
      this.freeze(result.reason_zh ?? "reconcile mismatch");
    } else {
      this.audit.say(`[truth] 账实相符 / ledger matches venue position (Δ ok)`);
    }
    return result;
  }

  /**
   * Whole-session reconciliation against the stored baseline — used by the
   * demo's tamper act and by `pnpm broker status --reconcile`.
   */
  async reconcileNow(market: string): Promise<ReconcileResult> {
    const baseline = this.state.baseline ?? { market, size: 0, ts: 0 };
    const fills = this.ledger.since(baseline.ts);
    return this.reconcileWindow(market, baseline.size, fills);
  }

  async setBaseline(market: string): Promise<void> {
    const size = await this.adapter.getPositionSize(market, WRITE_NETWORK);
    this.state.baseline = { market, size, ts: Date.now() };
    this.saveState();
  }

  freeze(reason: string): void {
    this.state.frozen = true;
    this.state.freezeReason = reason;
    this.saveState();
    this.audit.recordAndSay(
      "freeze",
      { reason },
      `[freeze] 总闸冻结 / BROKER FROZEN: ${reason}`,
    );
  }

  /** Human-only escape hatch. There is no API for a model to call here. */
  unfreeze(confirmation: string): void {
    if (confirmation !== "I_AM_HUMAN") {
      throw new Error('unfreeze requires explicit human confirmation: --confirm I_AM_HUMAN');
    }
    this.state.frozen = false;
    delete this.state.freezeReason;
    // A human reset also clears the tampered ledger window for a fresh start.
    this.state.baseline = undefined;
    this.saveState();
    this.audit.recordAndSay("unfreeze", {}, `[unfreeze] 人工解冻 / human unfreeze confirmed`);
  }

  /** DEMO ONLY: seed same-side history so the FOMO act fits in 3 minutes. */
  seedSyntheticFill(market: string, side: "buy" | "sell", count: number): void {
    for (let i = 0; i < count; i++) {
      this.pushHistory({ ts: Date.now() - (count - i) * 1000, market, side, kind: "fill" });
    }
    this.saveState();
    this.audit.record("intent_received", {
      synthetic: true,
      note: `seeded ${count} same-side fill events for the FOMO demo act`,
      market,
      side,
    });
  }
}
