import { describe, expect, it } from "vitest";
import type { Policy } from "@vetoos/risk";
import { blockedByRule, refusalValue, shadowReplay, type ReplayFill, type ShadowInput } from "./index.js";

const POLICY: Policy = {
  version: "0.1",
  allowed_markets: ["BTC"],
  max_leverage: 5,
  max_order_notional_usd: 1_000,
  max_daily_loss_usd: 200,
  max_orders_per_minute: 10,
  cooldown_seconds_after_deny: 30,
  max_same_side_adds_per_hour: 3,
  min_book_depth_multiple: 2,
  max_oracle_deviation_bps: 500,
  freeze_on_reconcile_mismatch: true,
  default_dex: "xyz",
  default_market: "BTC",
  network_mode: "mainnet_read_testnet_trade_preferred",
};

const T0 = 1_700_000_000_000;

/** A fill that opens/increases a long. */
function fill(over: Partial<ReplayFill> = {}): ReplayFill {
  return {
    time: T0,
    coin: "BTC",
    side: "buy",
    px: 100,
    sz: 1,
    closedPnl: 0,
    fee: 0.01,
    startPosition: 0,
    dir: "Open Long",
    oid: 1,
    ...over,
  };
}

function run(fills: ReplayFill[], over: Partial<ShadowInput> = {}) {
  return shadowReplay({
    user: "0x0000000000000000000000000000000000000001",
    policy: POLICY,
    policySemanticHash: "hash",
    now: T0 + 60_000,
    currentEquityUsd: 10_000,
    fills,
    funding: [],
    ledger: [],
    markets: { BTC: { szDecimals: 5, maxLeverage: 40 } },
    ...over,
  });
}

