import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashOf } from "@vetoos/audit";
import { evaluateIntent } from "./engine.js";
import { contextFromDecisionInput, verdictHashOf, type DecisionInput } from "./verdict.js";

/**
 * Golden conformance suite (docs/VERIFIABLE_RISK_ENGINE.md §10).
 *
 * Two jobs:
 *  1. Internal gate — any refactor that silently moves a verdict fails here.
 *  2. External contract — a third party can implement the gate in any language
 *     and check itself against these (input, verdictHash) pairs.
 *
 * Regenerate with \`pnpm vectors:gen\` ONLY after an intentional rule change.
 */

const REPO_ROOT = join(import.meta.dirname, "../../..");
const FILE = join(REPO_ROOT, "packages/risk/vectors/decisions.json");

interface Vector {
  name: string;
  expected: { decision: string; code: string };
  verdictHash: string;
  input: DecisionInput;
}
interface VectorFile {
  schema: string;
  policyBytesHash: string;
  vectors: Vector[];
}

const file = JSON.parse(readFileSync(FILE, "utf8")) as VectorFile;

/** Reverse every object's key order — the digest must not care. */
function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v)]));
}

describe("golden conformance vectors", () => {
  it("has a usable corpus", () => {
    expect(file.schema).toBe("vetoos.vectors/1");
    expect(file.vectors.length).toBeGreaterThanOrEqual(10);
    // Every deny path the engine can produce should be represented.
    const codes = new Set(file.vectors.map((v) => v.expected.code));
    for (const code of [
      "ALLOW",
      "FROZEN",
      "NO_MARKET_DATA",
      "MARKET_NOT_ALLOWED",
      "NOTIONAL_EXCEEDED",
      "LEVERAGE_EXCEEDED",
      "DAILY_LOSS_CIRCUIT_BREAKER",
      "FOMO_COOLDOWN",
      "FOMO_SAME_SIDE_ADDS",
      "BOOK_DEPTH",
      "ORACLE_DEVIATION",
    ]) {
      expect(codes, "missing a vector for " + code).toContain(code);
    }
  });

  for (const vector of file.vectors) {
    it(vector.name, () => {
      const decision = evaluateIntent(
        vector.input.intent,
        vector.input.policy,
        contextFromDecisionInput(vector.input),
      );
      expect({ decision: decision.decision, code: decision.code }).toEqual(vector.expected);
      expect(verdictHashOf(decision)).toBe(vector.verdictHash);
    });
  }

  it("is deterministic: same input, same verdict, twice in a row", () => {
    for (const vector of file.vectors) {
      const ctx = contextFromDecisionInput(vector.input);
      const a = verdictHashOf(evaluateIntent(vector.input.intent, vector.input.policy, ctx));
      const b = verdictHashOf(evaluateIntent(vector.input.intent, vector.input.policy, ctx));
      expect(b).toBe(a);
    }
  });

  it("hashes inputs independently of key order (the v1 digest did not)", () => {
    for (const vector of file.vectors) {
      const shuffled = shuffleKeys(vector.input) as DecisionInput;
      expect(hashOf(shuffled)).toBe(hashOf(vector.input));
    }
  });

  it("records the engine version and ruleset on every archived input", () => {
    for (const vector of file.vectors) {
      expect(vector.input.engineVersion).toMatch(/^risk\//);
      expect(vector.input.rulesetHash).toMatch(/^[0-9a-f]{64}$/);
      expect(vector.input.schema).toBe("vetoos.decision/1");
    }
  });
});
