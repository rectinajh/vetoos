import { describe, expect, it } from "vitest";
import {
  aggressiveLimitPx,
  computeHip3AssetId,
  depthWithinBand,
  parseMarket,
  roundSize,
  toSigFigs,
  type BookLevels,
} from "./helpers.js";

describe("computeHip3AssetId", () => {
  it("follows the HIP-3 rule: 100000 + dex_index*10000 + meta_index", () => {
    expect(computeHip3AssetId(1, 0)).toBe(110000);
    expect(computeHip3AssetId(1, 5)).toBe(110005);
    expect(computeHip3AssetId(2, 0)).toBe(120000);
  });

  it("main dex (index 0) uses the plain meta index (BTC = 0)", () => {
    expect(computeHip3AssetId(0, 0)).toBe(0);
    expect(computeHip3AssetId(0, 3)).toBe(3);
  });

  it("rejects negative indexes", () => {
    expect(() => computeHip3AssetId(-1, 0)).toThrow();
    expect(() => computeHip3AssetId(1, -1)).toThrow();
  });
});

describe("parseMarket", () => {
  it("parses builder-dex markets", () => {
    expect(parseMarket("xyz:XYZ100")).toEqual({
      dex: "xyz",
      coin: "XYZ100",
      venueCoin: "xyz:XYZ100",
    });
  });

  it("parses main-perp markets", () => {
    expect(parseMarket("BTC")).toEqual({ dex: null, coin: "BTC", venueCoin: "BTC" });
  });

  it("rejects malformed markets", () => {
    expect(() => parseMarket("xyz:")).toThrow();
    expect(() => parseMarket(":BTC")).toThrow();
  });
});

describe("depthWithinBand", () => {
  const book: BookLevels = {
    levels: [
      [
        { px: "99", sz: "5", n: 1 },
        { px: "98", sz: "5", n: 1 },
      ],
      [
        { px: "101", sz: "3", n: 1 },
        { px: "102", sz: "7", n: 1 },
      ],
    ],
  };

  it("sums asks within the band for a buy", () => {
    // mark 100, 50bps → cap 100.5 → only the 101 ask is outside; hmm: 101 > 100.5
    expect(depthWithinBand(book, "buy", 100, 50)).toBe(0);
    // 200bps → cap 102 → both asks (3 + 7)
    expect(depthWithinBand(book, "buy", 100, 200)).toBe(10);
  });

  it("sums bids within the band for a sell", () => {
    // mark 100, 50bps → floor 99.5 → neither bid qualifies
    expect(depthWithinBand(book, "sell", 100, 50)).toBe(0);
    // 200bps → floor 98 → both bids (5 + 5)
    expect(depthWithinBand(book, "sell", 100, 200)).toBe(10);
  });
});

describe("price & size rounding", () => {
  it("rounds prices to 5 significant figures", () => {
    expect(toSigFigs(123.456789)).toBe("123.46");
    expect(toSigFigs(0.0000123456789)).toBe("0.000012346");
  });

  it("rejects non-positive prices", () => {
    expect(() => toSigFigs(0)).toThrow();
    expect(() => toSigFigs(-5)).toThrow();
  });

  it("rounds size down to the lot", () => {
    expect(roundSize(1.234567, 2)).toBe("1.23");
    expect(roundSize(0.999, 0)).toBe("0");
  });

  it("aggressive limit crosses the spread in the right direction", () => {
    expect(Number(aggressiveLimitPx("buy", 100))).toBeGreaterThan(100);
    expect(Number(aggressiveLimitPx("sell", 100))).toBeLessThan(100);
  });
});
