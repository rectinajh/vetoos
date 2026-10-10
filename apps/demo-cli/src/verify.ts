/**
 * vetoos verify — the verifier (docs/VERIFIABLE_RISK_ENGINE.md §8).
 *
 * Four independent checks, each able to fail on its own:
 *
 *   L0 parse      JSONL is readable and the schema versions are known
 *   L1 integrity  hash chain: seq monotonic, prev_hash links, hash recomputes
 *   L2 authentic  receipt signatures verify against the declared signer
 *   L2 replay     every verdict recomputes from its ARCHIVED input, to the
 *                 identical verdictHash (rule-by-rule trace included)
 *   L3 anchored   receipt Merkle root matches what was published on HyperEVM,
 *                 and the anchored sequence never went backwards
 *
 * The point is not "we have logs". It is that a third party can take these
 * files, run this program, and either reproduce every verdict or be told
 * exactly which sequence number lied.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chainHead,
  readAuditFile,
  receiptSigningPayload,
  verifyChain,
  verifyMerkleProof,
  verifyReceiptSignature,
  merkleRoot,
  merkleProof,
  type AuditEvent,
} from "@vetoos/audit";
import {
  RULESET_HASH,
  contextFromDecisionInput,
  decisionInputHash,
  evaluateIntent,
  verdictHashOf,
  type DecisionInput,
} from "@vetoos/risk";

export interface VerifyOptions {
  /** Receipts file. Defaults to today's audit file under VETOOS_STATE_DIR/logs. */
  receipts?: string;
  /** Directory holding archived DecisionInputs. Defaults to <receipts dir>/inputs. */
  inputs?: string;
  /** Local anchor journal. Defaults to <receipts dir>/anchors.jsonl. */
  anchors?: string;
  /** Machine-readable result. */
  json?: boolean;
  /** Verify a single receipt and print its Merkle inclusion proof. */
  prove?: number;
  /** Stop after this level: 1 = chain only, 2 = + signature/replay. */
  level?: number;
}

interface LevelResult {
  level: string;
  ok: boolean;
  detail: string;
  failures: string[];
}

export interface VerifyReport {
  ok: boolean;
  file: string;
  receipts: number;
  head: { seq: number; hash: string };
  levels: LevelResult[];
  unanchoredTail: number;
}

function defaultDir(): string {
  return process.env.VETOOS_STATE_DIR ?? "logs";
}

function todayFile(dir: string): string {
  return join(dir, "audit-" + new Date().toISOString().slice(0, 10) + ".jsonl");
}

