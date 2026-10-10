import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, readAuditFile, verifyChain } from "./index.js";

/**
 * The tamper matrix (docs/VERIFIABLE_RISK_ENGINE.md §8.2).
 * Every attack must be detected AND located, not merely "rejected".
 */
describe("tamper matrix (L1 integrity)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function freshLog(events = 5): AuditLog {
    dir = mkdtempSync(join(tmpdir(), "vetoos-tamper-"));
    const log = new AuditLog(dir, "policyhash");
    for (let i = 1; i <= events; i++) log.record("decision", { n: i, verdict: i === 3 ? "deny" : "allow" });
    return log;
  }

  function rewrite(path: string, mutate: (lines: string[]) => string[]): void {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, mutate(lines).join("\n") + "\n");
  }

  it("attack: edit a receipt's verdict -> hash mismatch at that seq", () => {
    const log = freshLog();
    rewrite(log.path, (lines) => {
      lines[2] = lines[2]!.replace('"verdict":"deny"', '"verdict":"allow"');
      return lines;
    });
    const v = verifyChain(readAuditFile(log.path));
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
    expect(v.reason).toMatch(/hash mismatch/);
  });

  it("attack: delete a middle receipt -> seq discontinuity", () => {
    const log = freshLog();
    rewrite(log.path, (lines) => {
      lines.splice(2, 1);
      return lines;
    });
    const v = verifyChain(readAuditFile(log.path));
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
    expect(v.reason).toMatch(/seq/);
  });

  it("attack: swap two receipts -> detected at the first reordered seq", () => {
    const log = freshLog();
    rewrite(log.path, (lines) => {
      const a = lines[2]!;
      lines[2] = lines[3]!;
      lines[3] = a;
      return lines;
    });
    const v = verifyChain(readAuditFile(log.path));
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
    expect(v.reason).toMatch(/seq/); // seq travels inside the line, so order is pinned
  });

  it("attack: reorder AND renumber to hide it -> hash mismatch", () => {
    const log = freshLog();
    rewrite(log.path, (lines) => {
      const a = JSON.parse(lines[2]!) as Record<string, unknown>;
      const b = JSON.parse(lines[3]!) as Record<string, unknown>;
      a["seq"] = 4;
      b["seq"] = 3;
      lines[2] = JSON.stringify(b);
      lines[3] = JSON.stringify(a);
      return lines;
    });
    const v = verifyChain(readAuditFile(log.path));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/hash mismatch/); // seq is inside the preimage
  });

  it("attack: append a forged receipt with a renumbered seq", () => {
    const log = freshLog(3);
    rewrite(log.path, (lines) => {
      const forged = JSON.parse(lines[2]!) as Record<string, unknown>;
      forged["seq"] = 4;
      forged["data"] = { n: 99, verdict: "allow" };
      lines.push(JSON.stringify(forged));
      return lines;
    });
    const v = verifyChain(readAuditFile(log.path));
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(4);
  });

  it("attack: truncate the tail (rollback to an earlier state)", () => {
    const log = freshLog(5);
    rewrite(log.path, (lines) => lines.slice(0, 3));
    const v = verifyChain(readAuditFile(log.path));
    // A bare truncation is internally consistent — which is exactly why L3
    // anchoring exists: only the published root can catch this.
    expect(v.ok).toBe(true);
    expect(v.length).toBe(3);
  });

  it("a clean log verifies, and says how long it is", () => {
    const log = freshLog(5);
    expect(log.verify()).toEqual({ ok: true, length: 5 });
    expect(log.head.seq).toBe(5);
  });

  it("new receipts declare sha256/v2 while legacy lines stay v1", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-tamper-"));
    const path = join(dir, "audit-" + new Date().toISOString().slice(0, 10) + ".jsonl");
    writeFileSync(path, JSON.stringify({ ts: "t", type: "startup", policyHash: "p", data: {} }) + "\n");
    const log = new AuditLog(dir, "p");
    const first = log.record("decision", { n: 1 });
    const second = log.record("decision", { n: 2 });
    expect(first.hashAlg).toBe("sha256/v2");
    expect(second.prev_hash).toBe(first.hash);
    // Mixed generations must still verify: the algorithm travels with the line.
    expect(verifyChain(readAuditFile(path))).toEqual({ ok: true, length: 3, legacyPrefix: 1 });
  });
});
