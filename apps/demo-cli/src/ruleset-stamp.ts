#!/usr/bin/env tsx
/**
 * `pnpm ruleset:stamp` — recompute RULESET_HASH from the sources on disk and
 * write it into packages/risk/src/ruleset.ts.
 *
 * Run this ONLY after an intentional, reviewed rule change. If you run it to
 * silence a failing test without reading the diff, you have defeated the gate.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeRulesetHashFromDisk } from "@vetoos/risk";

const repoRoot = join(import.meta.dirname, "../../..");
const target = join(repoRoot, "packages/risk/src/ruleset.ts");
const hash = computeRulesetHashFromDisk(repoRoot);
const before = readFileSync(target, "utf8");
const after = before.replace(
  /export const RULESET_HASH = "[0-9a-f]{64}";/,
  `export const RULESET_HASH = "${hash}";`,
);
if (before === after) {
  console.log(`[ruleset] unchanged: ${hash}`);
} else {
  writeFileSync(target, after, "utf8");
  console.log(`[ruleset] stamped: ${hash}`);
}
