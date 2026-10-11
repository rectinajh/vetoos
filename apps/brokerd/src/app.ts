/**
 * brokerd HTTP application — routes, caches, auth and the background
 * reconciliation loop. Pure functions of a `Context`, so the whole thing is
 * unit-testable with a stubbed adapter/broker (see app.test.ts). The process
 * entry point (config, key loading, listen) lives in server.ts.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { verifyMessage } from "viem";
import type { HlAdapter } from "@vetoos/adapter-hl";
import { readAuditFile, verifyChain, type AuditEvent, type AuditLog } from "@vetoos/audit";
import type { LoadedPolicy } from "@vetoos/risk";
import { RiskBroker, READ_NETWORK, WRITE_NETWORK } from "@vetoos/demo-cli/broker";
import type { CliConfig } from "@vetoos/demo-cli/config";
import { renderDashboard } from "./dashboard.js";
import { renderOpenApi } from "./openapi.js";
import { heuristicReport, llmReport, type AiRiskInputs } from "./ai-risk.js";

export const HUMAN_HEADER = "x-vetoos-human";
export const HUMAN_TOKEN = "I_AM_HUMAN";
export const TOKEN_HEADER = "x-vetoos-token";

/** Request body ceiling — an Intent IR is a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Cache TTLs (ms). The dashboard polls every 2s; venue reads must not. */
export const TTL = {
  account: 2_500,
  market: 6_000,
  execution: 30_000,
  cfMarks: 30_000,
  aiRisk: 30_000,
  auditChain: 10_000,
} as const;

/** Background loop cadence: whole-session reconcile + daily PnL refresh. */
export const RECONCILE_LOOP_MS = 60_000;

/** How long a human unfreeze authorisation stays valid. */
export const UNFREEZE_TTL_MS = 10 * 60_000;

export interface UnfreezeAuthorisation {
  action: string;
  frozenAtSeq: string;
  chainHead: string;
  nonce: string;
  expiresAt: string;
}

/**
 * The exact bytes a human signs. Deliberately NOT a free-form string: it names
 * the freeze it releases (seq + chain head) and carries a one-time nonce, so an
 * authorisation for yesterday's freeze cannot open today's.
 */
export function unfreezeMessage(a: {
  seq: number;
  chainHead: string;
  nonce: string;
  expiresAt: string;
}): string {
  return [
    "VetoOS human unfreeze",
    "action=UNFREEZE",
    "frozenAtSeq=" + a.seq,
    "chainHead=" + a.chainHead,
    "nonce=" + a.nonce,
    "expiresAt=" + a.expiresAt,
  ].join("\n");
}

/** Parse and shape-check an unfreeze authorisation. Returns null when malformed. */
export function parseUnfreezeMessage(message: string): UnfreezeAuthorisation | null {
  const lines = message.split("\n");
  if (lines[0]?.trim() !== "VetoOS human unfreeze") return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const action = fields["action"];
  const frozenAtSeq = fields["frozenAtSeq"];
  const chainHead = fields["chainHead"];
  const nonce = fields["nonce"];
  const expiresAt = fields["expiresAt"];
  if (action !== "UNFREEZE" || !frozenAtSeq || !chainHead || !nonce || !expiresAt) return null;
  if (!Number.isFinite(Date.parse(expiresAt))) return null;
  return { action, frozenAtSeq, chainHead, nonce, expiresAt };
}

export interface AppOptions {
  /** When set, POSTs (and GETs if `protectReads`) require this token. */
  publicToken?: string;
  /** Also require the token on GET /v1/* (dashboard HTML stays open). */
  protectReads?: boolean;
  /** Canned venue (FixtureAdapter) — surfaced on /v1/status and the console. */
  offline?: boolean;
  build: string;
}

interface Cache<T> {
  at: number;
  data: T;
}

