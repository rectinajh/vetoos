/**
 * Environment & file configuration. Secrets come from .env (never committed);
 * everything the broker needs to fail closed is validated here first.
 */

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv({ quiet: true });

export interface CliConfig {
  policyPath: string;
  stateDir: string;
  privateKey?: string;
  accountAddress?: string;
  builderAddress?: string;
  builderFeeTenthsBps?: number;
}

export function repoRoot(): string {
  // apps/demo-cli/src/config.ts → up 3 dirs → repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function loadConfig(flags: Record<string, string | boolean> = {}): CliConfig {
  const root = repoRoot();
  const policyFlag = typeof flags["policy"] === "string" ? (flags["policy"] as string) : undefined;
  const policyPath = resolve(
    root,
    process.env.VETOOS_POLICY ?? policyFlag ?? "configs/policy.demo.json",
  );
  const stateDir = resolve(root, process.env.VETOOS_STATE_DIR ?? "logs");

  return {
    policyPath,
    stateDir,
    privateKey: process.env.HL_PRIVATE_KEY || undefined,
    accountAddress: process.env.HL_ACCOUNT_ADDRESS || undefined,
    builderAddress: process.env.HL_BUILDER_ADDRESS || undefined,
    builderFeeTenthsBps: process.env.HL_BUILDER_FEE_TENTHS_BPS
      ? Number(process.env.HL_BUILDER_FEE_TENTHS_BPS)
      : undefined,
  };
}

export function assertPolicyExists(path: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `policy file not found: ${path}\n` +
        `  copy configs/policy.demo.json to configs/policy.json or set VETOOS_POLICY`,
    );
  }
}
