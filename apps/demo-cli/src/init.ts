/**
 * `pnpm broker init --template conservative` — one-command onboarding:
 * pick a policy template, land it at configs/policy.json, print next steps.
 */

import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy } from "@vetoos/risk";
import { repoRoot } from "./config.js";

export function runInit(flags: Record<string, string | boolean>): number {
  const root = repoRoot();
  const templatesDir = join(root, "configs", "templates");
  const available = readdirSync(templatesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  const template = typeof flags["template"] === "string" ? flags["template"] : "conservative";
  if (!available.includes(template)) {
    console.error(`unknown template "${template}" — available: ${available.join(", ")}`);
    return 1;
  }

  const dest = join(root, "configs", "policy.json");
  if (existsSync(dest) && flags["force"] !== true) {
    console.error(`configs/policy.json already exists — use --force to overwrite`);
    return 1;
  }
  copyFileSync(join(templatesDir, `${template}.json`), dest);
  const { contentHash } = loadPolicy(dest);
  console.log(`[init] policy "${template}" → configs/policy.json (sha256 ${contentHash.slice(0, 12)}…)`);
  console.log(`[init] next steps:
  1. cp .env.example .env  and fill in HL_PRIVATE_KEY / HL_ACCOUNT_ADDRESS
     (docs/TESTNET_SETUP.md — faucet needs a mainnet-depositing address)
  2. pnpm preflight       → all green
  3. pnpm brokerd         → console at http://127.0.0.1:4399/
  4. point your strategy at POST /v1/intents (examples/proposer.ts, proposer.py)`);
  return 0;
}
