import { describe, expect, it } from "vitest";
import {
  aggressiveLimitPx,
  computeHip3AssetId,
  depthWithinBand,
  intentIdToCloid,
  isRetryableError,
  parseMarket,
  roundPrice,
  roundSize,
  toSigFigs,
  withBackoff,
  type BookLevels,
} from "./helpers.js";

describe("roundPrice (5 sig figs AND 6 − szDecimals decimals)", () => {
  it("caps decimals by szDecimals for a BTC-like market (szDecimals 5 → 1 decimal)", () => {
    expect(roundPrice(82504.123, 5)).toBe("82504");
    expect(roundPrice(1.23456789, 5)).toBe("1.2");
  });
  it("keeps 5 significant figures on cheap assets with coarse lots (szDecimals 0 → 6 decimals)", () => {
    expect(roundPrice(0.012345678, 0)).toBe("0.012346");
    expect(roundPrice(0.0000012345, 0)).toBe("0.000001");
  });
  it("integers are always valid regardless of significant figures", () => {
    expect(roundPrice(123456.7, 2)).toBe("123460");
  });
  it("a sloppy caller-supplied limit price is normalised, not forwarded raw", () => {
    expect(roundPrice(Number("86456.789123"), 5)).toBe("86457");
  });
  it("aggressive IOC price obeys the same rule when szDecimals is known", () => {
    expect(aggressiveLimitPx("buy", 82504, 500, 5)).toBe("86629");
  });
  it("rejects non-positive prices", () => {
    expect(() => roundPrice(0, 2)).toThrow();
  });
});

describe("intentIdToCloid", () => {
  it("derives a 16-byte hex cloid from a UUID intent id", () => {
    expect(intentIdToCloid("11111111-1111-4111-8111-111111111111")).toBe(
      "0x11111111111141118111111111111111",
    );
  });
  it("is stable: same intent id → same cloid (venue-side duplicate detection)", () => {
    const id = crypto.randomUUID();
    expect(intentIdToCloid(id)).toBe(intentIdToCloid(id));
  });
  it("rejects non-UUID ids", () => {
    expect(() => intentIdToCloid("not-a-uuid")).toThrow();
  });
});

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

describe("withBackoff", () => {
  const noSleep = async () => {};

  it("returns immediately on success", async () => {
    let calls = 0;
    const r = await withBackoff(async () => {
      calls++;
      return 42;
    }, { sleep: noSleep });
    expect(r).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries rate limits then succeeds", async () => {
    let calls = 0;
    const r = await withBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error("429 Too Many Requests");
        return "ok";
      },
      { sleep: noSleep, attempts: 3 },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the attempt budget", async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw new Error("503 Service Unavailable");
        },
        { sleep: noSleep, attempts: 2 },
      ),
    ).rejects.toThrow("503");
    expect(calls).toBe(2);
  });

  it("does NOT retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw new Error("Invalid spot");
        },
        { sleep: noSleep, attempts: 3 },
      ),
    ).rejects.toThrow("Invalid spot");
    expect(calls).toBe(1);
  });

  it("classifies retryable errors", () => {
    expect(isRetryableError(new Error("429 rate limit"))).toBe(true);
    expect(isRetryableError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("Invalid spot"))).toBe(false);
    expect(isRetryableError(new Error("insufficient margin"))).toBe(false);
  });
});
