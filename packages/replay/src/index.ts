/**
 * Shadow replay — what would the gate have done to YOUR trading?
 *
 * This is the onboarding wedge (docs/PRODUCT_ROADMAP.md F1.2): no keys, no
 * custody, no integration. Take a public address, pull its real fills, and
 * replay them through the SAME deterministic engine the broker uses, one fill
 * at a time, with the account state reconstructed as it was at that moment.
 *
 * Pure functions only — all I/O happens in the caller. That is what makes the
 * report itself auditable: same input, same verdicts.
 *
 * WHAT IS EXACT, WHAT IS RECONSTRUCTED, WHAT IS NOT EVALUATED
 * ----------------------------------------------------------
 * Exactly:        notional cap, same-side-add count, post-deny cool-down,
 *                 submission rate, daily realized loss (from closedPnl),
 *                 position notional (from startPosition + fills).
 * Reconstructed:  equity (walked back from today's account value using
 *                 realized PnL, fees, funding and ledger movements) → the
 *                 leverage and margin rules are therefore approximate.
 * Not evaluated:  book depth. Historical order books are not public, so the
 *                 depth rule is NEUTRALISED, never faked, and the report says
 *                 so on every row.
 *
 * A shadow report that hides these three categories is a sales pitch, not a
 * measurement. The caveats travel with the numbers.
 */

import type { Intent } from "@vetoos/intent";
import {
  evaluateIntent,
  type Decision,
  type HistoryEvent,
  type Policy,
  type TraceStep,
} from "@vetoos/risk";

/** One executed order, straight from the venue's public \`userFills\`. */
export interface ReplayFill {
  time: number;
  coin: string;
  /** "A" = ask/sell, "B" = bid/buy (venue convention). */
  side: "buy" | "sell";
  px: number;
  sz: number;
  closedPnl: number;
  fee: number;
  /** Position size BEFORE this fill — the venue gives us the state for free. */
  startPosition: number;
  dir: string;
  oid: number;
}

export interface CashFlow {
  time: number;
  usdc: number;
}

export interface MarketMeta {
  szDecimals: number;
  maxLeverage: number;
}

export interface ShadowInput {
  user: string;
  /** Rulebook to judge the history against. */
  policy: Policy;
  /** Canonical hash of that rulebook, carried into the report. */
  policySemanticHash: string;
  now: number;
  /** Today's account value — the anchor the equity walk starts from. */
  currentEquityUsd: number;
  /** Ascending by time. */
  fills: ReplayFill[];
  funding: CashFlow[];
  ledger: CashFlow[];
  /** szDecimals / maxLeverage per coin, from the venue's meta. */
  markets: Record<string, MarketMeta>;
  /** Neutralise the depth rule (no historical books exist). Default true. */
  depthUnavailable?: boolean;
}

export interface ShadowEpisode {
  ts: number;
  coin: string;
  side: "buy" | "sell";
  size: number;
  px: number;
  notionalUsd: number;
  decision: "allow" | "deny";
  code: string;
  message_en: string;
  trace: TraceStep[];
  /** Rules that could not be evaluated for this row, and why. */
  notEvaluated: string[];
  positionBefore: number;
  equityUsd: number;
  /** Equity reconstruction is approximate; the report says so. */
  equityIsReconstructed: boolean;
  oid: number;
  /** Realized PnL of the position layer this order opened, until it closed. */
  attributedPnlUsd?: number;
}

export interface ShadowReport {
  user: string;
  generatedAt: number;
  windowFrom: number;
  windowTo: number;
  policySemanticHash: string;
  fillsConsidered: number;
  markets: string[];
  episodes: ShadowEpisode[];
  blocked: ShadowEpisode[];
  summary: {
    totalOrders: number;
    allowed: number;
    blocked: number;
    blockedNotionalUsd: number;
    /** Sum of attributed PnL over blocked orders — negative means the gate saved money. */
    blockedAttributedPnlUsd: number;
    blockRate: number;
  };
  /** Who this account actually is, described before judging it. */
  profile: TradingProfile;
  caveats: string[];
}

