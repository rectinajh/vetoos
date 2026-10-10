import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, RULESET_HASH, RULESET_FILES, computeRulesetHashFromDisk } from "./ruleset.js";
import { join } from "node:path";

/** Repo root, resolved from this file (packages/risk/src -> ../../..). */
const REPO_ROOT = join(import.meta.dirname, "../../..");

describe("ruleset content addressing", () => {
  it("RULESET_HASH matches the decision-relevant sources on disk", () => {
    const actual = computeRulesetHashFromDisk(REPO_ROOT);
    // If this fails after an intentional rule change: pnpm ruleset:stamp.
    // If it fails and you did NOT change a rule, something edited the engine.
    expect(actual).toBe(RULESET_HASH);
  });

  it("declares a semantic engine version", () => {
    expect(ENGINE_VERSION).toMatch(/^risk\/\d+\.\d+\.\d+$/);
  });

  it("covers the engine and the policy schema", () => {
    expect([...RULESET_FILES]).toEqual([
      "packages/risk/src/engine.ts",
      "packages/risk/src/policy.ts",
    ]);
  });
});
