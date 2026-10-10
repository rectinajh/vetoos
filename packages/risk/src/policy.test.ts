import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
});
