/**
 * RiskBroker — the single signing exit. Strategies and AI proposers submit
 * intents; this process is the only one holding keys, applying deterministic
 * rules, placing orders, and reconciling fills against the venue.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HlAdapter,
  intentIdToCloid,
  parseMarket,
  type Network,
  type PlacedOrder,
} from "@vetoos/adapter-hl";
import {
  AuditLog,
  commitmentHash,
  hashOf,
  type AuditEvent,
  type ReceiptFields,
} from "@vetoos/audit";
import { validateIntent, type Intent } from "@vetoos/intent";
import {
  ENGINE_VERSION,
  RULESET_HASH,
  buildDecisionInput,
  canonicalDecisionInput,
  contextFromDecisionInput,
  decisionInputHash,
  evaluateIntent,
  verdictHashOf,
  type Decision,
  type DecisionInput,
  type HistoryEvent,
  type LoadedPolicy,
  type MarketSource,
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

interface ProcessedRecord {
  decision: Decision;
  placed?: PlacedOrder;
  reconcileOk?: boolean;
  /** Set when the write path threw — outcome at the venue is unknown, never retried. */
  error?: string;
  ts: number;
}

/** How long a venue-sourced daily PnL figure is trusted before re-reading. */
const DAILY_PNL_TTL_MS = 10_000;

interface BrokerState {
  frozen: boolean;
  freezeReason?: string;
  /** Receipt that froze the broker — a human unfreeze must be bound to it. */
  freezeReceipt?: { seq: number; hash: string };
  /** One-time unfreeze authorisations already spent (replay protection). */
  usedUnfreezeNonces?: string[];
  history: HistoryEvent[];
  /** Position baseline for whole-session reconciliation. */
  baseline?: { market: string; size: number; ts: number };
  dailyRealizedPnlUsd: number;
  day: string;
  /** Idempotency: intent id → outcome. Retries never double-fill. */
  processed: Record<string, ProcessedRecord>;
}

export interface SubmitResult {
  validationError?: string;
  decision?: Decision;
  placed?: PlacedOrder;
  reconcile?: ReconcileResult;
  /** True when this intent id was already processed — returned from cache. */
  duplicate?: boolean;
  /** Write-path failure after an allow; the intent is burned, not retried. */
  error?: string;
}

const MAX_PROCESSED = 500;

export class RiskBroker {
  private readonly statePath: string;
  private state: BrokerState;
  /** Intent ids currently being processed → shared promise (concurrent dedupe). */
  private readonly inFlight = new Map<string, Promise<SubmitResult>>();
  private dailyPnlRefreshedAt = 0;
  /** Advice committed before the current decision, bound into its receipt. */
  private pendingAdviceHash?: string;

  private readonly inputsDir: string;
  /** Canonical hash of the parsed rules (same rules ⇒ same digest, whatever the file formatting). */
  readonly policySemanticHash: string;

  constructor(
    private readonly policy: LoadedPolicy,
    private readonly adapter: HlAdapter,
    private readonly audit: AuditLog,
    stateDir: string,
    readonly ledger: LedgerStore = new LedgerStore(join(stateDir, "ledger.jsonl")),
    /** Optional receipt signer (authenticity layer). Never the trading key. */
    private readonly receiptSigner?: (payload: string) => { sig: string; signer: string },
  ) {
    this.statePath = join(stateDir, "broker-state.json");
    this.inputsDir = join(stateDir, "inputs");
    this.policySemanticHash = hashOf(policy.policy);
    this.state = this.loadState();
  }

  /** Receipt fields every verdict carries: which rules, and which code, produced it. */
  private baseReceipt(): ReceiptFields {
    return {
      policyBytesHash: this.policy.contentHash,
      policySemanticHash: this.policySemanticHash,
      engineVersion: ENGINE_VERSION,
      rulesetHash: RULESET_HASH,
    };
  }

