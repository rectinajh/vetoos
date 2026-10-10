/**
 * @vetoos/audit — every allow/deny/freeze leaves a bilingual, structured
 * trail. JSONL for machines, one-line human summary for judges and demos.
 *
 * Each line is hash-chained: seq increments, prev_hash is the previous line's
 * hash. Deleting, reordering or editing any historical line breaks the chain —
 * verifyChain tells you exactly where, by sequence number.
 *
 * Two hash generations coexist (docs/VERIFIABLE_RISK_ENGINE.md §4.4):
 *   sha256/v1 — the original JSON.stringify([]) preimage (key-order sensitive)
 *   sha256/v2 — canonical JSON over every field except hash/sig (current)
 * Every event declares its own algorithm, so old logs keep verifying exactly
 * as they were written while new logs get the stronger, portable digest.
 *
 * Receipt fields (inputsHash / verdictHash / engineVersion / rulesetHash …)
 * turn a log line into a *Veto Receipt*: a record that can be recomputed, not
 * just read.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HASH_ALG_V1, HASH_ALG_V2, hashOf, hashOfDomain, type HashAlg } from "./canonical.js";

export * from "./canonical.js";
export * from "./merkle.js";
export * from "./receiptkey.js";
export * from "./project.js";

export type AuditEventType =
  | "startup"
  | "intent_received"
  | "decision"
  | "order_placed"
  | "reconcile"
  | "freeze"
  | "unfreeze"
  | "shutdown"
  | "error"
  | "ai_commit"
  | "ai_reveal"
  | "policy_change"
  | "anchor";

/** Cryptographic accountability fields — what makes a line a receipt. */
export interface ReceiptFields {
  /** sha256 of the exact policy file bytes (provenance). */
  policyBytesHash?: string;
  /** Canonical hash of the parsed rules (semantics: same rules ⇒ same digest). */
  policySemanticHash?: string;
  /** Risk-engine semantic version — bumped whenever a verdict could change. */
  engineVersion?: string;
  /** Content hash of the decision-relevant sources (engine.ts + policy.ts). */
  rulesetHash?: string;
  /** Content address of the archived DecisionInput (logs/inputs/<hash>.json). */
  inputsHash?: string;
  /** sha256 of the verdict + rule-by-rule trace — the thing a third party recomputes. */
  verdictHash?: string;
  /** Advice digest committed BEFORE the decision (AI cannot back-date). */
  aiAdviceHash?: string;
  /** Human authorisation, bound to the exact state it released. */
  humanAuth?: { address: string; signature: string; boundTo: string };
  /** Venue order ids produced by this receipt, when it allowed an order. */
  orderIds?: number[];
}

export interface AuditEvent extends ReceiptFields {
  ts: string;
  type: AuditEventType;
  policyHash: string;
  data: Record<string, unknown>;
  /** Monotonic sequence within the file (1-based). */
  seq: number;
  /** Hash of the previous line; GENESIS for the first. */
  prev_hash: string;
  /** sha256 over this event's canonical fields + prev_hash. */
  hash: string;
  /** Absent on legacy lines ⇒ sha256/v1. */
  hashAlg?: HashAlg;
  /** EIP-191 receipt signature by the broker's receipt key (excluded from hash). */
  sig?: string;
  /** Address that produced sig. */
  signer?: string;
}

export const GENESIS_HASH = "GENESIS";

/** Legacy preimage (sha256/v1). Kept byte-for-byte so historical logs verify. */
export function hashEventV1(ev: Omit<AuditEvent, "hash">): string {
  const canonical = JSON.stringify([ev.seq, ev.ts, ev.type, ev.policyHash, ev.data, ev.prev_hash]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Current preimage (sha256/v2): canonical JSON over every field but hash/sig. */
export function hashEventV2(ev: Omit<AuditEvent, "hash">): string {
  // `hash` and `sig` can never be part of their own preimage; `signer` is
  // metadata about the signature, so it travels with `sig`.
  const { hash: _hash, sig: _sig, signer: _signer, ...rest } = ev as AuditEvent;
  return hashOf(rest);
}

/** @deprecated alias kept for callers written against the v1-only API. */
export const hashEvent = hashEventV1;

function computeHash(ev: Omit<AuditEvent, "hash">): string {
  return (ev.hashAlg ?? HASH_ALG_V1) === HASH_ALG_V2 ? hashEventV2(ev) : hashEventV1(ev);
}

/** Domain-separated message a receipt key signs (never sign a bare digest). */
export function receiptSigningPayload(hash: string): string {
  return "VetoOS receipt\n" + hashOfDomain("vetoos.receipt/1", hash);
}

export interface ChainVerification {
  ok: boolean;
  length: number;
  /** 1-based seq of the first broken link, if any. */
  brokenAt?: number;
  reason?: string;
  /** Number of pre-chain (legacy) lines at the top of the file, if any. */
  legacyPrefix?: number;
}

/** Parse a JSONL file leniently: a truncated trailing line is skipped, not fatal. */
export function readAuditFile(filePath: string): AuditEvent[] {
  if (!existsSync(filePath)) return [];
  const out: AuditEvent[] = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEvent);
    } catch {
      // half-written line (crash mid-append) — ignore, the chain check will
      // still be exact up to the last complete event.
    }
  }
  return out;
}

