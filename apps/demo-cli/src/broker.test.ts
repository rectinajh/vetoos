/**
 * RiskBroker idempotency: the same intent id submitted twice must produce
 * exactly ONE order. Everything else (rules, truth) is covered elsewhere.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HlAdapter, PlacedOrder } from "@vetoos/adapter-hl";
import { AuditLog } from "@vetoos/audit";
import { makeIntent } from "@vetoos/intent";
import { loadPolicy } from "@vetoos/risk";
import { RiskBroker } from "./broker.js";

const here = dirname(fileURLToPath(import.meta.url));
const demoPolicy = loadPolicy(resolve(here, "../../../configs/policy.demo.json"));

/** Minimal venue stub: flat account, deep book, every order fills fully. */
function makeStubAdapter(opts: { latencyMs?: number; realizedPnl?: number; failWrite?: boolean } = {}) {
  let position = 0;
  let orderCalls = 0;
  let realizedPnl = opts.realizedPnl ?? 0;
  const cloids: (string | undefined)[] = [];
  const hooks: { beforePlace?: () => void } = {};
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const adapter = {
    getMarketSnapshot: async () => {
      if (opts.latencyMs) await delay(opts.latencyMs);
      return {
        market: "BTC",
        markPx: 100,
        funding: 0,
        openInterest: 1_000_000,
        depthWithinBand: 10_000,
        szDecimals: 2,
        assetId: 0,
      };
    },
    getAccountState: async () => ({
      equityUsd: 10_000,
      availableMarginUsd: 8_000,
      positions: new Map<string, number>(position !== 0 ? [["BTC", position]] : []),
    }),
    getPositionSize: async () => position,
    getRealizedPnlSince: async () => realizedPnl,
    placeOrder: async (params: { cloid?: string }): Promise<PlacedOrder> => {
      hooks.beforePlace?.();
      if (opts.failWrite) throw new Error("venue rejected order: simulated 503");
      orderCalls++;
      cloids.push(params.cloid);
      position += 1;
      return {
        status: "filled",
        oid: 900000 + orderCalls,
        filledSize: 1,
        avgPx: 100,
        assetId: 0,
        raw: {},
      };
    },
  };
  return {
    adapter: adapter as unknown as HlAdapter,
    stats: () => ({ orderCalls, position, cloids }),
    setRealizedPnl: (v: number) => {
      realizedPnl = v;
    },
    hooks,
  };
}

describe("RiskBroker idempotency", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("the same intent id fills exactly once", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter, stats } = makeStubAdapter();
    const audit = new AuditLog(dir, demoPolicy.contentHash);
    const broker = new RiskBroker(demoPolicy, adapter, audit, dir);

    const intent = makeIntent({
      source: "test",
      market: "BTC",
      side: "buy",
      size: "1",
      order_type: "market",
    });
    // demoSize isn't used here; size 1 at mark 100 → $100 notional, passes caps.

    const first = await broker.submitIntent(intent);
    expect(first.decision?.decision).toBe("allow");
    expect(first.duplicate).toBeUndefined();
    expect(stats().orderCalls).toBe(1);

    const second = await broker.submitIntent(intent);
    expect(second.duplicate).toBe(true);
    expect(second.decision?.code).toBe("ALLOW");
    expect(stats().orderCalls).toBe(1); // no double fill
    expect(stats().position).toBe(1);
  });

  it("deny outcomes are also idempotent (no repeated cooldown churn)", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter } = makeStubAdapter();
    const audit = new AuditLog(dir, demoPolicy.contentHash);
    const broker = new RiskBroker(demoPolicy, adapter, audit, dir);

    const greedy = makeIntent({
      source: "test",
      market: "BTC",
      side: "buy",
      size: "1000", // $100k notional at mark 100 → way over the $1k cap
      order_type: "market",
    });
    const first = await broker.submitIntent(greedy);
    expect(first.decision?.code).toBe("NOTIONAL_EXCEEDED");

    const second = await broker.submitIntent(greedy);
    expect(second.duplicate).toBe(true);
    expect(second.decision?.code).toBe("NOTIONAL_EXCEEDED");
  });

  it("CONCURRENT submissions of one id share a single evaluation and order (P0-1)", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter, stats } = makeStubAdapter({ latencyMs: 40 });
    const broker = new RiskBroker(demoPolicy, adapter, new AuditLog(dir, demoPolicy.contentHash), dir);
    const intent = makeIntent({ source: "test", market: "BTC", side: "buy", size: "1", order_type: "market" });

    const [a, b, c] = await Promise.all([
      broker.submitIntent(intent),
      broker.submitIntent(intent),
      broker.submitIntent(intent),
    ]);
    expect(stats().orderCalls).toBe(1);
    expect(stats().position).toBe(1);
    expect(a.decision?.code).toBe("ALLOW");
    expect([b.duplicate, c.duplicate]).toEqual([true, true]);
    expect(b.placed?.oid).toBe(a.placed?.oid);
  });

  it("the venue order carries a cloid derived from the intent id", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter, stats } = makeStubAdapter();
    const broker = new RiskBroker(demoPolicy, adapter, new AuditLog(dir, demoPolicy.contentHash), dir);
    const intent = makeIntent({ source: "test", market: "BTC", side: "buy", size: "1", order_type: "market" });
    await broker.submitIntent(intent);
    expect(stats().cloids[0]).toBe(`0x${intent.id.replace(/-/g, "")}`);
  });
});

