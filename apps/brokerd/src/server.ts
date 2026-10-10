#!/usr/bin/env tsx
/**
 * vetoos brokerd — the Risk Broker as a long-running service.
 *
 * Strategies and AI proposers talk HTTP; only this process holds keys.
 * Binds to localhost by default. The unfreeze endpoint is gated behind a
 * human confirmation header — there is intentionally no way for a model
 * to release the brake.
 *
 *   pnpm brokerd          → http://127.0.0.1:4310  (dashboard + API)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HlAdapter } from "@vetoos/adapter-hl";
import { AuditLog } from "@vetoos/audit";
import { loadPolicy, type LoadedPolicy } from "@vetoos/risk";
import { RiskBroker, READ_NETWORK, WRITE_NETWORK } from "@vetoos/demo-cli/broker";
import { assertPolicyExists, loadConfig, type CliConfig } from "@vetoos/demo-cli/config";
import { renderDashboard } from "./dashboard.js";
import { renderOpenApi } from "./openapi.js";

const HUMAN_HEADER = "x-vetoos-human";
const HUMAN_TOKEN = "I_AM_HUMAN";

interface Context {
  config: CliConfig;
  policy: LoadedPolicy;
  adapter: HlAdapter;
  broker: RiskBroker;
  tradeMarket: string;
  startedAt: string;
  accountCache: { at: number; data: unknown } | null;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

/** Tail-read today's audit JSONL for the dashboard/feed. */
function readFeed(ctx: Context, limit: number): unknown[] {
  const day = new Date().toISOString().slice(0, 10);
  const file = join(ctx.config.stateDir, `audit-${day}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-limit).map((l) => JSON.parse(l) as unknown);
}

async function liveAccount(ctx: Context): Promise<unknown> {
  if (ctx.accountCache && Date.now() - ctx.accountCache.at < 2500) return ctx.accountCache.data;
  const state = await ctx.adapter.getAccountState(WRITE_NETWORK);
  const position = await ctx.adapter.getPositionSize(ctx.tradeMarket, WRITE_NETWORK);
  const data = {
    network: WRITE_NETWORK,
    tradeMarket: ctx.tradeMarket,
    equityUsd: state.equityUsd,
    availableMarginUsd: state.availableMarginUsd,
    positionSize: position,
    positions: Object.fromEntries(state.positions),
  };
  ctx.accountCache = { at: Date.now(), data };
  return data;
}

async function route(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard());
    return;
  }
  if (method === "GET" && path === "/openapi.json") {
    json(res, 200, renderOpenApi());
    return;
  }
  if (method === "GET" && path === "/v1/status") {
    json(res, 200, {
      ...ctx.broker.status(),
      tradeMarket: ctx.tradeMarket,
      readNetwork: READ_NETWORK,
      writeNetwork: WRITE_NETWORK,
      startedAt: ctx.startedAt,
    });
    return;
  }
  if (method === "GET" && path === "/v1/account") {
    json(res, 200, await liveAccount(ctx));
    return;
  }
  if (method === "GET" && path === "/v1/policy") {
    json(res, 200, {
      policy: ctx.policy.policy,
      contentHash: ctx.policy.contentHash,
      path: ctx.policy.path,
    });
    return;
  }
  if (method === "GET" && path === "/v1/feed") {
    const n = Math.min(Number(url.searchParams.get("n") ?? 50) || 50, 500);
    json(res, 200, { events: readFeed(ctx, n) });
    return;
  }
  if (method === "POST" && path === "/v1/intents") {
    const body = await readBody(req);
    const result = await ctx.broker.submitIntent(body);
    if (result.validationError) {
      json(res, 400, result);
    } else {
      json(res, result.decision?.decision === "allow" ? 200 : 422, result);
    }
    return;
  }
  if (method === "POST" && path === "/v1/demo/tamper") {
    // DEMO ONLY (localhost): inject a fill that never happened, then reconcile.
    // This is what makes the freeze provable live from the console.
    const market = ctx.tradeMarket;
    const marketCtx = await ctx.adapter.getMarketContext(market, WRITE_NETWORK);
    ctx.broker.ledger.injectTamperedFill({
      intentId: crypto.randomUUID(),
      market,
      side: "buy",
      size: 100 * Math.pow(10, -marketCtx.szDecimals),
      avgPx: marketCtx.markPx,
      oid: Date.now(),
      ts: Date.now(),
      szDecimals: marketCtx.szDecimals,
    });
    const result = await ctx.broker.reconcileNow(market);
    json(res, 200, { tampered: true, reconcile: result, frozen: ctx.broker.frozen });
    return;
  }
  if (method === "POST" && path === "/v1/unfreeze") {
    if (req.headers[HUMAN_HEADER] !== HUMAN_TOKEN) {
      json(res, 403, {
        error: `unfreeze requires header ${HUMAN_HEADER}: ${HUMAN_TOKEN} — humans only`,
      });
      return;
    }
    ctx.broker.unfreeze(HUMAN_TOKEN);
    json(res, 200, { frozen: ctx.broker.frozen });
    return;
  }
  json(res, 404, { error: `no route: ${method} ${path}` });
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertPolicyExists(config.policyPath);
  const policy = loadPolicy(config.policyPath);
  if (!config.privateKey || !config.accountAddress) {
    throw new Error("HL_PRIVATE_KEY and HL_ACCOUNT_ADDRESS required — docs/TESTNET_SETUP.md");
  }
  const adapter = new HlAdapter(config);
  const audit = new AuditLog(config.stateDir, policy.contentHash);
  const broker = new RiskBroker(policy, adapter, audit, config.stateDir);
  await broker.init(); // fail closed on missing real market data

  // Same trade-market resolution as the demo: env pin → policy default → BTC.
  const tradeMarket =
    config.tradeMarket ??
    (await adapter
      .getMarketContext(policy.policy.default_market, "testnet")
      .then(() => policy.policy.default_market)
      .catch(() => "BTC"));

  const ctx: Context = {
    config,
    policy,
    adapter,
    broker,
    tradeMarket,
    startedAt: new Date().toISOString(),
    accountCache: null,
  };

  const port = Number(process.env.VETOOS_PORT ?? 4399); // 4310 collides with common apps
  const host = process.env.VETOOS_HOST ?? "127.0.0.1";
  const server = createServer((req, res) => {
    route(ctx, req, res).catch((err: unknown) => {
      json(res, 500, { error: String(err instanceof Error ? err.message : err) });
    });
  });
  server.listen(port, host, () => {
    console.log(`[brokerd] VetoOS broker listening on http://${host}:${port}`);
    console.log(`[brokerd] dashboard → http://${host}:${port}/  ·  API → /v1/*  ·  OpenAPI → /openapi.json`);
    console.log(`[brokerd] policy ${policy.contentHash.slice(0, 12)}… · trade market ${tradeMarket} · frozen=${broker.frozen}`);
  });
}

main().catch((err: unknown) => {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
