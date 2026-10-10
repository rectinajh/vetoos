import { describe, expect, it } from "vitest";
import { findForbiddenFields, makeIntent, validateIntent } from "./index.js";

const validRaw = makeIntent({
  source: "strategy-a",
  market: "xyz:XYZ100",
  side: "buy",
  size: "1.5",
  order_type: "market",
});

describe("validateIntent", () => {
  it("accepts a well-formed intent", () => {
    const result = validateIntent(validRaw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.market).toBe("xyz:XYZ100");
      expect(result.intent.reduce_only).toBe(false);
    }
  });

  it("accepts main-perp market names without a dex prefix", () => {
    const result = validateIntent({ ...validRaw, market: "BTC" });
    expect(result.ok).toBe(true);
  });

  it("rejects a top-level policy override (AI smuggling max_leverage)", () => {
    const result = validateIntent({ ...validRaw, max_leverage: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("max_leverage");
  });

  it("rejects overrides nested inside meta", () => {
    const result = validateIntent({
      ...validRaw,
      meta: { rationale: "trust me", policy_override: { cooldown_seconds_after_deny: 0 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("policy_override");
  });

  it("rejects bypass-style fields anywhere in the tree", () => {
    const result = validateIntent({ ...validRaw, meta: { nested: { skip_checks: true } } });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown top-level field", () => {
    const result = validateIntent({ ...validRaw, surprise: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a bad side", () => {
    const result = validateIntent({ ...validRaw, side: "long" });
    expect(result.ok).toBe(false);
  });

  it("requires limit_px for limit orders", () => {
    const result = validateIntent({ ...validRaw, order_type: "limit" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("limit_px");
  });

  it("accepts a limit order with limit_px", () => {
    const result = validateIntent({ ...validRaw, order_type: "limit", limit_px: "100.5" });
    expect(result.ok).toBe(true);
  });

  it("rejects zero size", () => {
    const result = validateIntent({ ...validRaw, size: "0" });
    expect(result.ok).toBe(false);
  });

  it("rejects negative size format", () => {
    const result = validateIntent({ ...validRaw, size: "-3" });
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong IR version", () => {
    const result = validateIntent({ ...validRaw, version: "9.9" });
    expect(result.ok).toBe(false);
  });
});

describe("findForbiddenFields", () => {
  it("reports dotted paths", () => {
    const hits = findForbiddenFields({ meta: { deep: { force: true } } });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("meta.deep.force");
  });

  it("ignores benign fields", () => {
    expect(findForbiddenFields({ meta: { rationale: "ok" } })).toHaveLength(0);
  });
});