  /** Record a receipt, signing it when a receipt key is configured. */
  private recordReceipt(
    type: Parameters<AuditLog["record"]>[0],
    data: Record<string, unknown>,
    line: string,
    receipt: ReceiptFields,
  ): AuditEvent {
    if (this.receiptSigner) {
      const event = this.audit.recordSigned(type, data, receipt, this.receiptSigner);
      this.audit.say(line);
      return event;
    }
    return this.audit.recordAndSay(type, data, line, receipt);
  }

  /**
   * Archive the full decision input under its content address and return the
   * hash. Content-addressed, so re-writing the same input is a no-op.
   */
  private archiveDecisionInput(input: DecisionInput): string {
    const inputsHash = decisionInputHash(input);
    mkdirSync(this.inputsDir, { recursive: true });
    const file = join(this.inputsDir, inputsHash + ".json");
    if (!existsSync(file)) {
      writeFileSync(file, canonicalDecisionInput(input), "utf8");
    }
    return inputsHash;
  }

  private loadState(): BrokerState {
    const today = new Date().toISOString().slice(0, 10);
    if (existsSync(this.statePath)) {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as BrokerState;
      if (parsed.day !== today) {
        parsed.dailyRealizedPnlUsd = 0;
        parsed.day = today;
      }
      parsed.processed ??= {};
      return parsed;
    }
    return {
      frozen: false,
      history: [],
      dailyRealizedPnlUsd: 0,
      day: today,
      processed: {},
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
    await this.refreshDailyPnl(true);
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

  /**
   * The guard windows as the engine sees them. Exposed so tests can assert the
   * invariant that matters: this MUST equal projectHistory(receipts) — the
   * state is a projection of the log, not a second source of truth.
   */
  history(): HistoryEvent[] {
    return [...this.state.history];
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

  /** Submissions (intents + fills) in the trailing minute — the rate guard's counter. */
  submissionsLastMinute(): number {
    const cutoff = Date.now() - 60_000;
    return this.state.history.filter(
      (h) => (h.kind === "intent" || h.kind === "fill") && h.ts >= cutoff,
    ).length;
  }

  /** Timestamp of the most recent deny, if any (cooldown derives from it). */
  lastDenyTs(): number | undefined {
    return this.state.history
      .filter((h) => h.kind === "deny")
      .reduce<number | undefined>((acc, h) => (acc === undefined || h.ts > acc ? h.ts : acc), undefined);
  }

  /** Denies in the trailing hour — discipline pressure for the risk radar. */
  deniesLastHour(): number {
    const cutoff = Date.now() - 3_600_000;
    return this.state.history.filter((h) => h.kind === "deny" && h.ts >= cutoff).length;
  }

  get dailyRealizedPnlUsd(): number {
    return this.state.dailyRealizedPnlUsd;
  }

  /**
   * Daily-loss breaker input, sourced from the VENUE (userFills closedPnl −
   * fees since 00:00 UTC). Cached briefly; `force` bypasses the TTL. A read
   * failure keeps the last-known figure and is written to the audit log —
   * the breaker degrades to "stale" rather than silently resetting to zero.
   */
  async refreshDailyPnl(force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - this.dailyPnlRefreshedAt < DAILY_PNL_TTL_MS) {
      return this.state.dailyRealizedPnlUsd;
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const dayStartMs = Date.parse(`${today}T00:00:00.000Z`);
    try {
      const pnl = await this.adapter.getRealizedPnlSince(WRITE_NETWORK, dayStartMs);
      this.state.dailyRealizedPnlUsd = pnl;
      this.state.day = today;
      this.dailyPnlRefreshedAt = now;
      this.saveState();
    } catch (err) {
      this.audit.record("error", {
        where: "refreshDailyPnl",
        error: err instanceof Error ? err.message : String(err),
        lastKnown: this.state.dailyRealizedPnlUsd,
      });
    }
    return this.state.dailyRealizedPnlUsd;
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

    // Idempotency: a retried intent id returns its recorded outcome instead
    // of being evaluated — and potentially filled — twice.
    const seen = this.state.processed[intent.id];
    if (seen) {
      this.audit.recordAndSay(
        "decision",
        { intent_id: intent.id, duplicate: true, code: seen.decision.code },
        `[dup] 幂等命中 / intent ${intent.id.slice(0, 8)}… already processed (${seen.decision.code}), returning cached outcome`,
      );
      return {
        decision: seen.decision,
        ...(seen.placed ? { placed: seen.placed } : {}),
        ...(seen.error ? { error: seen.error } : {}),
        duplicate: true,
      };
    }

    // Concurrent duplicates: two submissions of the same id racing through
    // the async venue reads must share ONE evaluation and ONE order.
    const running = this.inFlight.get(intent.id);
    if (running) {
      this.audit.record("decision", { intent_id: intent.id, duplicate: true, concurrent: true });
      return running.then((r) => ({ ...r, duplicate: true }));
    }
    const task = this.processIntent(intent).finally(() => this.inFlight.delete(intent.id));
    this.inFlight.set(intent.id, task);
    return task;
  }

  private async processIntent(intent: Intent): Promise<SubmitResult> {
    const now = Date.now();
    this.pushHistory({ ts: now, market: intent.market, side: intent.side, kind: "intent" });
    // `at` is the broker's own clock for this event: the receipt chain is the
    // source of truth for the guard windows, so the timestamp must live here
    // (projectHistory rebuilds the engine's history from exactly this field).
    this.audit.record("intent_received", { intent, at: now });

    // 2. Gather REAL inputs for the deterministic engine.
    const snapshot = await this.adapter.getMarketSnapshot(intent.market, READ_NETWORK, intent.side);
    // Builder dexes have their own clearinghouse: equity, margin and the
    // position for "xyz:XYZ100" live under dex "xyz", not the main book.
    const parsed = parseMarket(intent.market);
    const account = await this.adapter.getAccountState(WRITE_NETWORK, parsed.dex);
    await this.refreshDailyPnl();
    // Read and write networks can quote different marks. Caps (notional,
    // leverage, margin) are evaluated at the HIGHER of the two so a cheaper
    // read-side mark can never let a larger-than-allowed order through.
    const execMark = await this.executionMark(intent.market);
    const evalMark = Math.max(snapshot.markPx, execMark ?? 0);
    // Venue position keys may be "BTC" or "xyz:XYZ100" — match both forms.
    let positionSize = 0;
    for (const [coin, szi] of account.positions) {
      if (coin === parsed.venueCoin || coin === parsed.coin) {
        positionSize = szi;
        break;
      }
    }
    const evalMarket = {
      market: intent.market,
      markPx: evalMark,
      funding: snapshot.funding,
      openInterest: snapshot.openInterest,
      depthWithinBand: snapshot.depthWithinBand,
      szDecimals: snapshot.szDecimals,
    };
    const evalAccount = {
      equityUsd: account.equityUsd,
      availableMarginUsd: account.availableMarginUsd,
      dailyRealizedPnlUsd: this.state.dailyRealizedPnlUsd,
      currentPositionNotionalUsd: Math.abs(positionSize) * evalMark,
      currentPositionSize: positionSize,
    };
    // Freeze of the guard windows exactly as the engine will see them.
    const evalHistory = [...this.state.history];
    const marketSource: MarketSource = {
      readNetwork: READ_NETWORK,
      writeNetwork: WRITE_NETWORK,
      evalMarkPx: evalMark,
      readMarkPx: snapshot.markPx,
      writeMarkPx: execMark,
      readAt: now,
      market: intent.market,
      dex: parsed.dex,
      assetId: snapshot.assetId,
    };
    const ctx = {
      now,
      frozen: this.state.frozen,
      freezeReason: this.state.freezeReason,
      market: evalMarket,
      account: evalAccount,
      history: evalHistory,
    };

    // 3. Deterministic evaluation — the model never gets a vote here.
    const decision = evaluateIntent(intent, this.policy.policy, ctx);
    decision.snapshot["mark_px_read"] = snapshot.markPx;
    decision.snapshot["mark_px_write"] = execMark;

    // 3a. Verifiable decision record: archive the FULL input under its content
    // address and bind the verdict to it. Anyone can re-run evaluateIntent on
    // the archived input and must reproduce this exact verdict + rule trace.
    const decisionInput = buildDecisionInput({
      intent,
      policy: this.policy.policy,
      policyBytesHash: this.policy.contentHash,
      market: evalMarket,
      account: evalAccount,
      history: evalHistory,
      frozen: this.state.frozen,
      ...(this.state.freezeReason !== undefined ? { freezeReason: this.state.freezeReason } : {}),
      now,
      marketSource,
    });
    const inputsHash = this.archiveDecisionInput(decisionInput);
    const verdictHash = verdictHashOf(decision);
    // The commitment is consumed by exactly one verdict.
    const adviceHash = this.pendingAdviceHash;
    this.pendingAdviceHash = undefined;
    this.recordReceipt(
      "decision",
      { intent_id: intent.id, ...decision },
      `[${decision.decision}] ${decision.message_zh} / ${decision.message_en}`,
      {
        ...this.baseReceipt(),
        inputsHash,
        verdictHash,
        ...(adviceHash ? { aiAdviceHash: adviceHash } : {}),
      },
    );
    if (decision.decision === "deny") {
      this.pushHistory({ ts: now, market: intent.market, side: intent.side, kind: "deny" });
      this.recordProcessed(intent.id, { decision, ts: now });
      this.saveState();
      return { decision };
    }

    // 4. Allowed → real testnet fill, wrapped by position snapshots.
    const positionBefore = await this.adapter.getPositionSize(intent.market, WRITE_NETWORK);

    // 4a. Last look before signing: a reconcile/tamper on another request may
    // have frozen the broker while we were awaiting venue reads. The freeze
    // rule runs first in the engine, so re-evaluating yields a FROZEN deny.
    if (this.state.frozen) {
      const late = evaluateIntent(intent, this.policy.policy, {
        ...ctx,
        now: Date.now(),
        frozen: true,
        freezeReason: this.state.freezeReason,
      });
      // The late freeze is a verdict too — give it the same treatment as the
      // first evaluation so the frozen decision is itself reproducible.
      const lateNow = Date.now();
      const lateInput = buildDecisionInput({
        intent,
        policy: this.policy.policy,
        policyBytesHash: this.policy.contentHash,
        market: evalMarket,
        account: evalAccount,
        history: evalHistory,
        frozen: true,
        ...(this.state.freezeReason !== undefined ? { freezeReason: this.state.freezeReason } : {}),
        now: lateNow,
        marketSource,
      });
      this.recordReceipt(
        "decision",
        { intent_id: intent.id, late_freeze_check: true, ...late },
        `[deny] 签名前复查：已冻结 / frozen between evaluation and signing — order not sent`,
        {
          ...this.baseReceipt(),
          inputsHash: this.archiveDecisionInput(lateInput),
          verdictHash: verdictHashOf(late),
        },
      );
      this.pushHistory({ ts: Date.now(), market: intent.market, side: intent.side, kind: "deny" });
      this.recordProcessed(intent.id, { decision: late, ts: now });
      this.saveState();
      return { decision: late };
    }

    let placed: PlacedOrder;
    try {
      placed = await this.adapter.placeOrder({
        market: intent.market,
        side: intent.side,
        size: Number(intent.size),
        ...(intent.limit_px !== undefined ? { limitPx: intent.limit_px } : {}),
        reduceOnly: intent.reduce_only,
        cloid: intentIdToCloid(intent.id),
      });
    } catch (err) {
      // Write failed (or timed out — outcome unknown). The intent id is
      // burned: a retry returns this record instead of re-sending, and the
      // next reconciliation window settles what really happened.
      const message = err instanceof Error ? err.message : String(err);
      // Outcome at the venue is UNKNOWN — record it against the verdict that
      // authorised the attempt, so a later reconciliation has something to
      // settle against instead of an unexplained gap.
      this.recordReceipt(
        "error",
        { where: "placeOrder", intent_id: intent.id, error: message },
        `[error] 下单失败，意图作废不重试 / order write failed, intent burned: ${message}`,
        { ...this.baseReceipt(), inputsHash, verdictHash },
      );
      this.recordProcessed(intent.id, { decision, error: message, ts: now });
      this.saveState();
      return { decision, error: message };
    }
    const orderAt = Date.now();
    if (placed.filledSize > 0) {
      // Only REAL fills count — a resting/unfilled order must never feed
      // the FOMO counter or the ledger.
      this.pushHistory({ ts: orderAt, market: intent.market, side: intent.side, kind: "fill" });
      this.recordReceipt(
        "order_placed",
        { intent_id: intent.id, market: intent.market, side: intent.side, at: orderAt, ...placed },
        `[fill] 测试网成交 / testnet fill: ${placed.filledSize} @ ${placed.avgPx} (oid ${placed.oid})`,
        { ...this.baseReceipt(), inputsHash, verdictHash, orderIds: [placed.oid] },
      );
    } else {
      this.recordReceipt(
        "order_placed",
        { intent_id: intent.id, market: intent.market, side: intent.side, at: orderAt, ...placed },
        `[order] 未成交 / allowed but not filled (status ${placed.status}, oid ${placed.oid})`,
        { ...this.baseReceipt(), inputsHash, verdictHash, orderIds: [placed.oid] },
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
      // A fill can realise PnL (closing/flipping) — pull the venue figure now
      // so the very next intent sees an up-to-date daily-loss breaker.
      await this.refreshDailyPnl(true);
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
    this.recordProcessed(intent.id, { decision, placed, reconcileOk: reconcile.ok, ts: now });
    this.saveState();
    return { decision, placed, reconcile };
  }

  /** Mark on the execution (write) network; null when unavailable or same network. */
  private async executionMark(market: string): Promise<number | null> {
    if (READ_NETWORK === (WRITE_NETWORK as Network)) return null;
    try {
      const ctx = await this.adapter.getMarketContext(market, WRITE_NETWORK);
      return ctx.markPx;
    } catch {
      return null; // caps then fall back to the read-side mark (still real data)
    }
  }

  private recordProcessed(intentId: string, rec: ProcessedRecord): void {
    this.state.processed[intentId] = rec;
    const ids = Object.keys(this.state.processed);
    if (ids.length > MAX_PROCESSED) {
      const oldestFirst = ids.sort(
        (a, b) => (this.state.processed[a]?.ts ?? 0) - (this.state.processed[b]?.ts ?? 0),
      );
      for (const id of oldestFirst.slice(0, ids.length - MAX_PROCESSED)) {
        delete this.state.processed[id];
      }
    }
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
    let baseline = this.state.baseline;
    if (baseline && baseline.market !== market) {
      // A baseline for another market says nothing about this one; re-anchor
      // rather than compare apples to oranges.
      await this.setBaseline(market);
      baseline = this.state.baseline;
    }
    const anchor = baseline ?? { market, size: 0, ts: 0 };
    // Only this market's fills may explain this market's position change —
    // a fill on xyz:XYZ100 must never be netted against the BTC position.
    const fills = this.ledger.since(anchor.ts).filter((f) => f.market === market);
    return this.reconcileWindow(market, anchor.size, fills);
  }

  async setBaseline(market: string): Promise<void> {
    const size = await this.adapter.getPositionSize(market, WRITE_NETWORK);
    this.state.baseline = { market, size, ts: Date.now() };
    this.saveState();
  }

  freeze(reason: string): void {
    this.state.frozen = true;
    this.state.freezeReason = reason;
    // Bind the freeze to its own receipt: a human unfreeze must name THIS
    // freeze, so an old authorisation can never release a later one.
    const event = this.recordReceipt(
      "freeze",
      { reason },
      `[freeze] 总闸冻结 / BROKER FROZEN: ${reason}`,
      this.baseReceipt(),
    );
    this.state.freezeReceipt = { seq: event.seq, hash: event.hash };
    this.saveState();
    this.notifyFreeze(reason);
  }

  /** The state a human unfreeze must be cryptographically bound to. */
  freezeBinding(): { seq: number; hash: string } | null {
    if (!this.state.frozen) return null;
    if (this.state.freezeReceipt) return this.state.freezeReceipt;
    const head = this.audit.head;
    return { seq: head.seq, hash: head.hash };
  }

  /** Optional outbound alert. Failure is audited and never blocks the freeze. */
  private notifyFreeze(reason: string): void {
    const raw = process.env.VETOOS_FREEZE_WEBHOOK;
    if (!raw) return;
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return;
    void fetch(target.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "vetoos.freeze",
        reason,
        ts: new Date().toISOString(),
        policyHash: this.policy.contentHash,
      }),
    }).catch((err: unknown) => {
      this.audit.record("error", {
        where: "freezeWebhook",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Human-only escape hatch. There is no API for a model to call here.
   *
   * `auth` carries a wallet signature over the CURRENT freeze binding plus a
   * one-time nonce; it is recorded in the unfreeze receipt so "who released
   * which freeze" is independently checkable. The local token path (CLI)
   * passes no auth and is labelled as such.
   */
  unfreeze(
    confirmation: string,
    auth?: { address: string; signature: string; nonce: string; boundTo: string },
  ): void {
    if (confirmation !== "I_AM_HUMAN") {
      throw new Error('unfreeze requires explicit human confirmation: --confirm I_AM_HUMAN');
    }
    if (auth) {
      const used = this.state.usedUnfreezeNonces ?? [];
      if (used.includes(auth.nonce)) {
        throw new Error("unfreeze authorisation already spent (nonce replayed)");
      }
      const binding = this.state.freezeReceipt;
      const expected = binding ? String(binding.seq) : "";
      if (!binding || auth.boundTo !== expected) {
        throw new Error(
          `unfreeze authorisation is not bound to the current freeze (expected seq ${expected || "none"}, got ${auth.boundTo})`,
        );
      }
      this.state.usedUnfreezeNonces = [...used, auth.nonce].slice(-100);
    }
    const receipt = {
      ...this.baseReceipt(),
      ...(auth
        ? {
            humanAuth: {
              address: auth.address,
              signature: auth.signature,
              boundTo: auth.boundTo,
            },
          }
        : {}),
    };
    this.state.frozen = false;
    delete this.state.freezeReason;
    // A human reset also clears the tampered ledger window for a fresh start.
    this.state.baseline = undefined;
    this.state.freezeReceipt = undefined;
    this.saveState();
    this.recordReceipt(
      "unfreeze",
      { via: auth ? "wallet-signature" : "local-token", ...(auth ? { signer: auth.address } : {}) },
      `[unfreeze] 人工解冻 / human unfreeze confirmed (${auth ? "wallet-signature" : "local-token"})`,
      receipt,
    );
  }

  /**
   * AI commit phase: lock in the advice digest BEFORE the verdict exists.
   * The verdict that follows binds this hash into its receipt, so the advice
   * cannot be rewritten (or quietly dropped) once the outcome is known.
   */
  commitAdvice(
    adviceHash: string,
    meta: { modelId?: string; promptHash?: string } = {},
  ): AuditEvent {
    this.pendingAdviceHash = adviceHash;
    return this.recordReceipt(
      "ai_commit",
      { adviceHash, ...meta },
      `[ai] 建议已承诺 / advice committed ${adviceHash.slice(0, 12)}… (model ${meta.modelId ?? "n/a"})`,
      { ...this.baseReceipt(), aiAdviceHash: adviceHash },
    );
  }

  /**
   * AI reveal phase: publish the advice that opens the earlier commitment.
   * Rejects a reveal whose (nonce, advice) does not reproduce the committed
   * digest, or one that no verdict ever bound — both are dishonest history.
   */
  revealAdvice(nonce: string, advice: unknown): AuditEvent {
    const adviceHash = commitmentHash(nonce, advice);
    const bound = this.audit.events().some((e) => e.aiAdviceHash === adviceHash);
    if (!bound) {
      throw new Error(
        "reveal does not match any committed advice bound to a verdict (wrong nonce, or never committed)",
      );
    }
    return this.recordReceipt(
      "ai_reveal",
      { adviceHash, nonce, advice },
      `[ai] 建议已揭示 / advice revealed ${adviceHash.slice(0, 12)}…`,
      { ...this.baseReceipt(), aiAdviceHash: adviceHash },
    );
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
