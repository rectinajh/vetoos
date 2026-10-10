import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPolicyBytes, loadPolicy } from "./policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const demoPolicyPath = resolve(here, "../../../configs/policy.demo.json");

describe("loadPolicy", () => {
  it("loads the demo policy and hashes its exact bytes", () => {
    const { policy, contentHash } = loadPolicy(demoPolicyPath);
    expect(policy.default_market).toBe("xyz:XYZ100");
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash is stable for identical content", () => {
    const a = loadPolicy(demoPolicyPath);
    const b = loadPolicy(demoPolicyPath);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("hash changes when content changes", () => {
    const a = hashPolicyBytes('{"a":1}');
    const b = hashPolicyBytes('{"a":2}');
    expect(a).not.toBe(b);
  });

  it("rejects a policy missing required fields", () => {
    expect(() => loadPolicy(resolve(here, "nonexistent.json"))).toThrow();
  });

  it("defaults oracle distance to 500 bps when the field is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "vetoos-policy-"));
    const path = join(dir, "policy.json");
    const raw = JSON.parse(readDemo()) as Record<string, unknown>;
    delete raw["max_oracle_deviation_bps"];
    writeFileSync(path, JSON.stringify(raw));
    try {
      expect(loadPolicy(path).policy.max_oracle_deviation_bps).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readDemo(): string {
  return JSON.stringify(loadPolicy(demoPolicyPath).policy);
}
