import { describe, expect, it } from "vitest";
import { canonicalize, commitmentHash, decimal, hashOf, verifyCommitment } from "./canonical.js";

describe("canonicalize", () => {
  it("is invariant to object key order (the property the old hash lacked)", () => {
    const a = { market: "xyz:XYZ100", size: "0.001", verdict: "ALLOW" };
    const b = { verdict: "ALLOW", size: "0.001", market: "xyz:XYZ100" };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it("sorts keys at every depth", () => {
    expect(canonicalize({ b: { d: 1, c: 2 }, a: 1 })).toBe('{"a":1,"b":{"c":2,"d":1}}');
  });

  it("preserves array order (order is data, not noise)", () => {
    expect(hashOf([1, 2, 3])).not.toBe(hashOf([3, 2, 1]));
    expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
  });

  it("matches JSON.stringify semantics for undefined and null", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalize([1, undefined, 3])).toBe("[1,null,3]");
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it("normalises negative zero like ECMAScript does", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(hashOf(-0)).toBe(hashOf(0));
  });

  it("rejects non-finite numbers instead of silently collapsing them to null", () => {
    // Two distinct payloads must never share a digest in a risk system.
    expect(() => canonicalize({ markPx: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalize({ markPx: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it("rejects BigInt and cyclic structures loudly", () => {
    expect(() => canonicalize({ n: 1n })).toThrow(/BigInt/);
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => canonicalize(cycle)).toThrow(/cyclic/);
  });

  it("escapes strings exactly once (no double encoding)", () => {
    expect(canonicalize({ s: 'a"b\\nc' })).toBe('{"s":"a\\"b\\\\nc"}');
  });
});

describe("decimal", () => {
  it("keeps money as a decimal string so floats never enter a digest", () => {
    expect(decimal(82504.5)).toBe("82504.5");
    expect(decimal("0.001000")).toBe("0.001");
    expect(decimal(0)).toBe("0");
  });
});

describe("commitment scheme (AI advice)", () => {
  const advice = { score: 0.82, rationale: "momentum, adding to a winner" };
  const nonce = "9f2c1d7a4b6e8f01";

  it("opens only with the right nonce and value", () => {
    const c = commitmentHash(nonce, advice);
    expect(verifyCommitment(nonce, advice, c)).toBe(true);
    expect(verifyCommitment("wrong-nonce", advice, c)).toBe(false);
    expect(verifyCommitment(nonce, { ...advice, score: 0.1 }, c)).toBe(false);
  });

  it("hides the advice (the digest is not the advice)", () => {
    const c = commitmentHash(nonce, advice);
    expect(c).not.toContain("momentum");
    expect(c).toMatch(/^[0-9a-f]{64}$/);
  });
});
