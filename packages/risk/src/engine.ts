/**
 * Deterministic risk engine. Pure functions only — no I/O, no LLM anywhere
 * near the allow/deny path (docs/ARCHITECTURE.md §5). Same inputs always
 * produce the same decision, which is what makes the broker auditable.
 *
 * Evaluation order (fail fast, first deny wins):
 *   1. global freeze (post-reconciliation kill switch)
 *   2. policy: oracle distance / allowed market / max notional / max leverage
 *   3. daily-loss circuit breaker
 *   4. FOMO guards: post-deny cooldown, same-side add count, order frequency
 *   5. order-book capacity vs. real depth
 *   6. coarse margin check
 */

import type { Intent } from "@vetoos/intent";
import type { Policy } from "./policy.js";

export type DenyCode =
  | "FROZEN"
  | "NO_MARKET_DATA"
  | "ORACLE_DEVIATION"
  | "MARKET_NOT_ALLOWED"
  | "NOTIONAL_EXCEEDED"
  | "LEVERAGE_EXCEEDED"
  | "DAILY_LOSS_CIRCUIT_BREAKER"
  | "FOMO_COOLDOWN"
  | "FOMO_SAME_SIDE_ADDS"
  | "RATE_LIMIT"
  | "BOOK_DEPTH"
  | "MARGIN_INSUFFICIENT";

export interface Decision {
  decision: "allow" | "deny";
  code: DenyCode | "ALLOW";
  message_en: string;
  message_zh: string;
  snapshot: Record<string, unknown>;
  /** Per-rule evaluation trail — what makes the verdict explainable (and renderable). */
  trace: TraceStep[];
}

export type TraceOutcome = "pass" | "fail" | "skip";

export interface TraceStep {
  rule:
    | "freeze"
    | "market_data"
    | "oracle_distance"
    | "allowed_market"
    | "notional"
    | "leverage"
    | "daily_loss"
    | "cooldown"
    | "same_side_adds"
    | "rate_limit"
    | "book_depth"
    | "margin";
  outcome: TraceOutcome;
  detail?: string;
}

export interface MarketSnapshot {
  market: string;
  /** Real mark price from the venue. <= 0 means "no data" → fail closed. */
  markPx: number;
  funding?: number;
  openInterest?: number;
  /**
   * Aggregated resting size (base units) on the side this order would hit,
   * within the adapter's slippage band. Required — the broker never
   * evaluates capacity against a made-up book.
   */
  depthWithinBand: number;
  szDecimals: number;
}

export interface AccountSnapshot {
  equityUsd: number;
  availableMarginUsd: number;
  dailyRealizedPnlUsd: number;
  /** Absolute current position notional in the target market. */
  currentPositionNotionalUsd: number;
  /**
   * Signed current position size in the target market (long > 0, short < 0).
   * When supplied, a `reduce_only` claim is VERIFIED against it: an order
   * that would open or flip a position never gets the reduce-only waivers.
   */
  currentPositionSize?: number;
}

export interface HistoryEvent {
  ts: number;
  market: string;
  side: "buy" | "sell";
  kind: "intent" | "fill" | "deny";
}

