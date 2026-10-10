/**
 * @vetoos/audit — every allow/deny/freeze leaves a bilingual, structured
 * trail. JSONL for machines, one-line human summary for judges and demos.
 *
 * Each line is hash-chained: `seq` increments, `prev_hash` is the previous
 * line's `hash`, and `hash = sha256(seq|ts|type|policyHash|data|prev_hash)`.
 * Deleting, reordering or editing any historical line breaks the chain —
 * `verifyChain` tells you exactly where.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AuditEventType =
  | "startup"
  | "intent_received"
  | "decision"
  | "order_placed"
  | "reconcile"
  | "freeze"
  | "unfreeze"
  | "shutdown"
  | "error";

export interface AuditEvent {
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
}

export const GENESIS_HASH = "GENESIS";

export function hashEvent(ev: Omit<AuditEvent, "hash">): string {
  const canonical = JSON.stringify([ev.seq, ev.ts, ev.type, ev.policyHash, ev.data, ev.prev_hash]);
  return createHash("sha256").update(canonical).digest("hex");
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
      return { ok: false, length: events.length, brokenAt: i + 1, reason: `seq ${ev.seq} ≠ ${i + 1}` };
    }
    if (ev.prev_hash !== prev) {
      return { ok: false, length: events.length, brokenAt: ev.seq, reason: "prev_hash mismatch" };
    }
    const { hash, ...rest } = ev;
    if (hashEvent(rest) !== hash) {
      return { ok: false, length: events.length, brokenAt: ev.seq, reason: "hash mismatch (line edited)" };
    }
    prev = hash;
  }
  return { ok: true, length: events.length, ...(start > 0 ? { legacyPrefix: start } : {}) };
}

export class AuditLog {
  private readonly filePath: string;
  private readonly policyHash: string;
  private seq = 0;
  private prevHash = GENESIS_HASH;

  constructor(dir: string, policyHash: string) {
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.filePath = join(dir, `audit-${day}.jsonl`);
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

  record(type: AuditEventType, data: Record<string, unknown>): AuditEvent {
    const unhashed: Omit<AuditEvent, "hash"> = {
      ts: new Date().toISOString(),
      type,
      policyHash: this.policyHash,
      data,
      seq: this.seq + 1,
      prev_hash: this.prevHash,
    };
    const event: AuditEvent = { ...unhashed, hash: hashEvent(unhashed) };
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    this.seq = event.seq;
    this.prevHash = event.hash;
    return event;
  }

  /** Verify the chain of today's file as written so far. */
  verify(): ChainVerification {
    return verifyChain(readAuditFile(this.filePath));
  }

  /** One-line, plain-language console summary — the demo's narration track. */
  say(line: string): void {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  recordAndSay(type: AuditEventType, data: Record<string, unknown>, line: string): AuditEvent {
    const event = this.record(type, data);
    this.say(line);
    return event;
  }
}
