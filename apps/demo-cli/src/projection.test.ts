/**
 * The invariant that makes replay possible: the broker's live guard windows
 * MUST equal the projection of its own receipt chain. If these ever diverge,
 * "recompute the verdict from the log" would be computing something else.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HlAdapter, PlacedOrder } from "@vetoos/adapter-hl";
import { AuditLog, projectFrozen, projectHistory, readAuditFile } from "@vetoos/audit";
import { makeIntent } from "@vetoos/intent";
import { loadPolicy } from "@vetoos/risk";
import { RiskBroker } from "./broker.js";

const here = dirname(fileURLToPath(import.meta.url));
const demoPolicy = loadPolicy(resolve(here, "../../../configs/policy.demo.json"));

function stubAdapter(): HlAdapter {
  let position = 0;
  let n = 0;
  return {
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
    getRealizedPnlSince: async () => 0,
    placeOrder: async (): Promise<PlacedOrder> => {
      n++;
      position += 1;
      return { status: "filled", oid: 900000 + n, filledSize: 1, avgPx: 100, assetId: 0, raw: {} };
    },
  } as unknown as HlAdapter;
}

describe("state is a projection of the receipt chain", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("projectHistory(receipts) equals the broker's live history, event for event", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-projection-"));
    const audit = new AuditLog(dir, demoPolicy.contentHash);
    const broker = new RiskBroker(demoPolicy, stubAdapter(), audit, dir);

    // One allow (intent + fill), one deny (intent + deny), one more allow.
    const allow = makeIntent({ source: "t", market: "BTC", side: "buy", size: "1", order_type: "market" });
    await broker.submitIntent(allow);
    const deny = makeIntent({ source: "t", market: "BTC", side: "buy", size: "1000", order_type: "market" });
    await broker.submitIntent(deny);
    const allow2 = makeIntent({ source: "t", market: "BTC", side: "sell", size: "1", order_type: "market" });
    await broker.submitIntent(allow2);

    const events = readAuditFile(audit.path);
    const projected = projectHistory(events, { now: Date.now() });
    const live = broker.history();

    // The third intent lands inside the post-deny cool-down, so it is denied
    // too — the projection has to reproduce that, not a nicer story.
    expect(projected).toEqual(live);
    expect(projected.map((e) => e.kind)).toEqual(["intent", "fill", "intent", "deny", "intent", "deny"]);
    expect(projected.every((e) => e.market === "BTC")).toBe(true);
  });

  it("projectFrozen mirrors freeze and names the receipt that froze it", async () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-projection-"));
    const audit = new AuditLog(dir, demoPolicy.contentHash);
    const broker = new RiskBroker(demoPolicy, stubAdapter(), audit, dir);

    expect(projectFrozen(readAuditFile(audit.path))).toEqual({ frozen: false });

    broker.freeze("reconcile mismatch");
    const frozen = projectFrozen(readAuditFile(audit.path));
    expect(frozen.frozen).toBe(true);
    expect(frozen.freezeReason).toBe("reconcile mismatch");
    expect(frozen.freezeSeq).toBeGreaterThan(0);
    // The broker agrees, and the binding it will demand from a human matches.
    expect(broker.frozen).toBe(true);
    expect(broker.freezeBinding()?.seq).toBe(frozen.freezeSeq);

    broker.unfreeze("I_AM_HUMAN");
    expect(projectFrozen(readAuditFile(audit.path))).toEqual({ frozen: false });
    expect(broker.frozen).toBe(false);
  });

  it("refuses an unfreeze authorisation that names a different freeze (replay)", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-projection-"));
    const audit = new AuditLog(dir, demoPolicy.contentHash);
    const broker = new RiskBroker(demoPolicy, stubAdapter(), audit, dir);
    broker.freeze("first freeze");
    const seq = broker.freezeBinding()!.seq;

    expect(() =>
      broker.unfreeze("I_AM_HUMAN", { address: "0xabc", signature: "0xsig", nonce: "n1", boundTo: String(seq - 1) }),
    ).toThrow(/not bound to the current freeze/);

    const auth = { address: "0xabc", signature: "0xsig", nonce: "n1", boundTo: String(seq) };
    broker.unfreeze("I_AM_HUMAN", auth);
    expect(broker.frozen).toBe(false);

    // The same authorisation can never be spent twice.
    broker.freeze("second freeze");
    expect(() => broker.unfreeze("I_AM_HUMAN", auth)).toThrow(/already spent/);
  });
});
