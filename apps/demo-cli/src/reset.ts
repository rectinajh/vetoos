#!/usr/bin/env tsx
/**
 * `pnpm demo:reset` — archive broker state so the NEXT recording take starts
 * pristine (unfrozen, empty history/ledger). Refuses while a position is
 * still open: unwinding is a human decision (`pnpm broker close`).
 */

import { existsSync, mkdirSync, renameSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HlAdapter } from "@vetoos/adapter-hl";
import { loadPolicy } from "@vetoos/risk";
import { loadConfig } from "./config.js";
import { resolveTradeMarket } from "./demo.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // Never pull state files out from under a running brokerd.
  const lockPath = join(config.stateDir, "brokerd.lock");
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; url: string };
      process.kill(lock.pid, 0);
      console.error(`[reset] brokerd (pid ${lock.pid}, ${lock.url}) is running — stop it before resetting state.`);
      process.exit(1);
    } catch {
      /* stale lock — proceed */
    }
  }
  const adapter = new HlAdapter(config);
  const policy = loadPolicy(config.policyPath);

  const market = await resolveTradeMarket(adapter, policy, config.tradeMarket);
  const position = await adapter.getPositionSize(market, "testnet");
  if (position !== 0) {
    console.error(
      `[reset] position on ${market} is ${position} — not flat.\n` +
        `        Unwind first: pnpm broker close --confirm I_AM_HUMAN`,
    );
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archiveDir = join(config.stateDir, `archive-${stamp}`);
  let moved = 0;
  const candidates = readdirSync(config.stateDir)
    .filter((f) => f === "broker-state.json" || f === "ledger.jsonl" || /^audit-.*\.jsonl$/.test(f));
  if (candidates.length > 0) {
    mkdirSync(archiveDir, { recursive: true });
    for (const f of candidates) {
      const src = join(config.stateDir, f);
      if (existsSync(src)) {
        renameSync(src, join(archiveDir, f));
        moved++;
      }
    }
  }
  console.log(
    moved > 0
      ? `[reset] archived ${moved} state file(s) → ${archiveDir}\n[reset] clean slate — record away.`
      : `[reset] nothing to archive — already clean.`,
  );
}

main().catch((err: unknown) => {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