export function verifyChain(events: AuditEvent[]): ChainVerification {
  let prev = GENESIS_HASH;
  // Files written before hash-chaining existed may start with unchained
  // lines; the chain begins at the first chained line (numbered after them).
  let start = 0;
  while (start < events.length && typeof events[start]!.hash !== "string") start++;
  for (let i = start; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.seq !== i + 1) {
      return { ok: false, length: events.length, brokenAt: i + 1, reason: "seq " + ev.seq + " ≠ " + (i + 1) };
    }
    if (ev.prev_hash !== prev) {
      return { ok: false, length: events.length, brokenAt: ev.seq, reason: "prev_hash mismatch" };
    }
    if (computeHash(ev) !== ev.hash) {
      return { ok: false, length: events.length, brokenAt: ev.seq, reason: "hash mismatch (line edited)" };
    }
    prev = ev.hash;
  }
  return { ok: true, length: events.length, ...(start > 0 ? { legacyPrefix: start } : {}) };
}

/** Last chained event — the current chain head, used for state binding. */
export function chainHead(events: AuditEvent[]): { seq: number; hash: string } {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (typeof ev.hash === "string" && typeof ev.seq === "number") {
      return { seq: ev.seq, hash: ev.hash };
    }
  }
  return { seq: 0, hash: GENESIS_HASH };
}

/** Receipts that carry a recomputable verdict, in chain order. */
export function verdictReceipts(events: AuditEvent[]): AuditEvent[] {
  return events.filter((e) => typeof e.verdictHash === "string" && typeof e.inputsHash === "string");
}

export class AuditLog {
  private readonly filePath: string;
  private readonly policyHash: string;
  private seq = 0;
  private prevHash = GENESIS_HASH;

  constructor(dir: string, policyHash: string) {
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.filePath = join(dir, "audit-" + day + ".jsonl");
    this.policyHash = policyHash;
    // Resume the chain if today's file already exists (restart mid-day).
    const existing = readAuditFile(this.filePath);
    const last = existing[existing.length - 1];
    if (last && typeof last.seq === "number" && typeof last.hash === "string") {
      this.seq = last.seq;
      this.prevHash = last.hash;
    } else if (existing.length > 0) {
      // Pre-chain legacy lines: continue numbering after them.
      this.seq = existing.length;
    }
  }

  get path(): string {
    return this.filePath;
  }

  get head(): { seq: number; hash: string } {
    return { seq: this.seq, hash: this.prevHash };
  }

  /** Build the event that WILL be appended (hash computed, not yet written). */
  private build(
    type: AuditEventType,
    data: Record<string, unknown>,
    receipt: ReceiptFields,
    sign?: (payload: string) => { sig: string; signer: string },
  ): AuditEvent {
    const unhashed: Omit<AuditEvent, "hash"> = {
      ts: new Date().toISOString(),
      type,
      policyHash: this.policyHash,
      data,
      seq: this.seq + 1,
      prev_hash: this.prevHash,
      hashAlg: HASH_ALG_V2,
      ...receipt,
    };
    const event: AuditEvent = { ...unhashed, hash: computeHash(unhashed) };
    if (!sign) return event;
    try {
      // The digest never covers the signature (the signature is made from it).
      const { sig, signer } = sign(receiptSigningPayload(event.hash));
      return { ...event, sig, signer };
    } catch {
      // A signing failure must never lose the receipt.
      return event;
    }
  }

  private append(event: AuditEvent): AuditEvent {
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    this.seq = event.seq;
    this.prevHash = event.hash;
    return event;
  }

  record(
    type: AuditEventType,
    data: Record<string, unknown>,
    receipt: ReceiptFields = {},
  ): AuditEvent {
    return this.append(this.build(type, data, receipt));
  }

  /**
   * Record a *signed* receipt. Order matters: hash first, sign the hash, then
   * append once — so the line on disk is final and never rewritten.
   */
  recordSigned(
    type: AuditEventType,
    data: Record<string, unknown>,
    receipt: ReceiptFields,
    sign: (payload: string) => { sig: string; signer: string },
  ): AuditEvent {
    return this.append(this.build(type, data, receipt, sign));
  }

  /** Verify the chain of today's file as written so far. */
  verify(): ChainVerification {
    return verifyChain(readAuditFile(this.filePath));
  }

  /** Full event list of today's file (for verify tooling and the dashboard). */
  events(): AuditEvent[] {
    return readAuditFile(this.filePath);
  }

  /** One-line, plain-language console summary — the demo's narration track. */
  say(line: string): void {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  recordAndSay(
    type: AuditEventType,
    data: Record<string, unknown>,
    line: string,
    receipt: ReceiptFields = {},
  ): AuditEvent {
    const event = this.record(type, data, receipt);
    this.say(line);
    return event;
  }
}
