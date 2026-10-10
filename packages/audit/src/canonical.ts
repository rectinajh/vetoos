/**
 * Canonical JSON + the single hashing entry point for VetoOS.
 *
 * Why this file exists (docs/VERIFIABLE_RISK_ENGINE.md §4.4):
 * a verdict is only "reproducible" if the same logical value always hashes to
 * the same bytes. Raw JSON.stringify does NOT give that guarantee — object key
 * insertion order leaks into the digest, so two implementations of the same
 * record can hash differently. Measured on the pre-canonical code:
 *
 *     {market, size, verdict} -> b098f6dd…
 *     {verdict, size, market} -> bea2065a…      (same content, different digest)
 *
 * Rule: every hash in this repo goes through hashOf(). Never hash a bare
 * JSON.stringify() again.
 *
 * Number handling mirrors ECMAScript (RFC 8785 §3.2.2.3) and is STRICT:
 * NaN / Infinity / BigInt are rejected rather than silently coerced to null,
 * because two distinct payloads collapsing onto the same digest would be a
 * verifiability hole in a risk system. Sanitize at the boundary instead
 * (see finiteOrNull in the broker).
 */

import { createHash } from "node:crypto";

export const HASH_ALG_V1 = "sha256/v1";
export const HASH_ALG_V2 = "sha256/v2";
export type HashAlg = typeof HASH_ALG_V1 | typeof HASH_ALG_V2;

/** Deterministic JSON: object keys sorted by code point, no insignificant whitespace. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, out, new Set<object>());
  return out.join("");
}

function write(value: unknown, out: string[], seen: Set<object>): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `canonicalize: non-finite number (${String(value)}) — replace it with null or omit the field before hashing`,
        );
      }
      // JSON.stringify gives ECMAScript Number::toString semantics (-0 -> 0).
      out.push(JSON.stringify(value));
      return;
    case "bigint":
      throw new Error("canonicalize: BigInt is not portable JSON — use a decimal string");
    case "undefined":
    case "function":
    case "symbol":
      // Dropped in objects; array slots are handled by the caller (-> null).
      throw new Error("canonicalize: unsupported value at a hashed position");
    case "object": {
      const obj = value as object;
      if (seen.has(obj)) throw new Error("canonicalize: cyclic value");
      seen.add(obj);
      try {
        if (Array.isArray(obj)) {
          out.push("[");
          for (let i = 0; i < obj.length; i++) {
            if (i > 0) out.push(",");
            const item: unknown = obj[i];
            if (item === undefined || typeof item === "function" || typeof item === "symbol") {
              out.push("null"); // JSON.stringify parity for holes/undefined in arrays
            } else {
              write(item, out, seen);
            }
          }
          out.push("]");
          return;
        }
        // toJSON parity with JSON.stringify (Date, and anything else that opts in).
        const withToJson = obj as { toJSON?: () => unknown };
        if (typeof withToJson.toJSON === "function") {
          write(withToJson.toJSON(), out, seen);
          return;
        }
        out.push("{");
        const keys = Object.keys(obj).sort();
        let first = true;
        for (const key of keys) {
          const item: unknown = (obj as Record<string, unknown>)[key];
          if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
          if (!first) out.push(",");
          first = false;
          out.push(JSON.stringify(key), ":");
          write(item, out, seen);
        }
        out.push("}");
        return;
      } finally {
        seen.delete(obj);
      }
    }
    /* c8 ignore next 2 */
    default:
      throw new Error(`canonicalize: unsupported type ${typeof value}`);
  }
}

/** The one and only hashing entry point. */
export function hashOf(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/** Decimal string for money/price fields that must never enter a hash as a float. */
export function decimal(value: number | string, maxDecimals = 8): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`decimal: not finite: ${String(value)}`);
  return n.toFixed(maxDecimals).replace(/\.?0+$/, "") || "0";
}

/** Domain-separated hash: prevents a digest from being replayed in another context. */
export function hashOfDomain(domain: string, value: unknown): string {
  return hashOf({ domain, value });
}

/**
 * Commitment scheme used for AI advice (docs/VERIFIABLE_RISK_ENGINE.md §6.2).
 *
 * The advice is hashed BEFORE the decision and the nonce is only revealed
 * afterwards, so nobody can back-date good advice or quietly drop bad advice.
 * A commitment must be hiding enough to not leak the advice: the nonce is
 * high-entropy and generated by the committer.
 */
export function commitmentHash(nonce: string, value: unknown): string {
  return hashOf({ nonce, value });
}

/** True when (nonce, value) opens the commitment. */
export function verifyCommitment(nonce: string, value: unknown, expected: string): boolean {
  return commitmentHash(nonce, value) === expected;
}
