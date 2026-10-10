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
function makeStubAdapter() {
  let position = 0;
  let orderCalls = 0;
  const adapter = {
    getMarketSnapshot: async () => ({
      market: "BTC",
      markPx: 100,
      funding: 0,
      openInterest: 1_000_000,
      depthWithinBand: 10_000,
      szDecimals: 2,
      assetId: 0,
    }),
    getAccountState: async () => ({
      equityUsd: 10_000,
      availableMarginUsd: 8_000,
      positions: new Map<string, number>(position !== 0 ? [["BTC", position]] : []),
    }),
    getPositionSize: async () => position,
    placeOrder: async (): Promise<PlacedOrder> => {
      orderCalls++;
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
    stats: () => ({ orderCalls, position }),
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
});
