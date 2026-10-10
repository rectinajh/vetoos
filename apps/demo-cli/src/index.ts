#!/usr/bin/env tsx
/**
 * vetoos CLI — the Risk Broker process. The only process that holds keys.
 *
 *   pnpm preflight                  pre-flight checks (real data paths)
 *   pnpm demo [--auto] [--step N]   the four-act hackathon demo
 *   pnpm broker status              broker state snapshot
 *   pnpm broker submit --file X     submit an Intent IR JSON file
 *   pnpm broker unfreeze --confirm I_AM_HUMAN
 *   pnpm broker close --confirm I_AM_HUMAN   reduce-only close of the demo position
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HlAdapter } from "@vetoos/adapter-hl";
import { AuditLog } from "@vetoos/audit";
import { loadPolicy } from "@vetoos/risk";
import { RiskBroker } from "./broker.js";
import { assertPolicyExists, loadConfig, type CliConfig } from "./config.js";
import { runDemo, resolveTradeMarket } from "./demo.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";

export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

async function buildBroker(config: CliConfig, initNetwork: boolean): Promise<RiskBroker> {
  assertPolicyExists(config.policyPath);
  const policy = loadPolicy(config.policyPath);
  const adapter = new HlAdapter(config);
  const audit = new AuditLog(config.stateDir, policy.contentHash);
  const broker = new RiskBroker(policy, adapter, audit, config.stateDir);
  if (initNetwork) await broker.init(); // fail closed on missing real data
  return broker;
}

/**
 * Single-writer rule for the state directory. When brokerd is running it owns
 * broker-state.json; the CLI must talk to it over HTTP instead of rewriting
 * the file underneath it (otherwise an `unfreeze` here is silently undone by
 * the daemon's next save).
 */
function runningDaemon(stateDir: string): { pid: number; url: string } | null {
  const lockPath = join(stateDir, "brokerd.lock");
  if (!existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; url: string };
    process.kill(lock.pid, 0); // throws when the process is gone (stale lock)
    return lock;
  } catch {
    return null;
  }
}

