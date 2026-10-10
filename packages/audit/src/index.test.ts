import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, GENESIS_HASH, readAuditFile, verifyChain } from "./index.js";

describe("AuditLog hash chain", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("chains events: seq increments, prev_hash links, verify passes", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-audit-"));
    const log = new AuditLog(dir, "policyhash");
    const a = log.record("startup", { n: 1 });
    const b = log.record("decision", { n: 2 });
    expect(a.seq).toBe(1);
    expect(a.prev_hash).toBe(GENESIS_HASH);
    expect(b.seq).toBe(2);
    expect(b.prev_hash).toBe(a.hash);
    expect(log.verify()).toEqual({ ok: true, length: 2 });
  });

  it("detects an edited historical line", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-audit-"));
    const log = new AuditLog(dir, "policyhash");
    log.record("decision", { decision: "deny" });
    log.record("decision", { decision: "allow" });
    const lines = readFileSync(log.path, "utf8").trim().split("\n");
    lines[0] = lines[0]!.replace('"deny"', '"allow"'); // rewrite history
    writeFileSync(log.path, lines.join("\n") + "\n");
    const v = log.verify();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it("detects a deleted line", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-audit-"));
    const log = new AuditLog(dir, "policyhash");
    log.record("decision", { n: 1 });
    log.record("decision", { n: 2 });
    log.record("decision", { n: 3 });
    const lines = readFileSync(log.path, "utf8").trim().split("\n");
    lines.splice(1, 1);
    writeFileSync(log.path, lines.join("\n") + "\n");
    const v = verifyChain(readAuditFile(log.path));
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(2);
  });

  it("resumes the chain across process restarts", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-audit-"));
    const first = new AuditLog(dir, "policyhash");
    first.record("startup", {});
    const second = new AuditLog(dir, "policyhash");
    const ev = second.record("decision", {});
    expect(ev.seq).toBe(2);
    expect(second.verify().ok).toBe(true);
  });

  it("a legacy (pre-chain) prefix is tolerated and reported", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-audit-"));
    const path = join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(path, JSON.stringify({ ts: "t", type: "startup", policyHash: "p", data: {} }) + "\n");
    const log = new AuditLog(dir, "p");
    const ev = log.record("decision", {});
    expect(ev.seq).toBe(2);
    expect(log.verify()).toEqual({ ok: true, length: 2, legacyPrefix: 1 });
  });

  it("tolerates a half-written trailing line", () => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-audit-"));
    const log = new AuditLog(dir, "policyhash");
    log.record("startup", {});
    writeFileSync(log.path, readFileSync(log.path, "utf8") + '{"ts":"2026-', { flag: "w" });
    expect(readAuditFile(log.path)).toHaveLength(1);
  });
});