describe("RiskBroker — venue-sourced daily loss breaker (P0-2)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("reads realized PnL from the venue and trips the breaker", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter, stats, setRealizedPnl } = makeStubAdapter();
    const broker = new RiskBroker(demoPolicy, adapter, new AuditLog(dir, demoPolicy.contentHash), dir);

    setRealizedPnl(-150); // under the $200 breaker
    const ok = await broker.submitIntent(
      makeIntent({ source: "test", market: "BTC", side: "buy", size: "1", order_type: "market" }),
    );
    expect(ok.decision?.code).toBe("ALLOW");
    expect(broker.dailyRealizedPnlUsd).toBe(-150);

    setRealizedPnl(-250); // venue now says the day is lost
    await broker.refreshDailyPnl(true);
    const tripped = await broker.submitIntent(
      makeIntent({ source: "test", market: "BTC", side: "buy", size: "1", order_type: "market" }),
    );
    expect(tripped.decision?.code).toBe("DAILY_LOSS_CIRCUIT_BREAKER");
    expect(stats().orderCalls).toBe(1);
  });
});

describe("RiskBroker — write path safety (P1-9 / P1-10)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("a freeze that lands between evaluation and signing stops the order", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter, stats } = makeStubAdapter({ latencyMs: 30 });
    const broker = new RiskBroker(demoPolicy, adapter, new AuditLog(dir, demoPolicy.contentHash), dir);
    const intent = makeIntent({ source: "test", market: "BTC", side: "buy", size: "1", order_type: "market" });
    const pending = broker.submitIntent(intent);
    await new Promise((r) => setTimeout(r, 5)); // we are inside the venue reads now
    broker.freeze("tamper detected on another request");
    const result = await pending;
    expect(result.decision?.code).toBe("FROZEN");
    expect(stats().orderCalls).toBe(0);
  });

  it("a write error burns the intent: recorded, audited, never retried", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter, stats } = makeStubAdapter({ failWrite: true });
    const broker = new RiskBroker(demoPolicy, adapter, new AuditLog(dir, demoPolicy.contentHash), dir);
    const intent = makeIntent({ source: "test", market: "BTC", side: "buy", size: "1", order_type: "market" });
    const first = await broker.submitIntent(intent);
    expect(first.decision?.code).toBe("ALLOW");
    expect(first.error).toMatch(/simulated 503/);
    const retry = await broker.submitIntent(intent);
    expect(retry.duplicate).toBe(true);
    expect(retry.error).toMatch(/simulated 503/);
    expect(stats().orderCalls).toBe(0);
  });

  it("session reconcile only nets fills of the SAME market (regression: xyz fill vs BTC position)", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter } = makeStubAdapter();
    const broker = new RiskBroker(demoPolicy, adapter, new AuditLog(dir, demoPolicy.contentHash), dir);
    await broker.setBaseline("BTC"); // venue BTC position = 0
    const intent = makeIntent({ source: "test", market: "BTC", side: "buy", size: "1", order_type: "market" });
    const r = await broker.submitIntent(intent); // BTC +1 on the venue, +1 in the ledger
    expect(r.decision?.code).toBe("ALLOW");
    // A fill on another market lands in the same ledger file.
    broker.ledger.append({
      intentId: "other-market",
      market: "xyz:XYZ100",
      side: "sell",
      size: 0.4,
      avgPx: 30600,
      oid: 1,
      ts: Date.now(),
      szDecimals: 4,
    });
    const session = await broker.reconcileNow("BTC");
    expect(session.ok).toBe(true);
    expect(broker.status()["frozen"]).toBe(false);
  });

  it("freeze posts to VETOOS_FREEZE_WEBHOOK and ignores a non-http url", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-broker-"));
    const { adapter } = makeStubAdapter();
    const broker = new RiskBroker(demoPolicy, adapter, new AuditLog(dir, demoPolicy.contentHash), dir);
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("ok");
    }) as typeof fetch;
    try {
      process.env.VETOOS_FREEZE_WEBHOOK = "file:///tmp/nope";
      broker.freeze("ignored");
      process.env.VETOOS_FREEZE_WEBHOOK = "https://hooks.example/vetoos";
      broker.freeze("books diverged");
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual(["https://hooks.example/vetoos"]);
    } finally {
      globalThis.fetch = original;
      delete process.env.VETOOS_FREEZE_WEBHOOK;
    }
  });
});
