import { describe, expect, it } from "vitest";
import type { Intent } from "@vetoos/intent";
import { evaluateIntent, type RiskContext } from "./engine.js";
import type { Policy } from "./policy.js";

const policy: Policy = {
  version: "0.1",
  allowed_markets: ["xyz:XYZ100", "BTC"],
  max_leverage: 5,
  max_order_notional_usd: 1000,
  max_daily_loss_usd: 200,
  max_orders_per_minute: 10,
  cooldown_seconds_after_deny: 30,
  max_same_side_adds_per_hour: 3,
  min_book_depth_multiple: 2,
  freeze_on_reconcile_mismatch: true,
  default_dex: "xyz",
  default_market: "xyz:XYZ100",
  network_mode: "mainnet_read_testnet_trade_preferred",
};

const NOW = 1_760_000_000_000; // fixed clock for determinism

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    version: "0.1",
    id: "11111111-1111-4111-8111-111111111111",
    source: "test",
    ts: new Date(NOW).toISOString(),
    market: "xyz:XYZ100",
    side: "buy",
    size: "1",
    order_type: "market",
    reduce_only: false,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW,
    frozen: false,
    market: {
      market: "xyz:XYZ100",
      markPx: 100,
      funding: 0.0001,
      openInterest: 1_000_000,
      depthWithinBand: 1_000,
      szDecimals: 2,
    },
    account: {
      equityUsd: 10_000,
      availableMarginUsd: 8_000,
      dailyRealizedPnlUsd: 0,
      currentPositionNotionalUsd: 0,
    },
    history: [],
    ...overrides,
  };
}

describe("evaluateIntent — allow path", () => {
  it("allows a clean intent", () => {
    const d = evaluateIntent(makeIntent(), policy, makeCtx());
    expect(d.decision).toBe("allow");
    expect(d.code).toBe("ALLOW");
  });

  it("is deterministic: same inputs → same decision", () => {
    const a = evaluateIntent(makeIntent(), policy, makeCtx());
    const b = evaluateIntent(makeIntent(), policy, makeCtx());
    expect(a).toEqual(b);
  });

  it("allows exactly at the notional cap (boundary)", () => {
    const d = evaluateIntent(makeIntent({ size: "10" }), policy, makeCtx()); // 10*100 = $1000
    expect(d.decision).toBe("allow");
  });
});

describe("evaluateIntent — freeze & market data", () => {
  it("frozen broker denies everything, reduce-only included", () => {
    const d = evaluateIntent(
      makeIntent({ reduce_only: true }),
      policy,
      makeCtx({ frozen: true, freezeReason: "reconcile mismatch" }),
    );
    expect(d.code).toBe("FROZEN");
  });

  it("fails closed when mark price is missing", () => {
    const ctx = makeCtx();
    ctx.market.markPx = 0;
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.code).toBe("NO_MARKET_DATA");
  });
});

describe("evaluateIntent — policy rules", () => {
  it("denies a market outside the allow-list", () => {
    const d = evaluateIntent(makeIntent({ market: "ETH" }), policy, makeCtx());
    expect(d.code).toBe("MARKET_NOT_ALLOWED");
  });

  it("denies one tick above the notional cap (boundary)", () => {
    const d = evaluateIntent(makeIntent({ size: "10.01" }), policy, makeCtx());
    expect(d.code).toBe("NOTIONAL_EXCEEDED");
  });

  it("denies leverage above the cap", () => {
    const ctx = makeCtx();
    ctx.account.equityUsd = 100; // 1 * $100 order + $450 existing → 5.5x > 5x
    ctx.account.currentPositionNotionalUsd = 450;
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.code).toBe("LEVERAGE_EXCEEDED");
  });

  it("reduce-only skips the leverage check", () => {
    const ctx = makeCtx();
    ctx.account.equityUsd = 100;
    ctx.account.currentPositionNotionalUsd = 450;
    const d = evaluateIntent(makeIntent({ reduce_only: true }), policy, ctx);
    expect(d.decision).toBe("allow");
  });

  it("reduce-only is verified against the position sign: a buy against a long is an add", () => {
    const ctx = makeCtx();
    ctx.account.equityUsd = 100;
    ctx.account.currentPositionNotionalUsd = 450;
    ctx.account.currentPositionSize = 4.5; // long; a "reduce-only" BUY cannot reduce it
    const d = evaluateIntent(makeIntent({ reduce_only: true, side: "buy" }), policy, ctx);
    expect(d.code).toBe("LEVERAGE_EXCEEDED");
    expect(d.snapshot["reduce_only_effective"]).toBe(false);
  });

  it("reduce-only larger than the position is treated as a flip (no waiver)", () => {
    const ctx = makeCtx();
    ctx.account.equityUsd = 100;
    ctx.account.currentPositionNotionalUsd = 450;
    ctx.account.currentPositionSize = 4.5;
    const d = evaluateIntent(makeIntent({ reduce_only: true, side: "sell", size: "5" }), policy, ctx);
    expect(d.code).toBe("LEVERAGE_EXCEEDED");
  });

  it("a genuine reduce-only sell against a long keeps the waivers", () => {
    const ctx = makeCtx();
    ctx.account.equityUsd = 100;
    ctx.account.currentPositionNotionalUsd = 450;
    ctx.account.currentPositionSize = 4.5;
    const d = evaluateIntent(makeIntent({ reduce_only: true, side: "sell", size: "1" }), policy, ctx);
    expect(d.decision).toBe("allow");
    expect(d.snapshot["reduce_only_effective"]).toBe(true);
  });
});