export interface RiskContext {
  now: number;
  frozen: boolean;
  freezeReason?: string;
  market: MarketSnapshot;
  account: AccountSnapshot;
  history: HistoryEvent[];
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function deny(
  code: DenyCode,
  message_en: string,
  message_zh: string,
  snapshot: Record<string, unknown>,
  trace: TraceStep[],
): Decision {
  return { decision: "deny", code, message_en, message_zh, snapshot, trace };
}

export function evaluateIntent(
  intent: Intent,
  policy: Policy,
  ctx: RiskContext,
): Decision {
  const orderPx = intent.limit_px !== undefined ? Number(intent.limit_px) : ctx.market.markPx;
  const size = Number(intent.size);
  const notionalUsd = orderPx * size;
  const baseSnapshot: Record<string, unknown> = {
    intent_id: intent.id,
    market: intent.market,
    side: intent.side,
    size: intent.size,
    order_px: orderPx,
    notional_usd: notionalUsd,
    mark_px: ctx.market.markPx,
    allowed_notional_usd: policy.max_order_notional_usd,
    depth_within_band: ctx.market.depthWithinBand,
    equity_usd: ctx.account.equityUsd,
    now: new Date(ctx.now).toISOString(),
  };

  // reduce_only is a claim; the position sign is the fact. A "reduce-only"
  // buy against a long (or a size larger than the position) is an add.
  const pos = ctx.account.currentPositionSize;
  const reduces =
    pos === undefined
      ? intent.reduce_only
      : intent.reduce_only &&
        pos !== 0 &&
        (intent.side === "buy" ? pos < 0 : pos > 0) &&
        size <= Math.abs(pos) + 1e-12;
  if (intent.reduce_only) {
    baseSnapshot["reduce_only_claimed"] = true;
    baseSnapshot["reduce_only_effective"] = reduces;
    if (!reduces) baseSnapshot["reduce_only_note"] = "claimed reduce-only but order would open/add — waivers withheld";
  }

  const trace: TraceStep[] = [];
  const pass = (rule: TraceStep["rule"], detail?: string): void => {
    trace.push({ rule, outcome: "pass", ...(detail !== undefined ? { detail } : {}) });
  };
  const skip = (rule: TraceStep["rule"], detail?: string): void => {
    trace.push({ rule, outcome: "skip", ...(detail !== undefined ? { detail } : {}) });
  };
  const fail = (
    code: DenyCode,
    rule: TraceStep["rule"],
    message_en: string,
    message_zh: string,
    snapshot: Record<string, unknown>,
    detail?: string,
  ): Decision => {
    trace.push({ rule, outcome: "fail", ...(detail !== undefined ? { detail } : {}) });
    return deny(code, message_en, message_zh, snapshot, trace);
  };

  // 1. Global freeze — the reconciliation kill switch outranks everything.
  if (ctx.frozen) {
    return fail(
      "FROZEN",
      "freeze",
      `Broker is frozen (${ctx.freezeReason ?? "reconciliation mismatch"}). No new orders until a human unfreezes.`,
      `总闸已冻结（${ctx.freezeReason ?? "对账不符"}）。人工解冻前拒绝一切新意图。`,
      { ...baseSnapshot, freeze_reason: ctx.freezeReason },
      ctx.freezeReason,
    );
  }
  pass("freeze", "not frozen");

  // Market data sanity — fail closed when the venue gave us nothing real.
  if (!(ctx.market.markPx > 0) || !Number.isFinite(ctx.market.markPx)) {
    return fail(
      "NO_MARKET_DATA",
      "market_data",
      `No real market data for ${intent.market}; refusing to evaluate against stale or synthetic prices.`,
      `拿不到 ${intent.market} 的真实行情，拒绝在虚假数据上放行。`,
      baseSnapshot,
    );
  }
  pass("market_data", `mark ${ctx.market.markPx}`);

  // Caller-supplied limits must sit near the venue mark. Market orders skip:
  // the adapter clamps those to the same band before signing.
  if (intent.order_type === "limit" && intent.limit_px !== undefined) {
    const limitPx = Number(intent.limit_px);
    const deviationBps =
      limitPx > 0 && ctx.market.markPx > 0
        ? (Math.abs(limitPx - ctx.market.markPx) / ctx.market.markPx) * 10_000
        : Number.POSITIVE_INFINITY;
    if (deviationBps > policy.max_oracle_deviation_bps) {
      return fail(
        "ORACLE_DEVIATION",
        "oracle_distance",
        `Limit ${intent.limit_px} is ${deviationBps.toFixed(0)} bps from mark ${ctx.market.markPx} (cap ${policy.max_oracle_deviation_bps} bps). The venue would reject this as too far from the oracle.`,
        `限价 ${intent.limit_px} 偏离标记价 ${ctx.market.markPx} 达 ${deviationBps.toFixed(0)} bps（上限 ${policy.max_oracle_deviation_bps}）。交易所会以“离预言机太远”拒单，签名前拦下。`,
        { ...baseSnapshot, limit_px: intent.limit_px, oracle_deviation_bps: Number.isFinite(deviationBps) ? deviationBps : null },
        `${deviationBps.toFixed(0)} bps > ${policy.max_oracle_deviation_bps}`,
      );
    }
    pass("oracle_distance", `${deviationBps.toFixed(0)} bps ≤ ${policy.max_oracle_deviation_bps}`);
  } else {
    skip("oracle_distance", "market order; adapter clamps to the oracle band");
  }

  // 2a. Policy: market allow-list.
  if (!policy.allowed_markets.includes(intent.market)) {
    return fail(
      "MARKET_NOT_ALLOWED",
      "allowed_market",
      `${intent.market} is not on the allowed-markets list (${policy.allowed_markets.join(", ")}).`,
      `${intent.market} 不在允许交易名单内（${policy.allowed_markets.join(", ")}）。`,
      baseSnapshot,
    );
  }
  pass("allowed_market");

  // 2b. Policy: single-order notional cap.
  if (notionalUsd > policy.max_order_notional_usd) {
    return fail(
      "NOTIONAL_EXCEEDED",
      "notional",
      `Order notional $${notionalUsd.toFixed(2)} exceeds the $${policy.max_order_notional_usd} single-order cap.`,
      `单笔名义 $${notionalUsd.toFixed(2)} 超过上限 $${policy.max_order_notional_usd}。`,
      baseSnapshot,
      `$${notionalUsd.toFixed(2)} > $${policy.max_order_notional_usd}`,
    );
  }
  pass("notional", `$${notionalUsd.toFixed(2)} ≤ $${policy.max_order_notional_usd}`);

  // 2c. Policy: leverage cap (skipped for verified reduce-only exits).
  if (reduces) {
    skip("leverage", "reduce-only");
  } else {
    const projectedLeverage =
      ctx.account.equityUsd > 0
        ? (ctx.account.currentPositionNotionalUsd + notionalUsd) / ctx.account.equityUsd
        : Number.POSITIVE_INFINITY;
    if (projectedLeverage > policy.max_leverage) {
      const finite = Number.isFinite(projectedLeverage);
      const levText = finite ? `${projectedLeverage.toFixed(2)}x` : "∞";
      const equityNote = finite ? "" : " (account equity reads 0 — fund the account)";
      return fail(
        "LEVERAGE_EXCEEDED",
        "leverage",
        `Projected leverage ${levText} would exceed the ${policy.max_leverage}x cap${equityNote}.`,
        `预估杠杆 ${levText} 超过上限 ${policy.max_leverage}x${finite ? "" : "（账户权益为 0，请先充值）"}。`,
        { ...baseSnapshot, projected_leverage: finite ? projectedLeverage : null },
        `${levText} > ${policy.max_leverage}x`,
      );
    }
    pass("leverage", `${projectedLeverage.toFixed(2)}x ≤ ${policy.max_leverage}x`);
  }

  // 3. Daily-loss circuit breaker.
  if (ctx.account.dailyRealizedPnlUsd <= -policy.max_daily_loss_usd) {
    return fail(
      "DAILY_LOSS_CIRCUIT_BREAKER",
      "daily_loss",
      `Daily realized loss $${ctx.account.dailyRealizedPnlUsd.toFixed(2)} hit the -$${policy.max_daily_loss_usd} breaker. Trading stops for today.`,
      `当日已实现亏损 $${ctx.account.dailyRealizedPnlUsd.toFixed(2)} 触及 -$${policy.max_daily_loss_usd} 熔断线，今日停止交易。`,
      baseSnapshot,
    );
  }
  pass("daily_loss", `$${ctx.account.dailyRealizedPnlUsd.toFixed(2)} > -$${policy.max_daily_loss_usd}`);

  // 4a. FOMO guard: post-deny cooldown — no instant revenge re-submits.
  const lastDeny = ctx.history
    .filter((h) => h.kind === "deny")
    .reduce<number | undefined>((acc, h) => (acc === undefined || h.ts > acc ? h.ts : acc), undefined);
  if (lastDeny !== undefined) {
    const cooldownUntil = lastDeny + policy.cooldown_seconds_after_deny * 1000;
    if (ctx.now < cooldownUntil) {
      const remaining = Math.ceil((cooldownUntil - ctx.now) / 1000);
      return fail(
        "FOMO_COOLDOWN",
        "cooldown",
        `Cool-down active: ${remaining}s left after the last rejection. Take a breath before re-submitting.`,
        `冷静期中：距上次否决还有 ${remaining} 秒。先缓缓，别急着再冲。`,
        { ...baseSnapshot, cooldown_remaining_s: remaining },
        `${remaining}s left`,
      );
    }
  }
  pass("cooldown");

  // 4b. FOMO guard: repeated same-side adds within the trailing hour.
  const sameSideAdds = ctx.history.filter(
    (h) =>
      h.kind === "fill" &&
      h.market === intent.market &&
      h.side === intent.side &&
      ctx.now - h.ts < HOUR_MS,
  ).length;
  if (reduces) {
    skip("same_side_adds", "reduce-only");
  } else if (sameSideAdds >= policy.max_same_side_adds_per_hour) {
    return fail(
      "FOMO_SAME_SIDE_ADDS",
      "same_side_adds",
      `${sameSideAdds} same-side ${intent.side} fills in the past hour (cap ${policy.max_same_side_adds_per_hour}). This looks like chasing — possible FOMO.`,
      `过去一小时已 ${sameSideAdds} 笔同向 ${intent.side} 加仓（上限 ${policy.max_same_side_adds_per_hour}）。疑似 FOMO 追单，拦下。`,
      { ...baseSnapshot, same_side_adds_1h: sameSideAdds },
      `${sameSideAdds}/h ≥ ${policy.max_same_side_adds_per_hour}`,
    );
  } else {
    pass("same_side_adds", `${sameSideAdds}/h < ${policy.max_same_side_adds_per_hour}`);
  }

  // 4c. Frequency guard.
  const recentSubmissions = ctx.history.filter(
    (h) => (h.kind === "intent" || h.kind === "fill") && ctx.now - h.ts < MINUTE_MS,
  ).length;
  if (recentSubmissions >= policy.max_orders_per_minute) {
    return fail(
      "RATE_LIMIT",
      "rate_limit",
      `${recentSubmissions} submissions in the past minute (cap ${policy.max_orders_per_minute}). Slow down.`,
      `过去一分钟已提交 ${recentSubmissions} 笔（上限 ${policy.max_orders_per_minute}）。降速。`,
      { ...baseSnapshot, submissions_1m: recentSubmissions },
    );
  }
  pass("rate_limit", `${recentSubmissions}/min < ${policy.max_orders_per_minute}`);

  // 5. Book capacity: order size must stay well inside real resting depth.
  const requiredDepth = size * policy.min_book_depth_multiple;
  if (ctx.market.depthWithinBand < requiredDepth) {
    return fail(
      "BOOK_DEPTH",
      "book_depth",
      `Order size ${intent.size} needs ${requiredDepth.toFixed(6)} units of real book depth (${policy.min_book_depth_multiple}x), only ${ctx.market.depthWithinBand.toFixed(6)} available. The book is too thin for this size.`,
      `下单量 ${intent.size} 需要 ${requiredDepth.toFixed(6)} 真实盘口深度（${policy.min_book_depth_multiple} 倍），实际仅 ${ctx.market.depthWithinBand.toFixed(6)}。盘口太薄，吃不下这单。`,
      { ...baseSnapshot, required_depth: requiredDepth },
      `${ctx.market.depthWithinBand.toFixed(4)} < ${requiredDepth.toFixed(4)}`,
    );
  }
  pass("book_depth", `${ctx.market.depthWithinBand.toFixed(4)} ≥ ${requiredDepth.toFixed(4)}`);

  // 6. Coarse margin check (skipped for verified reduce-only exits).
  if (reduces) {
    skip("margin", "reduce-only");
  } else {
    const requiredMargin = notionalUsd / policy.max_leverage;
    if (requiredMargin > ctx.account.availableMarginUsd) {
      return fail(
        "MARGIN_INSUFFICIENT",
        "margin",
        `Need ≈$${requiredMargin.toFixed(2)} margin, only $${ctx.account.availableMarginUsd.toFixed(2)} available.`,
        `约需保证金 $${requiredMargin.toFixed(2)}，可用仅 $${ctx.account.availableMarginUsd.toFixed(2)}。`,
        { ...baseSnapshot, required_margin_usd: requiredMargin },
      );
    }
    pass("margin", `≈$${requiredMargin.toFixed(2)} ≤ $${ctx.account.availableMarginUsd.toFixed(2)}`);
  }

  return {
    decision: "allow",
    code: "ALLOW",
    message_en: `Allowed: ${intent.side} ${intent.size} ${intent.market} passes all deterministic checks.`,
    message_zh: `放行：${intent.side} ${intent.size} ${intent.market} 通过全部确定性检查。`,
    snapshot: baseSnapshot,
    trace,
  };
}