export interface Context {
  config: Pick<CliConfig, "stateDir" | "accountAddress">;
  policy: LoadedPolicy;
  adapter: HlAdapter;
  broker: RiskBroker;
  audit: AuditLog;
  tradeMarket: string;
  startedAt: string;
  options: AppOptions;
  caches: {
    account: Cache<unknown> | null;
    market: Cache<unknown> | null;
    execution: Cache<unknown> | null;
    cfMarks: Map<string, Cache<number>>;
    aiRisk: Cache<unknown> | null;
    auditChain: Cache<unknown> | null;
  };
  /** Last background reconcile outcome, surfaced on /v1/status. */
  lastReconcile: { ts: string; ok: boolean; openOrders: number } | null;
}

export function createContext(
  base: Omit<Context, "caches" | "lastReconcile" | "startedAt">,
): Context {
  return {
    ...base,
    startedAt: new Date().toISOString(),
    caches: { account: null, market: null, execution: null, cfMarks: new Map(), aiRisk: null, auditChain: null },
    lastReconcile: null,
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "malformed JSON body");
  }
}

/** Constant-time token comparison; both inputs are short ASCII. */
export function tokenMatches(presented: string | string[] | undefined, expected: string): boolean {
  const p = Buffer.from(Array.isArray(presented) ? (presented[0] ?? "") : (presented ?? ""), "utf8");
  const e = Buffer.from(expected, "utf8");
  if (p.length !== e.length) return false;
  return timingSafeEqual(p, e);
}

function presentedToken(req: IncomingMessage, url: URL): string | undefined {
  const h = req.headers[TOKEN_HEADER];
  if (typeof h === "string") return h;
  if (Array.isArray(h)) return h[0];
  return url.searchParams.get("token") ?? undefined;
}

/** Today's audit JSONL, lenient to a half-written last line. */
export function readFeed(ctx: Context, limit: number): AuditEvent[] {
  const day = new Date().toISOString().slice(0, 10);
  const file = join(ctx.config.stateDir, `audit-${day}.jsonl`);
  if (!existsSync(file)) return [];
  const events = readAuditFile(file);
  return events.slice(-limit);
}

function auditChainStatus(ctx: Context): unknown {
  const c = ctx.caches.auditChain;
  if (c && Date.now() - c.at < TTL.auditChain) return c.data;
  const day = new Date().toISOString().slice(0, 10);
  const file = join(ctx.config.stateDir, `audit-${day}.jsonl`);
  const data = verifyChain(readAuditFile(file));
  ctx.caches.auditChain = { at: Date.now(), data };
  return data;
}

async function liveAccount(ctx: Context): Promise<{
  equityUsd: number;
  availableMarginUsd: number;
  positionSize: number;
}> {
  const c = ctx.caches.account;
  if (c && Date.now() - c.at < TTL.account) return c.data as never;
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
  ctx.caches.account = { at: Date.now(), data };
  return data;
}

function riskCounters(ctx: Context, account: { equityUsd: number; availableMarginUsd: number }) {
  const p = ctx.policy.policy;
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
  return { p, fomoUsed, cooldownRemainingS, marginUsed, marginPct, dailyLossUsed };
}

/**
 * Background truth loop (P1-11): whole-session reconcile against the
 * baseline, venue-sourced daily PnL refresh, and a resting-order sweep.
 * Anything resting escaped the IOC fill-or-kill path and is audited.
 */