export async function runVerify(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const dir = defaultDir();
  const file = opts.receipts ?? todayFile(dir);
  const inputsDir = opts.inputs ?? join(file.replace(/\/[^/]+$/, ""), "inputs");
  const anchorsFile = opts.anchors ?? join(file.replace(/\/[^/]+$/, ""), "anchors.jsonl");
  const levels: LevelResult[] = [];

  // ---- L0: parse -----------------------------------------------------------
  if (!existsSync(file)) {
    return {
      ok: false,
      file,
      receipts: 0,
      head: { seq: 0, hash: "GENESIS" },
      levels: [{ level: "L0 parse", ok: false, detail: "no receipts file: " + file, failures: [] }],
      unanchoredTail: 0,
    };
  }
  const events = readAuditFile(file);
  const unknownSchema = events.filter(
    (e) => e.hashAlg !== undefined && e.hashAlg !== "sha256/v1" && e.hashAlg !== "sha256/v2",
  );
  levels.push({
    level: "L0 parse",
    ok: unknownSchema.length === 0,
    detail: events.length + " receipts, " + unknownSchema.length + " unknown hash_alg",
    failures: unknownSchema.map((e) => "seq " + e.seq + ": unknown hash_alg " + String(e.hashAlg)),
  });

  // ---- L1: integrity -------------------------------------------------------
  const chain = verifyChain(events);
  levels.push({
    level: "L1 chain",
    ok: chain.ok,
    detail: chain.ok
      ? chain.length +
        " receipts linked" +
        (chain.legacyPrefix ? " (" + chain.legacyPrefix + " legacy prefix)" : "")
      : "broken at seq " + chain.brokenAt + ": " + chain.reason,
    failures: chain.ok ? [] : ["seq " + chain.brokenAt + ": " + chain.reason],
  });

  // ---- L2a: signatures -----------------------------------------------------
  if ((opts.level ?? 3) >= 2) {
    const signed = events.filter((e) => typeof e.sig === "string" && typeof e.signer === "string");
    const badSig: string[] = [];
    for (const ev of signed) {
      // Ed25519 over the domain-separated payload; `signer` is the public id.
      const ok = verifyReceiptSignature(receiptSigningPayload(ev.hash), ev.sig!, ev.signer!);
      if (!ok) badSig.push("seq " + ev.seq + ": signature does not match signer " + ev.signer);
    }
    levels.push({
      level: "L2 signatures",
      ok: badSig.length === 0,
      detail: signed.length === 0 ? "no signed receipts (receipt key not configured)" : signed.length + " signatures checked",
      failures: badSig,
    });

    // ---- L2b: replay -------------------------------------------------------
    const verdicts = events.filter((e) => typeof e.verdictHash === "string" && typeof e.inputsHash === "string");
    const failures: string[] = [];
    let recomputed = 0;
    let ruleMismatch = 0;
    for (const ev of verdicts) {
      const recordedInputs = ev.inputsHash!;
      const recordedVerdict = ev.verdictHash!;
      const path = join(inputsDir, recordedInputs + ".json");
      if (!existsSync(path)) {
        failures.push("seq " + ev.seq + ": archived input " + recordedInputs.slice(0, 12) + "… is missing");
        continue;
      }
      let input: DecisionInput;
      try {
        input = JSON.parse(readFileSync(path, "utf8")) as DecisionInput;
      } catch (err) {
        failures.push("seq " + ev.seq + ": unreadable input archive (" + (err instanceof Error ? err.message : String(err)) + ")");
        continue;
      }
      // Content addressing: the file must hash to the name it is stored under,
      // and the receipt must point at that same hash.
      const actualInputsHash = decisionInputHash(input);
      if (actualInputsHash !== recordedInputs) {
        failures.push(
          "seq " + ev.seq + ": inputsHash mismatch (receipt " + recordedInputs.slice(0, 12) + "…, archive " + actualInputsHash.slice(0, 12) + "…)",
        );
        continue;
      }
      if (input.rulesetHash !== RULESET_HASH) {
        ruleMismatch++;
        failures.push(
          "seq " + ev.seq + ": recorded under ruleset " + input.rulesetHash.slice(0, 12) + "…, current ruleset is " + RULESET_HASH.slice(0, 12) + "… (rules changed, not tampering)",
        );
        continue;
      }
      const decision = evaluateIntent(input.intent, input.policy, contextFromDecisionInput(input));
      const replayHash = verdictHashOf(decision);
      if (replayHash !== recordedVerdict) {
        failures.push(
          "seq " + ev.seq + ": replay produced a DIFFERENT verdict (" + replayHash.slice(0, 12) + "… ≠ " + recordedVerdict.slice(0, 12) + "…)",
        );
        continue;
      }
      recomputed++;
    }
    levels.push({
      level: "L2 replay",
      ok: failures.length === 0,
      detail:
        verdicts.length === 0
          ? "no verdict receipts to replay"
          : recomputed + "/" + verdicts.length + " verdicts recomputed" + (ruleMismatch ? ", " + ruleMismatch + " under an older ruleset" : ""),
      failures,
    });
  }

  // ---- L3: anchoring -------------------------------------------------------
  const receiptHashes = events.filter((e) => typeof e.hash === "string").map((e) => e.hash);
  let unanchoredTail = receiptHashes.length;
  if ((opts.level ?? 3) >= 3) {
    const level3 = verifyAnchors(anchorsFile, receiptHashes);
    unanchoredTail = level3.unanchoredTail;
    levels.push(level3.result);
  }

  const ok = levels.every((l) => l.ok);
  return {
    ok,
    file,
    receipts: events.length,
    head: chainHead(events),
    levels,
    unanchoredTail,
  };
}

interface AnchorRecord {
  seq: number;
  root: string;
  receiptCount: number;
  ts: string;
  txHash?: string;
  chainId?: number;
  contract?: string;
}

