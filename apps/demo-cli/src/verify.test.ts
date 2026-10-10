import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  generateReceiptKey,
  merkleRoot,
  readAuditFile,
  receiptSignerFromSeed,
  receiptSigningPayload,
} from "@vetoos/audit";
import { validateIntent } from "@vetoos/intent";
import {
  buildDecisionInput,
  canonicalDecisionInput,
  contextFromDecisionInput,
  decisionInputHash,
  evaluateIntent,
  loadPolicy,
  verdictHashOf,
} from "@vetoos/risk";
import { runVerify } from "./verify.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");

/** A receipt chain with one real, replayable verdict — the smallest honest fixture. */
function buildFixture(dir: string, signer?: (payload: string) => { sig: string; signer: string }) {
  const policy = loadPolicy(join(REPO_ROOT, "configs/policy.demo.json"));
  const audit = new AuditLog(dir, policy.contentHash);
  const intent = validateIntent({
    version: "0.1",
    id: randomUUID(),
    ts: new Date(1700000000000).toISOString(),
    source: "strategy-a",
    market: policy.policy.default_market,
    side: "buy",
    size: "0.001",
    order_type: "market",
  });
  if (!intent.ok) throw new Error("fixture intent invalid: " + intent.error);
  const now = 1700000000000;
  const input = buildDecisionInput({
    intent: intent.intent,
    policy: policy.policy,
    policyBytesHash: policy.contentHash,
    market: {
      market: policy.policy.default_market,
      markPx: 31000,
      funding: 0.00000625,
      openInterest: 7500,
      depthWithinBand: 5,
      szDecimals: 3,
    },
    account: {
      equityUsd: 1000,
      availableMarginUsd: 1000,
      dailyRealizedPnlUsd: 0,
      currentPositionNotionalUsd: 0,
      currentPositionSize: 0,
    },
    history: [],
    frozen: false,
    now,
  });
  const decision = evaluateIntent(input.intent, input.policy, contextFromDecisionInput(input));
  const inputsHash = decisionInputHash(input);
  const inputsDir = join(dir, "inputs");
  mkdirSync(inputsDir, { recursive: true });
  writeFileSync(join(inputsDir, inputsHash + ".json"), canonicalDecisionInput(input), "utf8");
  const receipt = {
    policyBytesHash: policy.contentHash,
    inputsHash,
    verdictHash: verdictHashOf(decision),
  };
  if (signer) audit.recordSigned("decision", { intent_id: input.intent.id, ...decision }, receipt, signer);
  else audit.record("decision", { intent_id: input.intent.id, ...decision }, receipt);
  const file = audit.path;
  return { audit, file, inputsDir, inputsHash, decision, input };
}