describe("evaluateIntent — daily loss breaker", () => {
  it("trips exactly at the breaker line (boundary)", () => {
    const ctx = makeCtx();
    ctx.account.dailyRealizedPnlUsd = -200;
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.code).toBe("DAILY_LOSS_CIRCUIT_BREAKER");
  });

  it("allows one dollar above the breaker", () => {
    const ctx = makeCtx();
    ctx.account.dailyRealizedPnlUsd = -199;
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.decision).toBe("allow");
  });
});

describe("evaluateIntent — FOMO guards", () => {
  it("denies during the post-deny cool-down", () => {
    const ctx = makeCtx({
      history: [{ ts: NOW - 10_000, market: "xyz:XYZ100", side: "buy", kind: "deny" }],
    });
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.code).toBe("FOMO_COOLDOWN");
  });

  it("allows after the cool-down expires (boundary)", () => {
    const ctx = makeCtx({
      history: [{ ts: NOW - 31_000, market: "xyz:XYZ100", side: "buy", kind: "deny" }],
    });
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.decision).toBe("allow");
  });

  it("denies the 4th same-side add within an hour", () => {
    const history = [1, 2, 3].map((i) => ({
      ts: NOW - i * 60_000,
      market: "xyz:XYZ100",
      side: "buy" as const,
      kind: "fill" as const,
    }));
    const d = evaluateIntent(makeIntent(), policy, makeCtx({ history }));
    expect(d.code).toBe("FOMO_SAME_SIDE_ADDS");
    expect(d.message_en).toMatch(/FOMO/i);
  });

  it("does not count opposite-side fills toward the add cap", () => {
    const history = [1, 2, 3].map((i) => ({
      ts: NOW - i * 60_000,
      market: "xyz:XYZ100",
      side: "sell" as const,
      kind: "fill" as const,
    }));
    const d = evaluateIntent(makeIntent(), policy, makeCtx({ history }));
    expect(d.decision).toBe("allow");
  });

  it("ignores same-side fills older than one hour", () => {
    const history = [1, 2, 3].map((i) => ({
      ts: NOW - (3_600_000 + i * 60_000),
      market: "xyz:XYZ100",
      side: "buy" as const,
      kind: "fill" as const,
    }));
    const d = evaluateIntent(makeIntent(), policy, makeCtx({ history }));
    expect(d.decision).toBe("allow");
  });

  it("denies above the per-minute frequency cap", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      ts: NOW - i * 1_000,
      market: "xyz:XYZ100",
      side: "buy" as const,
      kind: "intent" as const,
    }));
    const d = evaluateIntent(makeIntent(), policy, makeCtx({ history }));
    expect(d.code).toBe("RATE_LIMIT");
  });
});

describe("evaluateIntent — book capacity & margin", () => {
  it("denies when the real book is too thin", () => {
    const ctx = makeCtx();
    ctx.market.depthWithinBand = 1.5; // need 2x size 1
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.code).toBe("BOOK_DEPTH");
  });

  it("allows at exactly the required depth (boundary)", () => {
    const ctx = makeCtx();
    ctx.market.depthWithinBand = 2; // exactly 2x size 1
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.decision).toBe("allow");
  });

  it("denies when margin is insufficient", () => {
    const ctx = makeCtx();
    ctx.account.availableMarginUsd = 10; // need 100/5 = $20
    const d = evaluateIntent(makeIntent(), policy, ctx);
    expect(d.code).toBe("MARGIN_INSUFFICIENT");
  });

  it("reduce-only skips the margin check", () => {
    const ctx = makeCtx();
    ctx.account.availableMarginUsd = 0;
    const d = evaluateIntent(makeIntent({ reduce_only: true }), policy, ctx);
    expect(d.decision).toBe("allow");
  });
});

describe("evaluateIntent — evaluation order (first deny wins)", () => {
  it("freeze beats every other rule", () => {
    const ctx = makeCtx({ frozen: true, freezeReason: "x" });
    ctx.market.depthWithinBand = 0;
    ctx.account.availableMarginUsd = 0;
    const d = evaluateIntent(makeIntent({ market: "ETH" }), policy, ctx);
    expect(d.code).toBe("FROZEN");
  });

  it("policy checks beat FOMO checks", () => {
    const ctx = makeCtx({
      history: [{ ts: NOW - 5_000, market: "xyz:XYZ100", side: "buy", kind: "deny" }],
    });
    const d = evaluateIntent(makeIntent({ market: "ETH" }), policy, ctx);
    expect(d.code).toBe("MARKET_NOT_ALLOWED");
  });
});

describe("evaluateIntent — trace (the explainable verdict)", () => {
  it("allow: every rule passes, reduce-only skips leverage/margin", () => {
    const d = evaluateIntent(makeIntent({ reduce_only: true }), policy, makeCtx());
    expect(d.decision).toBe("allow");
    expect(d.trace.every((t) => t.outcome !== "fail")).toBe(true);
    const skipped = d.trace.filter((t) => t.outcome === "skip").map((t) => t.rule);
    expect(skipped).toEqual(["leverage", "same_side_adds", "margin"]);
  });

  it("deny: trace stops exactly at the failing rule", () => {
    const d = evaluateIntent(makeIntent({ size: "10.01" }), policy, makeCtx());
    const last = d.trace[d.trace.length - 1];
    expect(last?.rule).toBe("notional");
    expect(last?.outcome).toBe("fail");
    expect(d.trace.filter((t) => t.outcome === "fail")).toHaveLength(1);
    // rules before the failure passed; rules after never ran
    expect(d.trace.map((t) => t.rule)).toEqual(["freeze", "market_data", "allowed_market", "notional"]);
  });

  it("frozen: trace is a single fail step", () => {
    const d = evaluateIntent(makeIntent(), policy, makeCtx({ frozen: true, freezeReason: "x" }));
    expect(d.trace).toHaveLength(1);
    expect(d.trace[0]).toMatchObject({ rule: "freeze", outcome: "fail" });
  });
});