export interface TradingProfile {
  spanMinutes: number;
  ordersPerMinuteP50: number;
  ordersPerMinuteP95: number;
  medianOrderNotionalUsd: number;
  p95OrderNotionalUsd: number;
  distinctMarkets: number;
  reduceOnlyShare: number;
  /** Rules whose limit this account exceeds, with the numbers on both sides. */
  bindingConstraints: string[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Describe the account before judging it.
 *
 * "99.6% of your orders would be refused" is true and useless for a market
 * maker: the binding limit is order RATE, not risk. Saying "your p95 rate is
 * 54 orders/min; this rulebook allows 10" is the same fact, made actionable.
 */
function buildProfile(fills: ReplayFill[], policy: Policy): TradingProfile {
  const notionals = fills.map((f) => f.sz * f.px).sort((a, b) => a - b);
  const spanMs = fills.length > 0 ? fills[fills.length - 1]!.time - fills[0]!.time : 0;
  const spanMinutes = Math.max(spanMs / 60_000, 1 / 60);

  // Rolling one-minute submission counts, sampled at each fill.
  const perMinute: number[] = [];
  let lo = 0;
  for (let hi = 0; hi < fills.length; hi++) {
    while (fills[hi]!.time - fills[lo]!.time > 60_000) lo++;
    perMinute.push(hi - lo + 1);
  }
  const sortedRates = [...perMinute].sort((a, b) => a - b);
  const p50Rate = quantile(sortedRates, 0.5);
  const p95Rate = quantile(sortedRates, 0.95);
  const p95Notional = quantile(notionals, 0.95);
  const medianNotional = quantile(notionals, 0.5);
  const reduceOnly = fills.filter((f) => f.dir.startsWith("Close") || f.dir === "Liquidated").length;

  const constraints: string[] = [];
  if (p95Rate > policy.max_orders_per_minute) {
    constraints.push(
      "order rate: your p95 is " + p95Rate.toFixed(0) + " orders/min, this rulebook allows " + policy.max_orders_per_minute,
    );
  }
  if (p95Notional > policy.max_order_notional_usd) {
    constraints.push(
      "order size: your p95 order is " +
        Math.round(p95Notional).toLocaleString("en-US") +
        " USD, this rulebook caps a single order at " +
        policy.max_order_notional_usd.toLocaleString("en-US"),
    );
  }

  return {
    spanMinutes,
    ordersPerMinuteP50: p50Rate,
    ordersPerMinuteP95: p95Rate,
    medianOrderNotionalUsd: medianNotional,
    p95OrderNotionalUsd: p95Notional,
    distinctMarkets: new Set(fills.map((f) => f.coin)).size,
    reduceOnlyShare: fills.length > 0 ? reduceOnly / fills.length : 0,
    bindingConstraints: constraints,
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Stand-in for "depth unknown" — the trace step for it is stripped from the report. */
const DEPTH_UNKNOWN = Number.MAX_SAFE_INTEGER / 4;

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Walk equity backwards from today's value so each replayed order is judged
 * against the account as it was, not as it is now.
 *
 *   equity(t) = equity_now − Σ_{after t}(closedPnl − fee) − Σ funding − Σ ledger
 *
 * Realized PnL and fees are exact (the venue reports them per fill). Funding
 * and ledger movements come from their own endpoints. Anything the venue does
 * not report (e.g. spot activity) makes this an approximation, and the report
 * labels it as one.
 */
function equityAt(
  t: number,
  currentEquityUsd: number,
  fills: ReplayFill[],
  funding: CashFlow[],
  ledger: CashFlow[],
): number {
  let delta = 0;
  for (const f of fills) {
    if (f.time > t) delta += f.closedPnl - f.fee;
  }
  for (const c of funding) {
    if (c.time > t) delta += c.usdc;
  }
  for (const c of ledger) {
    if (c.time > t) delta += c.usdc;
  }
  return currentEquityUsd - delta;
}

/**
 * What did the position layer opened by this order eventually earn or lose?
 *
 * Attribution rule: follow later fills on the same coin, summing closedPnl,
 * until the quantity opened here has been closed. A blocked order has no
 * closedPnl of its own, so this is the honest way to answer "and then what?".
 * It is reported with the sign it actually has — some blocked adds made money.
 */
function attributePnl(fill: ReplayFill, fills: ReplayFill[]): number | undefined {
  let remaining = fill.sz;
  let pnl = 0;
  for (const later of fills) {
    if (later.time <= fill.time || later.coin !== fill.coin) continue;
    // Only fills that REDUCE the layer we opened count towards closing it.
    const closedByThisFill = Math.min(remaining, later.sz);
    const share = later.sz > 0 ? closedByThisFill / later.sz : 0;
    pnl += later.closedPnl * share;
    remaining -= closedByThisFill;
    if (remaining <= 1e-12) return pnl;
  }
  // Never fully closed inside the window — report what we saw and let the
  // caller decide whether that is good enough.
  return remaining < fill.sz ? pnl : undefined;
}

export function shadowReplay(input: ShadowInput): ShadowReport {
  const fills = [...input.fills].sort((a, b) => a.time - b.time);
  const depthUnavailable = input.depthUnavailable ?? true;

  // Markets the user actually traded: judging a BTC trader against a rulebook
  // that only allows xyz:XYZ100 would produce 2000 meaningless denials.
  const traded = [...new Set(fills.map((f) => f.coin))].sort();
  const policy: Policy = { ...input.policy, allowed_markets: traded };

  const history: HistoryEvent[] = [];
  const position = new Map<string, number>();
  const dailyPnl = new Map<string, number>();
  const episodes: ShadowEpisode[] = [];
  let fundedOnce = false;

  for (const fill of fills) {
    const market = fill.coin;
    const meta = input.markets[market] ?? { szDecimals: 4, maxLeverage: 10 };
    const day = utcDay(fill.time);

    // Position BEFORE this fill comes straight from the venue.
    const positionBefore = fill.startPosition;
    position.set(market, positionBefore);
    const positionNotionalUsd = Math.abs(positionBefore) * fill.px;

    // Daily realized loss as of this moment.
    const realizedToday = dailyPnl.get(day) ?? 0;

    const equity = equityAt(fill.time, input.currentEquityUsd, fills, input.funding, input.ledger);

    // A fill that shrinks the position is a reduce-only action by definition.
    const reduces = positionBefore !== 0 && Math.sign(positionBefore) !== (fill.side === "buy" ? 1 : -1);

    const intent: Intent = {
      version: "0.1",
      id: "shadow-" + fill.oid,
      ts: new Date(fill.time).toISOString(),
      source: "shadow:replay",
      market,
      side: fill.side,
      size: String(fill.sz),
      order_type: "limit",
      limit_px: String(fill.px),
      ...(reduces ? { reduce_only: true } : {}),
    } as Intent;

    const ctx = {
      now: fill.time,
      frozen: false,
      market: {
        market,
        markPx: fill.px, // the price it actually traded at — real, not modelled
        depthWithinBand: DEPTH_UNKNOWN,
        szDecimals: meta.szDecimals,
      },
      account: {
        equityUsd: equity,
        availableMarginUsd: equity,
        dailyRealizedPnlUsd: realizedToday,
        currentPositionNotionalUsd: positionNotionalUsd,
        currentPositionSize: positionBefore,
      },
      history: [...history],
    };

    const decision: Decision = evaluateIntent(intent, policy, ctx);

    // Never present a fabricated depth as a passing rule.
    const notEvaluated: string[] = [];
    let trace = decision.trace;
    if (depthUnavailable) {
      const depthStep = trace.find((s) => s.rule === "book_depth");
      if (depthStep) {
        notEvaluated.push("book_depth (no public historical order books)");
        trace = trace.filter((s) => s.rule !== "book_depth");
      }
    }

    const episode: ShadowEpisode = {
      ts: fill.time,
      coin: market,
      side: fill.side,
      size: fill.sz,
      px: fill.px,
      notionalUsd: fill.sz * fill.px,
      decision: decision.decision,
      code: decision.code,
      message_en: decision.message_en,
      trace,
      notEvaluated,
      positionBefore,
      equityUsd: equity,
      equityIsReconstructed: true,
      oid: fill.oid,
    };

    history.push({ ts: fill.time, market, side: fill.side, kind: "intent" });
    if (decision.decision === "deny") {
      const attributed = attributePnl(fill, fills);
      if (attributed !== undefined) episode.attributedPnlUsd = attributed;
      // Deliberately NOT pushed as a "deny" history event.
      //
      // Feeding our own refusals back would cascade: one refusal starts a
      // cool-down, the next order inside it is refused, which restarts the
      // cool-down, and a fast account ends up with a permanent lockout that
      // says nothing about its trading. A refusal that never happened would
      // not have provoked the retry the cool-down exists to punish.
      //
      // So each order is judged against the account's REAL prior activity.
      // This does not model how the user would have reacted to a refusal, and
      // the report says so.
    } else {
      history.push({ ts: fill.time, market, side: fill.side, kind: "fill" });
      position.set(market, positionBefore + (fill.side === "buy" ? fill.sz : -fill.sz));
    }
    dailyPnl.set(day, realizedToday + fill.closedPnl - fill.fee);
    fundedOnce = true;

    episodes.push(episode);
  }

  const blocked = episodes.filter((e) => e.decision === "deny");
  const blockedNotionalUsd = blocked.reduce((a, e) => a + e.notionalUsd, 0);
  const blockedAttributedPnlUsd = blocked.reduce((a, e) => a + (e.attributedPnlUsd ?? 0), 0);

  const caveats = [
    "A verified position-reducing order is exempt from the single-order notional cap, so a large exit is never refused by that rule — a capped exit turns a bad position into a trapped one. The exemption uses the verified position, not the claim: a 'reduce-only' order that would actually open or add exposure keeps the full check.",
    "Counterfactual, not a simulation: each order is judged against your real prior activity, and orders the gate would have refused are not fed back as refusals. It does not model how you would have reacted to being refused.",
    "The venue returns at most 2000 fills per call, so this window is as far back as one request reaches. A high-frequency account gets a short window; a quiet one gets months.",
    "Depth rule not evaluated: Hyperliquid does not publish historical order books, so the book-depth guard is neutralised rather than guessed.",
    "Equity is reconstructed by walking today's account value backwards through realized PnL, fees, funding and ledger movements. The leverage and margin verdicts are therefore approximate.",
    "The rulebook used for this report was narrowed to the " +
      traded.length +
      " market(s) this account actually traded; the shipped policy may allow fewer.",
    "Fills are treated as the orders that produced them. A real intent may have been split or amended before it reached the venue.",
    "Attributed PnL is the realized PnL of the position layer an order opened, measured until that layer closed inside the replay window. It is an attribution, not a promise.",
  ];

  return {
    user: input.user,
    generatedAt: input.now,
    profile: buildProfile(fills, policy),
    windowFrom: fills.length > 0 ? fills[0]!.time : input.now,
    windowTo: fills.length > 0 ? fills[fills.length - 1]!.time : input.now,
    policySemanticHash: input.policySemanticHash,
    fillsConsidered: fills.length,
    markets: traded,
    episodes,
    blocked,
    summary: {
      totalOrders: episodes.length,
      allowed: episodes.length - blocked.length,
      blocked: blocked.length,
      blockedNotionalUsd,
      blockedAttributedPnlUsd,
      blockRate: episodes.length > 0 ? blocked.length / episodes.length : 0,
    },
    caveats,
  };
}

/**
 * Split the attributed PnL of refused orders into the loss the gate would
 * have avoided and the later gain it would have given up. Net is the same
 * number as `summary.blockedAttributedPnlUsd`: negative means the refusals
 * kept money. Orders whose layer never closed inside the window are counted
 * in `unattributed` and are not treated as zero.
 */
export function refusalValue(report: ShadowReport): {
  avoidedLossUsd: number;
  forgoneGainUsd: number;
  netAttributedPnlUsd: number;
  unattributed: number;
} {
  let avoidedLossUsd = 0;
  let forgoneGainUsd = 0;
  let unattributed = 0;
  for (const episode of report.blocked) {
    if (episode.attributedPnlUsd === undefined) {
      unattributed += 1;
      continue;
    }
    if (episode.attributedPnlUsd < 0) avoidedLossUsd += -episode.attributedPnlUsd;
    else if (episode.attributedPnlUsd > 0) forgoneGainUsd += episode.attributedPnlUsd;
  }
  return {
    avoidedLossUsd,
    forgoneGainUsd,
    netAttributedPnlUsd: report.summary.blockedAttributedPnlUsd,
    unattributed,
  };
}

/** Group blocked orders by the rule that stopped them — the headline table. */
export function blockedByRule(report: ShadowReport): { code: string; count: number; notionalUsd: number; attributedPnlUsd: number }[] {
  const byCode = new Map<string, { code: string; count: number; notionalUsd: number; attributedPnlUsd: number }>();
  for (const episode of report.blocked) {
    const row = byCode.get(episode.code) ?? {
      code: episode.code,
      count: 0,
      notionalUsd: 0,
      attributedPnlUsd: 0,
    };
    row.count += 1;
    row.notionalUsd += episode.notionalUsd;
    row.attributedPnlUsd += episode.attributedPnlUsd ?? 0;
    byCode.set(episode.code, row);
  }
  return [...byCode.values()].sort((a, b) => b.count - a.count);
}

export { HOUR_MS, DAY_MS };