export async function reconcileTick(ctx: Context): Promise<void> {
  if (!ctx.broker.status()["baseline"]) {
    await ctx.broker.setBaseline(ctx.tradeMarket);
    return;
  }
  await ctx.broker.refreshDailyPnl(true).catch(() => undefined);
  let openOrders = 0;
  try {
    const orders = await ctx.adapter.getOpenOrders(WRITE_NETWORK);
    openOrders = orders.length;
    if (orders.length > 0) {
      ctx.audit.record("error", {
        where: "reconcileTick",
        note: "resting orders found outside the fill-or-kill path",
        orders,
      });
    }
  } catch {
    // read failure: reported via lastReconcile.ok below
  }
  let ok = false;
  try {
    const r = ctx.broker.frozen ? { ok: false } : await ctx.broker.reconcileNow(ctx.tradeMarket);
    ok = r.ok;
  } catch (err) {
    ctx.audit.record("error", {
      where: "reconcileTick",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  ctx.lastReconcile = { ts: new Date().toISOString(), ok, openOrders };
}

export async function route(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const token = ctx.options.publicToken;

  if (token) {
    const needs = method === "POST" || (ctx.options.protectReads && path.startsWith("/v1/"));
    if (needs && !tokenMatches(presentedToken(req, url), token)) {
      json(res, 401, { error: `missing or invalid ${TOKEN_HEADER} (service is exposed via a tunnel)` });
      return;
    }
  }

  if (method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderDashboard(ctx.options.build, ctx.options.publicToken ?? ""));
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
      build: ctx.options.build,
      offline: ctx.options.offline === true,
      auditChain: auditChainStatus(ctx),
      lastReconcile: ctx.lastReconcile,
      dailyRealizedPnlUsd: ctx.broker.dailyRealizedPnlUsd,
    });
    return;
  }
  if (method === "GET" && path === "/v1/account") {
    json(res, 200, await liveAccount(ctx));
    return;
  }
  if (method === "GET" && path === "/v1/policy") {
    json(res, 200, { policy: ctx.policy.policy, contentHash: ctx.policy.contentHash, path: ctx.policy.path });
    return;
  }
  if (method === "GET" && path === "/v1/audit/verify") {
    ctx.caches.auditChain = null;
    json(res, 200, auditChainStatus(ctx));
    return;
  }
  if (method === "GET" && path === "/v1/market") {
    const c = ctx.caches.market;
    if (c && Date.now() - c.at < TTL.market) {
      json(res, 200, c.data);
      return;
    }
    const p = ctx.policy.policy;
    const hipBuy = await ctx.adapter.getMarketSnapshot(p.default_market, READ_NETWORK, "buy");
    const hipSell = await ctx.adapter.getMarketSnapshot(p.default_market, READ_NETWORK, "sell");
    const trade = await ctx.adapter.getMarketContext(ctx.tradeMarket, WRITE_NETWORK);
    const data = {
      hip3: {
        market: p.default_market,
        network: READ_NETWORK,
        assetId: hipBuy.assetId,
        markPx: hipBuy.markPx,
        funding: hipBuy.funding,
        openInterest: hipBuy.openInterest,
        depthBuy: hipBuy.depthWithinBand,
        depthSell: hipSell.depthWithinBand,
        szDecimals: hipBuy.szDecimals,
      },
      trade: { market: ctx.tradeMarket, network: WRITE_NETWORK, markPx: trade.markPx, assetId: trade.assetId },
    };
    ctx.caches.market = { at: Date.now(), data };
    json(res, 200, data);
    return;
  }
  if (method === "GET" && path === "/v1/risk") {
    const account = await liveAccount(ctx);
    const { p, fomoUsed, cooldownRemainingS, marginUsed, marginPct, dailyLossUsed } = riskCounters(ctx, account);
    const alerts: { level: "crit" | "warn" | "info"; text: string }[] = [];
    if (ctx.broker.frozen) {
      alerts.push({ level: "crit", text: "BROKER FROZEN — reconciliation mismatch, human action required" });
    }
    if (cooldownRemainingS > 0) alerts.push({ level: "warn", text: `cool-down active — ${cooldownRemainingS}s remaining` });
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
    if (ctx.lastReconcile && ctx.lastReconcile.openOrders > 0) {
      alerts.push({ level: "warn", text: `${ctx.lastReconcile.openOrders} resting order(s) outside the fill-or-kill path` });
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
    const c = ctx.caches.execution;
    if (c && Date.now() - c.at < TTL.execution) {
      json(res, 200, c.data);
      return;
    }
    const [position, fills] = await Promise.all([
      ctx.adapter.getPositionDetail(ctx.tradeMarket, WRITE_NETWORK).catch(() => null),
      ctx.adapter.getRecentFills(WRITE_NETWORK, 6).catch(() => []),
    ]);
    const data = { market: ctx.tradeMarket, network: WRITE_NETWORK, position, fills, at: new Date().toISOString() };
    ctx.caches.execution = { at: Date.now(), data };
    json(res, 200, data);
    return;
  }
  if (method === "GET" && path === "/v1/stats") {
    const events = readFeed(ctx, 500) as (AuditEvent & { data: { decision?: string; code?: string; duplicate?: boolean; filledSize?: number } })[];
    let allow = 0, deny = 0, freeze = 0, fills = 0;
    const byCode: Record<string, number> = {};
    for (const ev of events) {
      if (ev.type === "decision") {
        if (ev.data.duplicate) continue;
        if (ev.data.decision === "allow") allow++;
        else {
          deny++;
          const code = ev.data.code ?? "INVALID";
          byCode[code] = (byCode[code] ?? 0) + 1;
        }
      } else if (ev.type === "freeze") freeze++;
      else if (ev.type === "order_placed" && (ev.data.filledSize ?? 0) > 0) fills++;
    }
    json(res, 200, { allow, deny, freeze, fills, byCode });
    return;
  }
  if (method === "GET" && path === "/v1/counterfactual") {
    // "Without the gate": replay denied intents as if they had filled at the
    // deny-time READ-network mark, valued at the current READ-network mark.
    // Marks are cached 30s — the rows themselves come from the local audit file.
    type DenyEv = AuditEvent & {
      data: {
        decision?: string;
        code?: string;
        duplicate?: boolean;
        snapshot?: { market?: string; side?: "buy" | "sell"; size?: string; mark_px?: number; mark_px_read?: number };
      };
    };
    const denied = (readFeed(ctx, 500) as DenyEv[]).filter(
      (ev) =>
        ev.type === "decision" &&
        ev.data.decision === "deny" &&
        !ev.data.duplicate &&
        ev.data.snapshot?.market &&
        ev.data.snapshot.size &&
        (ev.data.snapshot.mark_px_read ?? ev.data.snapshot.mark_px),
    );
    const rows: { ts: string; market: string; side: string; size: number; entryPx: number; nowPx: number; pnl: number; code: string }[] = [];
    for (const ev of denied.slice(-12)) {
      const s = ev.data.snapshot!;
      const market = s.market!;
      let mark = ctx.caches.cfMarks.get(market);
      if (!mark || Date.now() - mark.at > TTL.cfMarks) {
        try {
          const mctx = await ctx.adapter.getMarketContext(market, READ_NETWORK);
          mark = { at: Date.now(), data: mctx.markPx };
          ctx.caches.cfMarks.set(market, mark);
        } catch {
          if (!mark) continue; // never shown a made-up mark
        }
      }
      const nowPx = mark.data;
      const size = Number(s.size);
      const entryPx = Number(s.mark_px_read ?? s.mark_px);
      const sign = s.side === "sell" ? -1 : 1;
      rows.push({ ts: ev.ts, market, side: s.side ?? "buy", size, entryPx, nowPx, pnl: sign * size * (nowPx - entryPx), code: ev.data.code ?? "DENY" });
    }
    const avoidedLoss = rows.reduce((acc, r) => acc + Math.max(0, -r.pnl), 0);
    const missedGain = rows.reduce((acc, r) => acc + Math.max(0, r.pnl), 0);
    const grossNotional = rows.reduce((acc, r) => acc + r.size * r.entryPx, 0);
    const account = await liveAccount(ctx);
    json(res, 200, {
      rows,
      avoidedLoss,
      missedGain,
      grossNotional,
      equityUsd: account.equityUsd,
      worstLeverage: account.equityUsd > 0 ? grossNotional / account.equityUsd : 0,
      network: READ_NETWORK,
    });
    return;
  }
  if (method === "GET" && path === "/v1/ai-risk") {
    const c = ctx.caches.aiRisk;
    if (c && Date.now() - c.at < TTL.aiRisk) {
      json(res, 200, c.data);
      return;
    }
    const account = await liveAccount(ctx);
    const { p, fomoUsed, cooldownRemainingS, marginPct, dailyLossUsed } = riskCounters(ctx, account);
    let liquidityUtilPct: number | null = null;
    try {
      const snap = await ctx.adapter.getMarketSnapshot(ctx.tradeMarket, WRITE_NETWORK, "buy");
      const maxSize = p.max_order_notional_usd / snap.markPx;
      const required = maxSize * p.min_book_depth_multiple;
      liquidityUtilPct = snap.depthWithinBand > 0 ? Math.min(100, (required / snap.depthWithinBand) * 100) : 100;
    } catch {
      liquidityUtilPct = null; // unknown is reported as unknown — never a comforting 50
    }
    const inputs: AiRiskInputs = {
      frozen: ctx.broker.frozen,
      fomoUsed,
      fomoCap: p.max_same_side_adds_per_hour,
      rateUsed: ctx.broker.submissionsLastMinute(),
      rateCap: p.max_orders_per_minute,
      dailyLossUsed,
      dailyLossCap: p.max_daily_loss_usd,
      marginPct,
      cooldownRemainingS,
      deniesLastHour: ctx.broker.deniesLastHour(),
      liquidityUtilPct,
      equityUsd: account.equityUsd,
      tradeMarket: ctx.tradeMarket,
    };
    const report = (await llmReport(inputs)) ?? heuristicReport(inputs);
    ctx.caches.aiRisk = { at: Date.now(), data: report };
    json(res, 200, report);
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
    if (result.placed) ctx.caches.execution = null; // show the fill immediately
    if (result.validationError) {
      json(res, 400, result);
    } else if (result.error) {
      json(res, 502, result); // allowed, but the venue write failed — intent burned
    } else {
      json(res, result.decision?.decision === "allow" ? 200 : 422, result);
    }
    return;
  }
  if (method === "POST" && path === "/v1/demo/tamper") {
    // DEMO ONLY: inject a fill that never happened, then reconcile.
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
  if (method === "POST" && path === "/v1/ai/commit") {
    // Commit phase: the advice digest is locked in BEFORE the verdict exists,
    // so the record cannot be back-dated once the outcome is known.
    const body = (await readBody(req)) as { adviceHash?: string; modelId?: string; promptHash?: string };
    const adviceHash = String(body.adviceHash ?? "");
    if (!/^[0-9a-f]{64}$/.test(adviceHash)) {
      throw new HttpError(400, "adviceHash must be a 64-char sha256 hex digest of commitmentHash(nonce, advice)");
    }
    const event = ctx.broker.commitAdvice(adviceHash, {
      ...(body.modelId ? { modelId: String(body.modelId) } : {}),
      ...(body.promptHash ? { promptHash: String(body.promptHash) } : {}),
    });
    json(res, 200, { seq: event.seq, adviceHash, receiptHash: event.hash });
    return;
  }
  if (method === "POST" && path === "/v1/ai/reveal") {
    // Reveal phase: publish the advice that opens the earlier commitment. The
    // broker rejects it unless some verdict actually bound that commitment.
    const body = (await readBody(req)) as { nonce?: string; advice?: unknown };
    if (!body.nonce) throw new HttpError(400, "reveal requires the nonce used at commit time");
    try {
      const event = ctx.broker.revealAdvice(String(body.nonce), body.advice);
      json(res, 200, { seq: event.seq, adviceHash: event.aiAdviceHash });
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (method === "GET" && path === "/v1/freeze-binding") {
    // What a human must sign to release the CURRENT freeze. The nonce is
    // one-time and the binding names the exact frozen state, so a signature
    // can never be replayed against a later freeze.
    const binding = ctx.broker.freezeBinding();
    if (!binding) {
      json(res, 200, { frozen: false, binding: null });
      return;
    }
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + UNFREEZE_TTL_MS).toISOString();
    json(res, 200, {
      frozen: true,
      binding,
      expiresAt,
      message: unfreezeMessage({ seq: binding.seq, chainHead: binding.hash, nonce, expiresAt }),
    });
    return;
  }
  if (method === "POST" && path === "/v1/unfreeze") {
    const body = (await readBody(req).catch(() => ({}))) as { address?: string; message?: string; signature?: `0x${string}` };
    let via: string | null = null;
    let auth: { address: string; signature: string; nonce: string; boundTo: string } | undefined;
    if (body.address && body.message && body.signature) {
      // Path A: wallet-signed proof of humanity (EIP-191), operator account
      // only, and BOUND to the frozen state it releases.
      const parsed = parseUnfreezeMessage(body.message);
      const binding = ctx.broker.freezeBinding();
      const problems: string[] = [];
      if (!parsed) problems.push("message is not a VetoOS unfreeze authorisation");
      if (parsed && Date.parse(parsed.expiresAt) < Date.now()) problems.push("authorisation expired");
      if (parsed && !binding) problems.push("broker is not frozen");
      if (parsed && binding && parsed.frozenAtSeq !== String(binding.seq)) {
        problems.push("authorisation names freeze seq " + parsed.frozenAtSeq + ", current is " + binding.seq);
      }
      if (parsed && binding && parsed.chainHead !== binding.hash) {
        problems.push("authorisation names a different chain head");
      }
      let signatureOk = false;
      if (problems.length === 0) {
        try {
          signatureOk =
            body.address.toLowerCase() === (ctx.config.accountAddress ?? "").toLowerCase() &&
            (await verifyMessage({
              address: body.address as `0x${string}`,
              message: body.message,
              signature: body.signature,
            }));
        } catch {
          signatureOk = false;
        }
        if (!signatureOk) problems.push("signature is not from the operator account");
      }
      if (problems.length > 0 || !parsed) {
        json(res, 403, {
          error: problems.join("; ") || "invalid unfreeze authorisation",
          hint: "GET /v1/freeze-binding returns the exact message to sign",
        });
        return;
      }
      auth = {
        address: body.address,
        signature: body.signature,
        nonce: parsed.nonce,
        boundTo: parsed.frozenAtSeq,
      };
      via = "wallet-signature";
    } else if (req.headers[HUMAN_HEADER] === HUMAN_TOKEN) {
      // Path B: explicit human header (CLI / judges without a wallet). No
      // cryptographic binding — the unfreeze receipt records it as such.
      via = "local-token";
    }
    if (!via) {
      json(res, 403, { error: `unfreeze requires a wallet signature (operator account) or header ${HUMAN_HEADER}: ${HUMAN_TOKEN}` });
      return;
    }
    ctx.broker.unfreeze(HUMAN_TOKEN, auth);
    // A human reset re-baselines the session so the background loop measures
    // from the clean state, not from the tampered window.
    await ctx.broker.setBaseline(ctx.tradeMarket).catch(() => undefined);
    json(res, 200, { frozen: ctx.broker.frozen, via, ...(auth ? { boundTo: auth.boundTo } : {}) });
    return;
  }
  json(res, 404, { error: `no route: ${method} ${path}` });
}

/** Node request handler with error mapping (HttpError → status, else 500). */
export function handler(ctx: Context): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    route(ctx, req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.message });
      } else {
        json(res, 500, { error: String(err instanceof Error ? err.message : err) });
      }
    });
  };
}
