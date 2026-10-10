import { describe, expect, it } from "vitest";
import { generateReceiptKey, receiptSignerFromSeed, verifyReceiptSignature } from "./receiptkey.js";

describe("receipt key (ed25519)", () => {
  it("round-trips a signature over a domain-separated payload", () => {
    const { seed, signer } = generateReceiptKey();
    const s = receiptSignerFromSeed(seed);
    expect(s.signer).toBe(signer);
    const { sig, signer: who } = s.sign("VetoOS receipt\nabc123");
    expect(who).toBe(signer);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyReceiptSignature("VetoOS receipt\nabc123", sig, signer)).toBe(true);
  });

  it("rejects a payload that was not signed", () => {
    const { seed, signer } = generateReceiptKey();
    const { sig } = receiptSignerFromSeed(seed).sign("VetoOS receipt\nabc123");
    expect(verifyReceiptSignature("VetoOS receipt\nabc124", sig, signer)).toBe(false);
  });

  it("rejects a signature attributed to a different signer", () => {
    const a = generateReceiptKey();
    const b = generateReceiptKey();
    const { sig } = receiptSignerFromSeed(a.seed).sign("payload");
    expect(verifyReceiptSignature("payload", sig, b.signer)).toBe(false);
  });

  it("fails closed on malformed key material and junk signatures", () => {
    expect(() => receiptSignerFromSeed("not-a-key")).toThrow(/32-byte/);
    expect(verifyReceiptSignature("p", "zz", "not-a-public-key")).toBe(false);
  });

  it("accepts a base64 seed as well as hex", () => {
    const { seed } = generateReceiptKey();
    const asBase64 = Buffer.from(seed, "hex").toString("base64");
    expect(receiptSignerFromSeed(asBase64).signer).toBe(receiptSignerFromSeed(seed).signer);
  });
});
