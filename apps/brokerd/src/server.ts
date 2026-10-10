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
  marketCache: { at: number; data: unknown } | null;
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
  if (method === "GET" && path === "/v1/market") {
    // Live HIP-3 mainnet context (the data that drives vetoes) + trade market.
    if (ctx.marketCache && Date.now() - ctx.marketCache.at < 5000) {
      json(res, 200, ctx.marketCache.data);
      return;
    }
    const p = ctx.policy.policy;
    const hipBuy = await ctx.adapter.getMarketSnapshot(p.default_market, "mainnet", "buy");
    const hipSell = await ctx.adapter.getMarketSnapshot(p.default_market, "mainnet", "sell");
    const trade = await ctx.adapter.getMarketContext(ctx.tradeMarket, "testnet");
    const data = {
      hip3: {
        market: p.default_market,
        assetId: hipBuy.assetId,
        markPx: hipBuy.markPx,
        funding: hipBuy.funding,
        openInterest: hipBuy.openInterest,
        depthBuy: hipBuy.depthWithinBand,
        depthSell: hipSell.depthWithinBand,
        szDecimals: hipBuy.szDecimals,
      },
      trade: { market: ctx.tradeMarket, markPx: trade.markPx, assetId: trade.assetId },
    };
    ctx.marketCache = { at: Date.now(), data };
    json(res, 200, data);
    return;
  }
  if (method === "GET" && path === "/v1/risk") {
    const p = ctx.policy.policy;
    const account = (await liveAccount(ctx)) as {
      equityUsd: number;
      availableMarginUsd: number;
    };
    const fomoUsed = Math.max(
      ctx.broker.sameSideFillsLastHour(ctx.tradeMarket, "buy"),
      ctx.broker.sameSideFillsLastHour(ctx.tradeMarket, "sell"),
    );
    const lastDeny = ctx.broker.lastDenyTs();
    const cooldownRemainingS =
      lastDeny === undefined
        ? 0
        : Math.max(0, Math.ceil((lastDeny + p.cooldown_seconds_after_deny * 1000 - Date.now()) / 1000));
    const marginUsed = Math.max(0, account.equityUsd - account.availableMarginUsd);
    const marginPct = account.equityUsd > 0 ? marginUsed / account.equityUsd : 0;
    const dailyLossUsed = Math.max(0, -ctx.broker.dailyRealizedPnlUsd);

    const alerts: { level: "crit" | "warn" | "info"; text: string }[] = [];
    if (ctx.broker.frozen) {
      alerts.push({ level: "crit", text: "BROKER FROZEN — reconciliation mismatch, human action required" });
    }
    if (cooldownRemainingS > 0) {
      alerts.push({ level: "warn", text: `cool-down active — ${cooldownRemainingS}s remaining` });
    }
    if (fomoUsed >= p.max_same_side_adds_per_hour - 1 && p.max_same_side_adds_per_hour > 1) {
      alerts.push({
        level: fomoUsed >= p.max_same_side_adds_per_hour ? "crit" : "warn",
        text: `FOMO same-side adds at ${fomoUsed}/${p.max_same_side_adds_per_hour} per hour`,
      });
    }
    if (dailyLossUsed > 0.7 * p.max_daily_loss_usd) {
      alerts.push({
        level: dailyLossUsed >= p.max_daily_loss_usd ? "crit" : "warn",
        text: `daily loss $${dailyLossUsed.toFixed(2)} of $${p.max_daily_loss_usd} breaker`,
      });
    }
    if (marginPct > 0.7) {
      alerts.push({ level: marginPct > 0.9 ? "crit" : "warn", text: `margin utilization ${(marginPct * 100).toFixed(0)}%` });
    }

    json(res, 200, {
      gauges: {
        fomo_adds: { used: fomoUsed, cap: p.max_same_side_adds_per_hour },
        rate_per_min: { used: ctx.broker.submissionsLastMinute(), cap: p.max_orders_per_minute },
        daily_loss: { used: dailyLossUsed, cap: p.max_daily_loss_usd },
        margin_use: { used: marginUsed, cap: account.equityUsd, pct: marginPct },
        cooldown: { remainingS: cooldownRemainingS, capS: p.cooldown_seconds_after_deny },
        notional_cap: { cap: p.max_order_notional_usd },
      },
      alerts,
    });
    return;
  }
  if (method === "GET" && path === "/v1/execution") {
    // Testnet execution side: real position detail + recent venue fills.
    const [position, fills] = await Promise.all([
      ctx.adapter.getPositionDetail(ctx.tradeMarket, WRITE_NETWORK).catch(() => null),
      ctx.adapter.getRecentFills(WRITE_NETWORK, 6).catch(() => []),
    ]);
    json(res, 200, { market: ctx.tradeMarket, position, fills });
    return;
  }
  if (method === "GET" && path === "/v1/stats") {
    // Decision statistics from today's audit log — the dashboard's track record.
    const events = readFeed(ctx, 500) as {
      type: string;
      data?: { decision?: string; code?: string };
    }[];
    let allow = 0;
    let deny = 0;
    let freeze = 0;
    let fills = 0;
    const byCode: Record<string, number> = {};
    for (const ev of events) {
      if (ev.type === "decision") {
        if (ev.data?.decision === "allow") allow++;
        else {
          deny++;
          const code = ev.data?.code ?? "INVALID";
          byCode[code] = (byCode[code] ?? 0) + 1;
        }
      } else if (ev.type === "freeze") freeze++;
      else if (ev.type === "order_placed") fills++;
    }
    json(res, 200, { allow, deny, freeze, fills, byCode });
    return;
  }
  if (method === "GET" && path === "/v1/counterfactual") {
    // "Without the gate": replay denied intents as if they had filled at the
    // deny-time mark, and value them at the CURRENT mainnet mark.
    const events = readFeed(ctx, 500) as {
      ts: string;
      type: string;
      data?: {
        decision?: string;
        code?: string;
        duplicate?: boolean;
        snapshot?: { market?: string; side?: "buy" | "sell"; size?: string; mark_px?: number; notional_usd?: number };
      };
    }[];
    const denied = events.filter(
      (ev) =>
        ev.type === "decision" &&
        ev.data?.decision === "deny" &&
        !ev.data.duplicate &&
        ev.data.snapshot?.market &&
        ev.data.snapshot.size &&
        ev.data.snapshot.mark_px,
    );
    const marks = new Map<string, number>();
    const rows: {
      ts: string;
      market: string;
      side: string;
      size: number;
      entryPx: number;
      nowPx: number;
      pnl: number;
      code: string;
    }[] = [];
    for (const ev of denied.slice(-12)) {
      const s = ev.data!.snapshot!;
      const market = s.market!;
      if (!marks.has(market)) {
        try {
          const mctx = await ctx.adapter.getMarketContext(market, READ_NETWORK);
          marks.set(market, mctx.markPx);
        } catch {
          continue;
        }
      }
      const nowPx = marks.get(market)!;
      const size = Number(s.size);
      const entryPx = Number(s.mark_px);
      const sign = s.side === "sell" ? -1 : 1;
      rows.push({
        ts: ev.ts,
        market,
        side: s.side ?? "buy",
        size,
        entryPx,
        nowPx,
        pnl: sign * size * (nowPx - entryPx),
        code: ev.data!.code ?? "DENY",
      });
    }
    const avoidedLoss = rows.reduce((acc, r) => acc + Math.max(0, -r.pnl), 0);
    const missedGain = rows.reduce((acc, r) => acc + Math.max(0, r.pnl), 0);
    const grossNotional = rows.reduce((acc, r) => acc + r.size * r.entryPx, 0);
    const account = (await liveAccount(ctx)) as { equityUsd: number };
    const worstLeverage = account.equityUsd > 0 ? grossNotional / account.equityUsd : 0;
    json(res, 200, {
      rows,
      avoidedLoss,
      missedGain,
      grossNotional,
      equityUsd: account.equityUsd,
      worstLeverage,
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
    marketCache: null,
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
