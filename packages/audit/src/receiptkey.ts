/**
 * The receipt key: authenticity for Veto Receipts (docs/VERIFIABLE_RISK_ENGINE.md §5.3).
 *
 * Three keys, three powers — deliberately different algorithms so no single
 * compromise grants two powers:
 *
 *   HL_PRIVATE_KEY       secp256k1  (Hyperliquid agent wallet)  can TRADE, cannot withdraw
 *   operator wallet      secp256k1  (EIP-191 signMessage)       can UNFREEZE / change rules
 *   VETOOS_RECEIPT_KEY   ed25519    (this file)                 can ATTEST, nothing else
 *
 * Why ed25519 and not EIP-191 for receipts: receipt signing happens on the
 * decision path, including inside synchronous code (a freeze). Node signs
 * ed25519 synchronously with no dependency, and the signature covers the
 * domain-separated payload produced by receiptSigningPayload().
 *
 * The key is a 32-byte seed in hex or base64. Generate one with:
 *     pnpm keygen --receipt
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

/** Fixed DER prefix of an Ed25519 SPKI public key; keeps the public id compact. */
const SPKI_PREFIX = "302a300506032b6570032100";
/** Fixed DER prefix of an Ed25519 PKCS#8 private key. */
const PKCS8_PREFIX = "302e020100300506032b657004220420";

export interface ReceiptSigner {
  /** Public identifier recorded on every signed receipt (64 hex chars). */
  signer: string;
  /** Synchronous: safe to call from the decision path. */
  sign: (payload: string) => { sig: string; signer: string };
}

function privateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) {
    throw new Error("receipt key must be a 32-byte ed25519 seed (64 hex or 44-char base64)");
  }
  return createPrivateKey({
    key: Buffer.concat([Buffer.from(PKCS8_PREFIX, "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromId(id: string): KeyObject {
  const raw = id.replace(/^ed25519:/, "").trim();
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error("receipt signer id must be 64 hex chars (an ed25519 public key)");
  }
  return createPublicKey({
    key: Buffer.concat([Buffer.from(SPKI_PREFIX, "hex"), Buffer.from(raw, "hex")]),
    format: "der",
    type: "spki",
  });
}

export function publicIdOf(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(der.length - 32).toString("hex");
}

/** Parse a configured seed (hex or base64) into a signer. */
export function receiptSignerFromSeed(seedRaw: string): ReceiptSigner {
  const trimmed = seedRaw.trim();
  const seed = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  const privateKey = privateKeyFromSeed(seed);
  const signer = publicIdOf(privateKey);
  return {
    signer,
    sign: (payload: string) => ({
      sig: cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("hex"),
      signer,
    }),
  };
}

/** Verify a receipt signature. Pure, synchronous, no key material beyond the public id. */
export function verifyReceiptSignature(payload: string, sigHex: string, signerId: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(payload, "utf8"),
      publicKeyFromId(signerId),
      Buffer.from(sigHex.replace(/^0x/, ""), "hex"),
    );
  } catch {
    return false;
  }
}

/** Generate a fresh receipt key pair (used by \`pnpm keygen --receipt\`). */
export function generateReceiptKey(): { seed: string; signer: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return { seed: der.subarray(der.length - 32).toString("hex"), signer: publicIdOf(privateKey) };
}