describe("shadow replay", () => {
  it("allows a small order and denies one above the notional cap", () => {
    const report = run([fill({ oid: 1, sz: 1 }), fill({ oid: 2, sz: 50, time: T0 + 1_000 })]);
    expect(report.episodes[0]!.decision).toBe("allow");
    expect(report.episodes[1]!.decision).toBe("deny");
    expect(report.episodes[1]!.code).toBe("NOTIONAL_EXCEEDED");
  });

  it("is deterministic: same fills, same verdicts, twice in a row", () => {
    const fills = [fill({ oid: 1 }), fill({ oid: 2, time: T0 + 1_000, sz: 2 }), fill({ oid: 3, time: T0 + 2_000, sz: 3 })];
    const a = run(fills);
    const b = run(fills);
    expect(JSON.stringify(a.episodes)).toBe(JSON.stringify(b.episodes));
    expect(a.summary).toEqual(b.summary);
  });

  it("counts same-side adds inside the hour and fires the FOMO guard", () => {
    const fills = [0, 1, 2, 3].map((i) =>
      fill({ oid: i + 1, time: T0 + i * 60_000, sz: 1, startPosition: i, dir: "Open Long" }),
    );
    const report = run(fills);
    expect(report.episodes.slice(0, 3).every((e) => e.decision === "allow")).toBe(true);
    expect(report.episodes[2]!.code).toBe("ALLOW");
    expect(report.episodes[3]!.code).toBe("FOMO_SAME_SIDE_ADDS");
  });

  it("does NOT let its own refusals cascade into a permanent cool-down", () => {
    // Regression: refusals used to be pushed back as deny history, so the first
    // block started a cool-down, the next order was blocked by that cool-down,
    // and a fast account ended up 99% blocked for no reason.
    const fills = Array.from({ length: 8 }, (_, i) =>
      fill({ oid: i + 1, time: T0 + i * 120_000, sz: 50, startPosition: i, dir: "Open Long" }),
    );
    const report = run(fills);
    // Every order here is oversized, so every one is refused — but by the
    // NOTIONAL rule, never by a cool-down caused by our own refusal.
    expect(report.blocked.every((e) => e.code === "NOTIONAL_EXCEEDED")).toBe(true);
    expect(report.blocked.some((e) => e.code === "FOMO_COOLDOWN")).toBe(false);
  });

  it("trips the daily-loss breaker on the order AFTER the loss, not the one that caused it", () => {
    const report = run([
      fill({ oid: 1, sz: 0.1 }),
      fill({ oid: 2, time: T0 + 1_000, sz: 0.1, side: "sell", closedPnl: -500, dir: "Close Long", startPosition: 0.1 }),
      fill({ oid: 3, time: T0 + 2_000, sz: 0.1 }),
    ]);
    expect(report.episodes[1]!.decision).toBe("allow");
    expect(report.episodes[2]!.code).toBe("DAILY_LOSS_CIRCUIT_BREAKER");
  });

  it("never reports the depth rule as passed, and always declares it unevaluated", () => {
    const report = run([fill()]);
    for (const episode of report.episodes) {
      expect(episode.trace.some((s) => s.rule === "book_depth")).toBe(false);
      expect(episode.notEvaluated.join(" ")).toMatch(/book_depth/);
    }
    expect(report.caveats.join(" ")).toMatch(/historical order books/i);
  });

  it("walks equity back through realized PnL so a losing fill lowers the equity at that time", () => {
    const report = run([
      fill({ oid: 1, sz: 0.1 }),
      fill({ oid: 2, time: T0 + 1_000, sz: 0.1, closedPnl: -1_000, fee: 0, startPosition: 0.1, dir: "Close Long" }),
    ]);
    // Equity today is 10,000; 1,000 was lost after the first fill, so at the
    // time of the first fill the account was worth more.
    expect(report.episodes[0]!.equityUsd).toBeGreaterThan(report.episodes[1]!.equityUsd);
    expect(report.episodes[1]!.equityIsReconstructed).toBe(true);
  });

  it("describes the account before judging it", () => {
    const fills = Array.from({ length: 30 }, (_, i) => fill({ oid: i + 1, time: T0 + i * 1_000, sz: 1, startPosition: i }));
    const report = run(fills);
    expect(report.profile.ordersPerMinuteP95).toBeGreaterThan(POLICY.max_orders_per_minute);
    expect(report.profile.bindingConstraints.join(" ")).toMatch(/order rate/);
    expect(report.profile.distinctMarkets).toBe(1);
  });

  it("narrows the rulebook to the markets actually traded", () => {
    const report = run([fill({ coin: "ETH", oid: 1 })], {
      markets: { ETH: { szDecimals: 4, maxLeverage: 25 } },
    });
    // Judging an ETH trader against an allow-list of ["BTC"] would produce a
    // meaningless wall of MARKET_NOT_ALLOWED.
    expect(report.episodes[0]!.code).not.toBe("MARKET_NOT_ALLOWED");
    expect(report.markets).toEqual(["ETH"]);
  });

  it("attributes the later realized PnL of the layer a blocked order opened", () => {
    const report = run([
      fill({ oid: 1, sz: 100, time: T0, px: 100, startPosition: 0, dir: "Open Long" }), // blocked: 10,000 USD
      // The close is priced small so the notional cap does not refuse it too —
      // otherwise the layer never closes and there is nothing to attribute.
      fill({ oid: 2, sz: 100, time: T0 + 60_000, px: 5, side: "sell", closedPnl: -250, startPosition: 100, dir: "Close Long" }),
    ]);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]!.attributedPnlUsd).toBeCloseTo(-250, 6);
    expect(report.summary.blockedAttributedPnlUsd).toBeCloseTo(-250, 6);
    expect(refusalValue(report)).toMatchObject({
      avoidedLossUsd: 250,
      forgoneGainUsd: 0,
      unattributed: 0,
    });
  });

  it("groups refusals by rule for the headline table", () => {
    const report = run([fill({ oid: 1, sz: 100 }), fill({ oid: 2, sz: 200, time: T0 + 1_000 })]);
    const byRule = blockedByRule(report);
    expect(byRule).toHaveLength(1);
    expect(byRule[0]).toMatchObject({ code: "NOTIONAL_EXCEEDED", count: 2 });
    expect(byRule[0]!.notionalUsd).toBeCloseTo(100 * 100 + 200 * 100, 6);
  });

  it("handles an empty fill list without throwing", () => {
    const report = run([]);
    expect(report.summary.totalOrders).toBe(0);
    expect(report.summary.blockRate).toBe(0);
    expect(report.blocked).toEqual([]);
  });
});