async function daemonCall(
  daemon: { url: string },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (process.env.VETOOS_PUBLIC_TOKEN) headers["x-vetoos-token"] = process.env.VETOOS_PUBLIC_TOKEN;
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

function refuseWhileDaemon(daemon: { pid: number; url: string } | null, command: string): void {
  if (daemon) {
    throw new Error(
      `brokerd (pid ${daemon.pid}, ${daemon.url}) owns this state dir — ` +
        `'${command}' would corrupt its state. Stop it first, or point VETOOS_STATE_DIR elsewhere.`,
    );
  }
}

/** Commands that place orders must have the keys up front — fail closed early. */
function assertWriteConfig(config: CliConfig): void {
  if (!config.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
    throw new Error("HL_PRIVATE_KEY missing or malformed — see docs/TESTNET_SETUP.md");
  }
  if (!config.accountAddress) {
    throw new Error("HL_ACCOUNT_ADDRESS missing — see docs/TESTNET_SETUP.md");
  }
}

async function main(): Promise<number> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const config = loadConfig(flags);

  switch (command) {
    case "doctor":
      return await runDoctor(flags);

    case "init":
      return runInit(flags);

    case "demo": {
      refuseWhileDaemon(runningDaemon(config.stateDir), "demo");
      assertWriteConfig(config);
      const broker = await buildBroker(config, true);
      const policy = loadPolicy(config.policyPath);
      const adapter = new HlAdapter(config);
      await runDemo(broker, adapter, policy, {
        auto: flags["auto"] === true,
        ...(typeof flags["step"] === "string" ? { step: Number(flags["step"]) } : {}),
        ...(config.tradeMarket ? { tradeMarket: config.tradeMarket } : {}),
      });
      return 0;
    }

    case "status": {
      const daemon = runningDaemon(config.stateDir);
      if (daemon) {
        const r = await daemonCall(daemon, "GET", "/v1/status");
        console.log(JSON.stringify({ via: daemon.url, ...(r.body as object) }, null, 2));
        return 0;
      }
      const broker = await buildBroker(config, false);
      console.log(JSON.stringify(broker.status(), null, 2));
      return 0;
    }

    case "submit": {
      const file = flags["file"];
      if (typeof file !== "string") throw new Error("submit requires --file <intent.json>");
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const daemon = runningDaemon(config.stateDir);
      if (daemon) {
        const r = await daemonCall(daemon, "POST", "/v1/intents", raw);
        console.log(JSON.stringify({ via: daemon.url, http: r.status, ...(r.body as object) }, null, 2));
        return r.status === 200 ? 0 : r.status === 400 ? 1 : 2;
      }
      assertWriteConfig(config);
      const broker = await buildBroker(config, true);
      const result = await broker.submitIntent(raw);
      if (result.validationError) {
        console.error(`invalid intent: ${result.validationError}`);
        return 1;
      }
      return result.decision?.decision === "allow" ? 0 : 2;
    }

    case "unfreeze": {
      const confirm = typeof flags["confirm"] === "string" ? flags["confirm"] : "";
      const daemon = runningDaemon(config.stateDir);
      if (daemon) {
        if (confirm !== "I_AM_HUMAN") {
          throw new Error("unfreeze requires explicit human confirmation: --confirm I_AM_HUMAN");
        }
        const r = await daemonCall(daemon, "POST", "/v1/unfreeze", undefined, { "x-vetoos-human": confirm });
        console.log(JSON.stringify({ via: daemon.url, http: r.status, ...(r.body as object) }, null, 2));
        return r.status === 200 ? 0 : 1;
      }
      const broker = await buildBroker(config, false);
      broker.unfreeze(confirm);
      return 0;
    }

    case "close": {
      const confirm = typeof flags["confirm"] === "string" ? flags["confirm"] : "";
      if (confirm !== "I_AM_HUMAN") {
        throw new Error('close requires --confirm I_AM_HUMAN (a human decides to unwind)');
      }
      assertWriteConfig(config);
      const daemon = runningDaemon(config.stateDir);
      const policy = loadPolicy(config.policyPath);
      const adapter = new HlAdapter(config);
      const market = await resolveTradeMarket(adapter, policy, config.tradeMarket);
      const position = await adapter.getPositionSize(market, "testnet");
      if (position === 0) {
        console.log("[close] already flat — nothing to do.");
        return 0;
      }
      const closeIntent = {
        version: "0.1",
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        source: "human-operator",
        market,
        side: position > 0 ? "sell" : "buy",
        size: Math.abs(position).toString(),
        order_type: "market",
        reduce_only: true,
        meta: { rationale: "human unwind of the demo position" },
      };
      if (daemon) {
        // The daemon owns the keys and the state: unfreeze (human) then submit through it.
        await daemonCall(daemon, "POST", "/v1/unfreeze", undefined, { "x-vetoos-human": confirm });
        const r = await daemonCall(daemon, "POST", "/v1/intents", closeIntent);
        console.log(JSON.stringify({ via: daemon.url, http: r.status, ...(r.body as object) }, null, 2));
        return r.status === 200 ? 0 : 2;
      }
      const broker = await buildBroker(config, true);
      if (broker.frozen) broker.unfreeze(confirm);
      const result = await broker.submitIntent(closeIntent);
      return result.decision?.decision === "allow" ? 0 : 2;
    }

    default:
      console.log(`vetoos — Risk Broker CLI

  pnpm broker init --template NAME           conservative | degen | fund → configs/policy.json
  pnpm preflight                             pre-flight checks (real data paths)
  pnpm demo --auto                           run all four demo acts
  pnpm demo --step N                         run only act N (1-4, for recording)
  pnpm broker status                         broker state snapshot
  pnpm broker submit --file intent.json      submit an Intent IR payload
  pnpm broker unfreeze --confirm I_AM_HUMAN  human-only reset after a freeze
  pnpm broker close --confirm I_AM_HUMAN     reduce-only close of demo position
`);
      return command === "help" ? 0 : 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
