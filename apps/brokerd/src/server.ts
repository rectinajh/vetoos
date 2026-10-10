#!/usr/bin/env tsx
/**
 * vetoos brokerd — the Risk Broker as a long-running service.
 *
 * Strategies and AI proposers talk HTTP; only this process holds keys.
 * Binds to localhost by default. The unfreeze endpoint is gated behind a
 * human confirmation (wallet signature or explicit header) — there is
 * intentionally no way for a model to release the brake.
 *
 *   pnpm brokerd          → http://127.0.0.1:4399  (dashboard + API)
 *
 * Env:
 *   VETOOS_PORT / VETOOS_HOST        bind address (default 127.0.0.1:4399)
 *   VETOOS_PUBLIC_TOKEN              required on POST when exposed via a tunnel
 *   VETOOS_PROTECT_READS=1           also require the token on GET /v1/*
 */

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HlAdapter } from "@vetoos/adapter-hl";
import { FixtureAdapter } from "@vetoos/adapter-hl/fixture";
import { AuditLog } from "@vetoos/audit";
import { loadPolicy } from "@vetoos/risk";
import { RiskBroker } from "@vetoos/demo-cli/broker";
import { assertPolicyExists, loadConfig } from "@vetoos/demo-cli/config";
import { createContext, handler, reconcileTick, RECONCILE_LOOP_MS } from "./app.js";

/** Short git hash injected into the console so we can tell versions apart at a glance. */
const BUILD = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
})();

/**
 * Single-writer lock for the state directory (P1-12). The CLI reads this to
 * route mutating commands through HTTP instead of rewriting state files
 * underneath a running daemon.
 */
function writeLock(stateDir: string, url: string): () => void {
  const lockPath = join(stateDir, "brokerd.lock");
  if (existsSync(lockPath)) {
    try {
      const prev = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      process.kill(prev.pid, 0); // throws if the pid is gone
      throw new Error(`another brokerd (pid ${prev.pid}) owns ${stateDir} — stop it first`);
    } catch (err) {
      if (err instanceof Error && /another brokerd/.test(err.message)) throw err;
      // stale lock from a crashed process — take over
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }), "utf8");
  const release = (): void => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
  process.on("exit", release);
  return release;
}

async function main(): Promise<void> {
  // VETOOS_OFFLINE=1 → canned venue (judges' mode): no keys, no network, own state dir.
  const offline = process.env.VETOOS_OFFLINE === "1";
  const loaded = loadConfig();
  const config = offline ? { ...loaded, stateDir: mkdtempSync(join(tmpdir(), "vetoos-offline-")) } : loaded;
  if (offline) console.log(`[offline] FIXTURE VENUE — no keys, no network; ephemeral state in ${config.stateDir}`);
  assertPolicyExists(config.policyPath);
  const policy = loadPolicy(config.policyPath);
  if (!offline && (!config.privateKey || !config.accountAddress)) {
    throw new Error("HL_PRIVATE_KEY and HL_ACCOUNT_ADDRESS required — docs/TESTNET_SETUP.md (or VETOOS_OFFLINE=1)");
  }
  const adapter = offline ? new FixtureAdapter() : new HlAdapter(config);
  const audit = new AuditLog(config.stateDir, policy.contentHash);
  const broker = new RiskBroker(policy, adapter, audit, config.stateDir);

  // Fail closed on missing real market data — but give transient venue
  // rate limits a chance to pass first (startup is the critical path).
  for (let attempt = 1; ; attempt++) {
    try {
      await broker.init();
      break;
    } catch (err) {
      if (attempt >= 6) throw err;
      const waitMs = Math.min(2000 * Math.pow(2, attempt - 1), 20_000);
      console.log(
        `[startup] init failed (${err instanceof Error ? err.message : String(err)}), retry ${attempt}/5 in ${waitMs / 1000}s…`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  // Same trade-market resolution as the demo: env pin → policy default → BTC.
  const tradeMarket = offline
    ? policy.policy.default_market
    : (config.tradeMarket ??
      (await adapter
        .getMarketContext(policy.policy.default_market, "testnet")
        .then(() => policy.policy.default_market)
        .catch(() => "BTC")));

  const port = Number(process.env.VETOOS_PORT ?? 4399); // 4310 collides with common apps
  const host = process.env.VETOOS_HOST ?? "127.0.0.1";
  const publicToken = process.env.VETOOS_PUBLIC_TOKEN || undefined;
  if (host !== "127.0.0.1" && host !== "localhost" && !publicToken) {
    throw new Error(`refusing to bind ${host} without VETOOS_PUBLIC_TOKEN — the write path would be open`);
  }

  const ctx = createContext({
    config,
    policy,
    adapter,
    broker,
    audit,
    tradeMarket,
    options: {
      build: offline ? `${BUILD}-offline` : BUILD,
      offline,
      ...(publicToken ? { publicToken } : {}),
      protectReads: process.env.VETOOS_PROTECT_READS === "1",
    },
  });

  writeLock(config.stateDir, `http://${host}:${port}`);

  // Session baseline + background truth loop.
  await reconcileTick(ctx).catch((err: unknown) =>
    console.log(`[truth] initial baseline failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  setInterval(() => {
    reconcileTick(ctx).catch(() => undefined);
  }, RECONCILE_LOOP_MS).unref();

  const server = createServer(handler(ctx));
  server.listen(port, host, () => {
    console.log(`[brokerd] VetoOS broker listening on http://${host}:${port}  (build ${BUILD})`);
    console.log(`[brokerd] dashboard → http://${host}:${port}/  ·  API → /v1/*  ·  OpenAPI → /openapi.json`);
    console.log(
      `[brokerd] policy ${policy.contentHash.slice(0, 12)}… · trade market ${tradeMarket} · frozen=${broker.frozen}` +
        (publicToken ? ` · write-guard ON${ctx.options.protectReads ? " (+reads)" : ""}` : ""),
    );
  });
}

main().catch((err: unknown) => {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
