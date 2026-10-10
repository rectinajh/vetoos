/**
 * Route-level tests for brokerd: auth, body limits, status codes, caches,
 * unfreeze gating, background reconcile. Venue is a stub — no network.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HlAdapter, PlacedOrder } from "@vetoos/adapter-hl";
import { AuditLog } from "@vetoos/audit";
import { makeIntent } from "@vetoos/intent";
import { loadPolicy } from "@vetoos/risk";
import { RiskBroker } from "@vetoos/demo-cli/broker";
import { createContext, handler, reconcileTick, type Context } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const policy = loadPolicy(resolve(here, "../../../configs/policy.demo.json"));

function stubAdapter() {
  let position = 0;
  let orders = 0;
  let reads = { snapshot: 0, fills: 0, openOrders: 0 };
  const openOrders: unknown[] = [];
  const adapter = {
    getMarketSnapshot: async () => {
      reads.snapshot++;
      return { market: "BTC", markPx: 100, funding: 0, openInterest: 1e6, depthWithinBand: 1e4, szDecimals: 2, assetId: 0 };
    },
    getMarketContext: async () => ({ market: "BTC", dex: null, perpDexIndex: 0, metaIndex: 0, assetId: 0, name: "BTC", szDecimals: 2, maxLeverage: 50, markPx: 100, funding: 0, openInterest: 1e6 }),
    getAccountState: async () => ({ equityUsd: 10_000, availableMarginUsd: 8_000, positions: new Map(position ? [["BTC", position]] : []) }),
    getPositionSize: async () => position,
    getPositionDetail: async () => (position ? { size: position, entryPx: 100, positionValue: position * 100, unrealizedPnl: 0, leverage: 1 } : null),
    getRecentFills: async () => {
      reads.fills++;
      return [];
    },
    getRealizedPnlSince: async () => 0,
    getOpenOrders: async () => {
      reads.openOrders++;
      return openOrders;
    },
    placeOrder: async (): Promise<PlacedOrder> => {
      orders++;
      position += 1;
      return { status: "filled", oid: 1000 + orders, filledSize: 1, avgPx: 100, assetId: 0, raw: {} };
    },
  };
  return { adapter: adapter as unknown as HlAdapter, stats: () => ({ position, orders, reads }), openOrders };
}

async function startApp(opts: { publicToken?: string; protectReads?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vetoos-app-"));
  const stub = stubAdapter();
  const audit = new AuditLog(dir, policy.contentHash);
  const broker = new RiskBroker(policy, stub.adapter, audit, dir);
  const ctx = createContext({
    config: { stateDir: dir, accountAddress: "0x0000000000000000000000000000000000000001" },
    policy,
    adapter: stub.adapter,
    broker,
    audit,
    tradeMarket: "BTC",
    options: { build: "test", ...opts },
  });
  const server = createServer(handler(ctx));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  return { dir, ctx, server, base, stub, broker };
}

function intent(size = "1") {
  return makeIntent({ source: "test", market: "BTC", side: "buy", size, order_type: "market" });
}

describe("brokerd routes", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let servers: Server[] = [];
  let dirs: string[] = [];
  beforeEach(async () => {
    app = await startApp();
    servers.push(app.server);
    dirs.push(app.dir);
  });
  afterEach(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    servers = [];
    dirs = [];
  });

  it("GET / serves the dashboard with no-store", async () => {
    const r = await fetch(`${app.base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain("VetoOS");
  });

  it("POST /v1/intents: 200 allow + fill, 422 deny, 400 invalid", async () => {
    const ok = await fetch(`${app.base}/v1/intents`, { method: "POST", body: JSON.stringify(intent("1")) });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { decision: { code: string }; placed: { oid: number } };
    expect(body.decision.code).toBe("ALLOW");
    expect(body.placed.oid).toBe(1001);

    const deny = await fetch(`${app.base}/v1/intents`, { method: "POST", body: JSON.stringify(intent("1000")) });
    expect(deny.status).toBe(422);

    const bad = await fetch(`${app.base}/v1/intents`, {
      method: "POST",
      body: JSON.stringify({ ...intent("1"), max_leverage: 999 }),
    });
    expect(bad.status).toBe(400);
  });

  it("malformed JSON → 400, oversized body → 413 (never 500)", async () => {
    const bad = await fetch(`${app.base}/v1/intents`, { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
    const huge = await fetch(`${app.base}/v1/intents`, { method: "POST", body: "x".repeat(70 * 1024) });
    expect(huge.status).toBe(413);
  });

  it("/v1/stats and /v1/counterfactual reflect decisions from the audit log", async () => {
    await fetch(`${app.base}/v1/intents`, { method: "POST", body: JSON.stringify(intent("1")) });
    await fetch(`${app.base}/v1/intents`, { method: "POST", body: JSON.stringify(intent("1000")) });
    const stats = (await (await fetch(`${app.base}/v1/stats`)).json()) as { allow: number; deny: number; fills: number; byCode: Record<string, number> };
    expect(stats.allow).toBe(1);
    expect(stats.deny).toBe(1);
    expect(stats.fills).toBe(1);
    expect(stats.byCode["NOTIONAL_EXCEEDED"]).toBe(1);
    const cf = (await (await fetch(`${app.base}/v1/counterfactual`)).json()) as { rows: unknown[]; grossNotional: number };
    expect(cf.rows).toHaveLength(1);
    expect(cf.grossNotional).toBe(100_000);
  });

  it("/v1/execution is cached (≥30s) and invalidated by a fill", async () => {
    await fetch(`${app.base}/v1/execution`);
    await fetch(`${app.base}/v1/execution`);
    await fetch(`${app.base}/v1/execution`);
    expect(app.stub.stats().reads.fills).toBe(1);
    await fetch(`${app.base}/v1/intents`, { method: "POST", body: JSON.stringify(intent("1")) });
    await fetch(`${app.base}/v1/execution`);
    expect(app.stub.stats().reads.fills).toBe(2);
  });

  it("/v1/status exposes the audit chain verification", async () => {
    await fetch(`${app.base}/v1/intents`, { method: "POST", body: JSON.stringify(intent("1")) });
    const st = (await (await fetch(`${app.base}/v1/status`)).json()) as { auditChain: { ok: boolean; length: number } };
    expect(st.auditChain.ok).toBe(true);
    expect(st.auditChain.length).toBeGreaterThan(0);
  });

  it("unfreeze requires a human proof; header path works and re-baselines", async () => {
    app.broker.freeze("test");
    const no = await fetch(`${app.base}/v1/unfreeze`, { method: "POST" });
    expect(no.status).toBe(403);
    expect(app.broker.frozen).toBe(true);
    const yes = await fetch(`${app.base}/v1/unfreeze`, { method: "POST", headers: { "x-vetoos-human": "I_AM_HUMAN" } });
    expect(yes.status).toBe(200);
    expect(app.broker.frozen).toBe(false);
    expect(app.broker.status()["baseline"]).toBeTruthy();
  });

  it("wallet-signature path rejects a non-operator signer", async () => {
    app.broker.freeze("test");
    const r = await fetch(`${app.base}/v1/unfreeze`, {
      method: "POST",
      body: JSON.stringify({
        address: "0x000000000000000000000000000000000000dEaD",
        message: `VetoOS human unfreeze\n${new Date().toISOString()}`,
        signature: "0x" + "11".repeat(65),
      }),
    });
    expect(r.status).toBe(403);
    expect(app.broker.frozen).toBe(true);
  });

  it("tamper demo endpoint freezes the broker", async () => {
    const r = await fetch(`${app.base}/v1/demo/tamper`, { method: "POST" });
    const body = (await r.json()) as { frozen: boolean };
    expect(body.frozen).toBe(true);
  });

  it("unknown route → 404", async () => {
    expect((await fetch(`${app.base}/nope`)).status).toBe(404);
  });
});

describe("brokerd write-guard", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  afterEach(async () => {
    await new Promise<void>((r) => app.server.close(() => r()));
    rmSync(app.dir, { recursive: true, force: true });
  });

  it("POST without the token → 401; with token → processed; GET stays open", async () => {
    app = await startApp({ publicToken: "s3cret" });
    const no = await fetch(`${app.base}/v1/intents`, { method: "POST", body: JSON.stringify(intent("1")) });
    expect(no.status).toBe(401);
    const wrongLen = await fetch(`${app.base}/v1/intents`, { method: "POST", headers: { "x-vetoos-token": "s3cre" }, body: "{}" });
    expect(wrongLen.status).toBe(401);
    const yes = await fetch(`${app.base}/v1/intents`, { method: "POST", headers: { "x-vetoos-token": "s3cret" }, body: JSON.stringify(intent("1")) });
    expect(yes.status).toBe(200);
    expect((await fetch(`${app.base}/v1/status`)).status).toBe(200);
  });

  it("protectReads also guards GET /v1/* but not the dashboard HTML", async () => {
    app = await startApp({ publicToken: "s3cret", protectReads: true });
    expect((await fetch(`${app.base}/v1/status`)).status).toBe(401);
    expect((await fetch(`${app.base}/v1/status?token=s3cret`)).status).toBe(200);
    expect((await fetch(`${app.base}/v1/status`, { headers: { "x-vetoos-token": "s3cret" } })).status).toBe(200);
    expect((await fetch(`${app.base}/`)).status).toBe(200);
  });
});

describe("background reconcile loop", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  afterEach(async () => {
    await new Promise<void>((r) => app.server.close(() => r()));
    rmSync(app.dir, { recursive: true, force: true });
  });

  it("first tick sets the baseline; later ticks reconcile and surface resting orders", async () => {
    app = await startApp();
    await reconcileTick(app.ctx);
    expect(app.broker.status()["baseline"]).toBeTruthy();
    expect(app.ctx.lastReconcile).toBeNull();

    await reconcileTick(app.ctx);
    expect(app.ctx.lastReconcile?.ok).toBe(true);
    expect(app.ctx.lastReconcile?.openOrders).toBe(0);

    app.stub.openOrders.push({ coin: "BTC", side: "B", size: 1, px: 90, oid: 7, ts: Date.now() });
    await reconcileTick(app.ctx);
    expect(app.ctx.lastReconcile?.openOrders).toBe(1);
    const risk = (await (await fetch(`${app.base}/v1/risk`)).json()) as { alerts: { text: string }[] };
    expect(risk.alerts.some((a) => /resting order/.test(a.text))).toBe(true);
  });

  it("a position change outside VetoOS trips the session reconcile", async () => {
    app = await startApp();
    await reconcileTick(app.ctx); // baseline at 0
    // Someone trades through the venue UI directly: position moves, ledger doesn't.
    (app.stub.adapter as unknown as { getPositionSize: () => Promise<number> }).getPositionSize = async () => 5;
    await reconcileTick(app.ctx);
    expect(app.ctx.lastReconcile?.ok).toBe(false);
    expect(app.broker.frozen).toBe(true);
  });
});

describe("Context helpers", () => {
  it("createContext starts with empty caches", () => {
    const ctx: Context = createContext({
      config: { stateDir: "/tmp", accountAddress: undefined },
      policy,
      adapter: {} as HlAdapter,
      broker: {} as RiskBroker,
      audit: {} as AuditLog,
      tradeMarket: "BTC",
      options: { build: "x" },
    });
    expect(ctx.caches.execution).toBeNull();
    expect(ctx.caches.cfMarks.size).toBe(0);
  });
});