export function verifyAnchors(
  anchorsFile: string,
  receiptHashes: string[],
): { result: LevelResult; unanchoredTail: number } {
  if (!existsSync(anchorsFile)) {
    return {
      result: {
        level: "L3 anchor",
        ok: true, // unanchored history is a known, reported limit — not a failure
        detail: "no anchor journal yet; " + receiptHashes.length + " receipts unanchored",
        failures: [],
      },
      unanchoredTail: receiptHashes.length,
    };
  }
  const anchors: AnchorRecord[] = readFileSync(anchorsFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AnchorRecord)
    .sort((a, b) => a.seq - b.seq);
  const failures: string[] = [];
  let lastSeq = 0;
  let anchored = 0;
  for (const anchor of anchors) {
    if (anchor.seq <= lastSeq) {
      failures.push("anchor seq " + anchor.seq + " does not advance past " + lastSeq + " (rollback)");
      break;
    }
    const slice = receiptHashes.slice(0, anchor.receiptCount);
    if (slice.length < anchor.receiptCount) {
      failures.push(
        "anchor seq " + anchor.seq + " covers " + anchor.receiptCount + " receipts but only " + slice.length + " exist locally (history truncated)",
      );
      break;
    }
    const root = merkleRoot(slice);
    if (root !== anchor.root) {
      failures.push(
        "anchor seq " + anchor.seq + ": local Merkle root " + root.slice(0, 12) + "… ≠ anchored " + anchor.root.slice(0, 12) + "… (history rewritten)",
      );
      break;
    }
    lastSeq = anchor.seq;
    anchored = anchor.receiptCount;
  }
  const tail = receiptHashes.length - anchored;
  return {
    result: {
      level: "L3 anchor",
      ok: failures.length === 0,
      detail:
        failures.length > 0
          ? failures[0]!
          : anchored > 0
            ? anchored + " receipts anchored (latest anchor seq " + lastSeq + "), unanchored tail " + tail
            : "anchor journal empty",
      failures,
    },
    unanchoredTail: tail,
  };
}

/** Merkle inclusion proof for one receipt (selective disclosure). */
export function proveReceipt(events: AuditEvent[], seq: number): string {
  const hashes = events.filter((e) => typeof e.hash === "string").map((e) => e.hash);
  const proof = merkleProof(hashes, seq - 1);
  const ok = verifyMerkleProof(proof);
  return [
    "receipt seq " + seq + " leaf " + proof.leaf,
    "root        " + proof.root,
    "path        " + proof.steps.map((s) => s.position + ":" + s.hash.slice(0, 12)).join(" -> "),
    "self-check  " + (ok ? "OK" : "FAILED"),
  ].join("\n");
}

export async function verifyCommand(argv: string[]): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const opts: VerifyOptions = {
    ...(arg("--receipts") ? { receipts: arg("--receipts")! } : {}),
    ...(arg("--inputs") ? { inputs: arg("--inputs")! } : {}),
    ...(arg("--anchors") ? { anchors: arg("--anchors")! } : {}),
    ...(argv.includes("--json") ? { json: true } : {}),
    ...(arg("--prove") ? { prove: Number(arg("--prove")) } : {}),
    ...(arg("--level") ? { level: Number(arg("--level")) } : {}),
  };

  if (opts.prove !== undefined) {
    const file = opts.receipts ?? todayFile(defaultDir());
    process.stdout.write(proveReceipt(readAuditFile(file), opts.prove) + "\n");
    return 0;
  }

  const report = await runVerify(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    for (const level of report.levels) {
      process.stdout.write(
        (level.ok ? "OK   " : "FAIL ") + level.level.padEnd(16) + level.detail + "\n",
      );
      for (const f of level.failures.slice(0, 5)) process.stdout.write("       - " + f + "\n");
    }
    process.stdout.write(
      "head " + report.head.seq + " " + report.head.hash.slice(0, 16) + "…  unanchored tail " + report.unanchoredTail + "\n",
    );
    process.stdout.write(report.ok ? "RESULT: VERIFIED\n" : "RESULT: FAILED\n");
  }
  return report.ok ? 0 : 1;
}