describe("vetoos verify", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-verify-"));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("verifies a clean chain and reproduces the verdict from the archive", async () => {
    const { file, inputsDir } = buildFixture(dir);
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors: join(dir, "none.jsonl") });
    expect(report.ok).toBe(true);
    expect(report.levels.map((l) => l.level)).toEqual([
      "L0 parse",
      "L1 chain",
      "L2 signatures",
      "L2 replay",
      "L3 anchor",
    ]);
    const replay = report.levels.find((l) => l.level === "L2 replay")!;
    expect(replay.detail).toContain("1/1 verdicts recomputed");
  });

  it("attack: swap the archived input -> inputsHash mismatch (content addressing)", async () => {
    const { file, inputsDir, inputsHash, input } = buildFixture(dir);
    const tampered = { ...input, market: { ...input.market, markPx: 1 } };
    writeFileSync(join(inputsDir, inputsHash + ".json"), JSON.stringify(tampered), "utf8");
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors: join(dir, "none.jsonl") });
    expect(report.ok).toBe(false);
    const replay = report.levels.find((l) => l.level === "L2 replay")!;
    expect(replay.failures.join(" ")).toMatch(/inputsHash mismatch/);
  });

  it("attack: delete the archive -> replay cannot be faked", async () => {
    const { file, inputsDir, inputsHash } = buildFixture(dir);
    rmSync(join(inputsDir, inputsHash + ".json"));
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors: join(dir, "none.jsonl") });
    expect(report.ok).toBe(false);
    expect(report.levels.find((l) => l.level === "L2 replay")!.failures.join(" ")).toMatch(/missing/);
  });

  it("attack: edit the verdict hash in the receipt -> L1 catches it first", async () => {
    const { file, inputsDir } = buildFixture(dir);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    lines[0] = lines[0]!.replace(/"verdictHash":"[0-9a-f]{8}/, '"verdictHash":"deadbeef');
    writeFileSync(file, lines.join("\n") + "\n");
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors: join(dir, "none.jsonl") });
    expect(report.ok).toBe(false);
    expect(report.levels.find((l) => l.level === "L1 chain")!.ok).toBe(false);
  });

  it("attack: publish a wrong Merkle root -> L3 rejects the history", async () => {
    const { file, inputsDir } = buildFixture(dir);
    const anchors = join(dir, "anchors.jsonl");
    writeFileSync(
      anchors,
      JSON.stringify({ seq: 1, root: "0".repeat(64), receiptCount: 1, ts: new Date().toISOString() }) + "\n",
      "utf8",
    );
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors });
    expect(report.ok).toBe(false);
    expect(report.levels.find((l) => l.level === "L3 anchor")!.failures.join(" ")).toMatch(/history rewritten/);
  });

  it("attack: truncate after anchoring -> L3 reports a truncated history", async () => {
    const { audit, file, inputsDir } = buildFixture(dir);
    const hashes = readAuditFile(file).map((e) => e.hash);
    const anchors = join(dir, "anchors.jsonl");
    writeFileSync(
      anchors,
      JSON.stringify({ seq: 1, root: merkleRoot(hashes), receiptCount: 2, ts: new Date().toISOString() }) + "\n",
      "utf8",
    );
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors });
    expect(report.ok).toBe(false);
    expect(report.levels.find((l) => l.level === "L3 anchor")!.failures.join(" ")).toMatch(/truncated/);
    void audit;
  });

  it("verifies ed25519 receipt signatures (authenticity layer)", async () => {
    const { seed } = generateReceiptKey();
    const signer = receiptSignerFromSeed(seed);
    const { file, inputsDir } = buildFixture(join(dir, "signed"), signer.sign);
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors: join(dir, "none.jsonl") });
    const sigs = report.levels.find((l) => l.level === "L2 signatures")!;
    expect(sigs.ok).toBe(true);
    expect(sigs.detail).toContain("1 signatures checked");
    expect(report.ok).toBe(true);
  });

  it("rejects a receipt whose signature was minted by another key", async () => {
    const real = receiptSignerFromSeed(generateReceiptKey().seed);
    const impostor = receiptSignerFromSeed(generateReceiptKey().seed);
    const { file, inputsDir } = buildFixture(join(dir, "impostor"), real.sign);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    const forged = impostor.sign(receiptSigningPayload(String(event["hash"])));
    event["sig"] = forged.sig;
    event["signer"] = real.signer; // claims to be the real signer
    writeFileSync(file, JSON.stringify(event) + "\n");
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors: join(dir, "none.jsonl") });
    expect(report.ok).toBe(false);
    expect(report.levels.find((l) => l.level === "L2 signatures")!.failures.join(" ")).toMatch(/does not match signer/);
  });

  it("a matching anchor leaves only the tail unanchored (reported, not hidden)", async () => {
    const { file, inputsDir } = buildFixture(dir);
    const hashes = readAuditFile(file).map((e) => e.hash);
    const anchors = join(dir, "anchors.jsonl");
    writeFileSync(
      anchors,
      JSON.stringify({ seq: 1, root: merkleRoot(hashes), receiptCount: hashes.length, ts: new Date().toISOString() }) + "\n",
      "utf8",
    );
    const report = await runVerify({ receipts: file, inputs: inputsDir, anchors });
    expect(report.ok).toBe(true);
    expect(report.unanchoredTail).toBe(0);
  });
});
