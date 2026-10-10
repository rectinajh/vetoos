import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerStore } from "./ledger.js";
import { lotSize, reconcileFills, signedDelta, type FillRecord } from "./index.js";

const OPTS = { tolerancePct: 0.005, freezeOnMismatch: true };

function fill(overrides: Partial<FillRecord> = {}): FillRecord {
  return {
    intentId: "11111111-1111-4111-8111-111111111111",
    market: "xyz:XYZ100",
    side: "buy",
    size: 1,
    avgPx: 100,
    oid: 42,
    ts: 1_760_000_000_000,
    szDecimals: 2,
    ...overrides,
  };
}

describe("signedDelta / lotSize", () => {
  it("buy is positive, sell is negative", () => {
    expect(signedDelta("buy", 2)).toBe(2);
    expect(signedDelta("sell", 2)).toBe(-2);
  });
  it("lot size follows szDecimals", () => {
    expect(lotSize(2)).toBe(0.01);
    expect(lotSize(0)).toBe(1);
  });
});

describe("reconcileFills", () => {
  it("passes when the venue position moved exactly by the fill", () => {
    const r = reconcileFills([fill()], 0, 1, 2, OPTS);
    expect(r.ok).toBe(true);
    expect(r.shouldFreeze).toBe(false);
  });

  it("passes within the 0.5% tolerance (boundary)", () => {
    const r = reconcileFills([fill({ size: 100 })], 0, 100.4, 2, OPTS);
    expect(r.ok).toBe(true);
  });

  it("freezes beyond tolerance (boundary)", () => {
    const r = reconcileFills([fill({ size: 100 })], 0, 100.6, 2, OPTS);
    expect(r.ok).toBe(false);
    expect(r.shouldFreeze).toBe(true);
    expect(r.reason_zh).toContain("账实不符");
  });

  it("nets multiple fills before comparing", () => {
    const r = reconcileFills([fill(), fill({ side: "sell", size: 0.5 })], 0, 0.5, 2, OPTS);
    expect(r.ok).toBe(true);
  });

  it("catches a tampered ledger (fill recorded that never happened)", () => {
    // Demo act 4: ledger claims +1, venue shows no change.
    const r = reconcileFills([fill(), fill({ intentId: "tampered", size: 0.05 })], 0, 1, 2, OPTS);
    expect(r.ok).toBe(false);
    expect(r.shouldFreeze).toBe(true);
  });

  it("catches a position that moved with zero local fills", () => {
    const r = reconcileFills([], 0, 0.5, 2, OPTS);
    expect(r.ok).toBe(false);
    expect(r.shouldFreeze).toBe(true);
  });

  it("respects freezeOnMismatch=false", () => {
    const r = reconcileFills([fill()], 0, 5, 2, { ...OPTS, freezeOnMismatch: false });
    expect(r.ok).toBe(false);
    expect(r.shouldFreeze).toBe(false);
  });
});

describe("LedgerStore", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("appends and lists fills", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-ledger-"));
    const store = new LedgerStore(join(dir, "ledger.jsonl"));
    store.append(fill());
    store.append(fill({ oid: 43, side: "sell" }));
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all[1]?.side).toBe("sell");
  });

  it("filters by since()", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-ledger-"));
    const store = new LedgerStore(join(dir, "ledger.jsonl"));
    store.append(fill({ ts: 100 }));
    store.append(fill({ ts: 200 }));
    expect(store.since(150)).toHaveLength(1);
  });

  it("marks tampered injections visibly", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-ledger-"));
    const store = new LedgerStore(join(dir, "ledger.jsonl"));
    store.injectTamperedFill(fill());
    const all = store.list();
    expect(String(all[0]?.oid)).toContain("TAMPERED");
  });
});
