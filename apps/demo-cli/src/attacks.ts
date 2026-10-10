/**
 * \`pnpm prove\` — the attack suite (docs/VERIFIABLE_RISK_ENGINE.md §8.2).
 *
 * A verifier nobody has attacked is a claim, not a proof. This takes the
 * receipts a real run just produced, makes four dishonest copies of them, and
 * checks that the verifier catches every one AND NAMES THE PLACE.
 *
 * It is deliberately a separate command from \`pnpm verify\`: verify answers
 * "is this history honest?", prove answers "would a dishonest history get
 * through?". Exit code is 0 only when the baseline verifies and all four
 * attacks are caught.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { merkleRoot, readAuditFile } from "@vetoos/audit";
import { runVerify } from "./verify.js";

interface AttackOutcome {
  name: string;
  caught: boolean;
  detail: string;
}

function defaultFile(): string {
  const dir = process.env.VETOOS_STATE_DIR ?? "logs";
  return join(dir, "audit-" + new Date().toISOString().slice(0, 10) + ".jsonl");
}

/** First line the verifier printed for a given level, for a readable report. */
function failureLine(report: Awaited<ReturnType<typeof runVerify>>, level: string): string {
  const found = report.levels.find((l) => l.level === level);
  if (!found) return "level missing";
  if (found.ok) return "NOT CAUGHT — verifier reported OK";
  return found.failures[0] ?? found.detail;
}

function firstDenyIndex(events: ReturnType<typeof readAuditFile>): number {
  const i = events.findIndex(
    (e) => e.type === "decision" && (e.data as Record<string, unknown>)["decision"] === "deny",
  );
  return i;
}

export async function attacksCommand(argv: string[]): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const receipts = arg("--receipts") ?? defaultFile();
  const inputs = arg("--inputs") ?? join(dirname(receipts), "inputs");

  let source: string;
  try {
    source = readFileSync(receipts, "utf8");
  } catch (err) {
    console.error("[prove] cannot read receipts at " + receipts + ": " + String(err));
    console.error("[prove] run the demo first: pnpm demo:record");
    return 1;
  }

  const work = mkdtempSync(join(tmpdir(), "vetoos-attacks-"));
  const cleanDir = join(work, "clean");
  const cleanFile = join(cleanDir, "receipts.jsonl");
  cpSync(dirname(receipts) + "/inputs", join(cleanDir, "inputs"), { recursive: true });
  writeFileSync(cleanFile, source, "utf8");

  const line = (label: string, verdict: string, detail: string): void => {
    console.log(label.padEnd(58) + verdict.padEnd(10) + detail);
  };

  console.log("\n== VetoOS attack suite: four ways to lie to a verifier ==\n");

  // 0. Baseline: the untouched receipts must verify, or the rest is noise.
  const baseline = await runVerify({ receipts: cleanFile, inputs: join(cleanDir, "inputs"), level: 2 });
  const clean = baseline.ok;
  line(
    "[baseline] untouched receipts",
    clean ? "VERIFIED" : "FAILED",
    baseline.levels.map((l) => l.detail).join(" · "),
  );

  const outcomes: AttackOutcome[] = [];
  const events = readAuditFile(cleanFile);
  const denyAt = firstDenyIndex(events);

  // 1. Rewrite history: flip one denial into an approval.
  {
    const dir = join(work, "a1");
    cpSync(cleanDir, dir, { recursive: true });
    const file = join(dir, "receipts.jsonl");
    const lines = source.trim().split("\n");
    if (denyAt >= 0) {
      lines[denyAt] = lines[denyAt]!.replace('"decision":"deny"', '"decision":"allow"');
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const report = await runVerify({ receipts: file, inputs: join(dir, "inputs"), level: 2 });
    const detail = report.ok ? "NOT CAUGHT" : failureLine(report, "L1 chain");
    outcomes.push({ name: "flip a DENY verdict to ALLOW", caught: !report.ok, detail });
  }

  // 2. Delete one receipt from the middle.
  {
    const dir = join(work, "a2");
    cpSync(cleanDir, dir, { recursive: true });
    const file = join(dir, "receipts.jsonl");
    const lines = source.trim().split("\n");
    const cut = Math.min(Math.max(denyAt, 1), lines.length - 2);
    lines.splice(cut, 1);
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const report = await runVerify({ receipts: file, inputs: join(dir, "inputs"), level: 2 });
    const detail = report.ok ? "NOT CAUGHT" : failureLine(report, "L1 chain");
    outcomes.push({ name: "delete a receipt in the middle", caught: !report.ok, detail });
  }

  // 3. Keep the receipt, swap the archived input it points at.
  {
    const dir = join(work, "a3");
    cpSync(cleanDir, dir, { recursive: true });
    const target = events.find((e) => typeof e.inputsHash === "string");
    if (target) {
      const file = join(dir, "inputs", target.inputsHash + ".json");
      const input = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const market = input["market"] as Record<string, unknown>;
      market["markPx"] = 1; // a price that would have made the order look tiny
      writeFileSync(file, JSON.stringify(input), "utf8");
    }
    const report = await runVerify({ receipts: join(dir, "receipts.jsonl"), inputs: join(dir, "inputs"), level: 2 });
    const detail = report.ok ? "NOT CAUGHT" : failureLine(report, "L2 replay");
    outcomes.push({ name: "swap the archived input behind a receipt", caught: !report.ok, detail });
  }

  // 4. Publish a Merkle root that does not match the receipts.
  {
    const dir = join(work, "a4");
    cpSync(cleanDir, dir, { recursive: true });
    const hashes = events.filter((e) => typeof e.hash === "string").map((e) => e.hash);
    const anchors = join(dir, "anchors.jsonl");
    writeFileSync(
      anchors,
      JSON.stringify({ seq: hashes.length, root: "0".repeat(64), receiptCount: hashes.length, ts: new Date().toISOString() }) + "\n",
      "utf8",
    );
    const report = await runVerify({
      receipts: join(dir, "receipts.jsonl"),
      inputs: join(dir, "inputs"),
      anchors,
      level: 3,
    });
    const detail = report.ok ? "NOT CAUGHT" : failureLine(report, "L3 anchor");
    outcomes.push({ name: "anchor a root that does not match", caught: !report.ok, detail });
    void merkleRoot;
  }

  for (const [i, outcome] of outcomes.entries()) {
    line("[attack " + (i + 1) + "] " + outcome.name, outcome.caught ? "CAUGHT" : "MISSED", outcome.detail);
  }

  const caught = outcomes.filter((o) => o.caught).length;
  console.log(
    "\n" + caught + "/" + outcomes.length + " attacks caught" + (clean ? "" : " (baseline did not verify!)") + ".",
  );
  console.log(
    clean && caught === outcomes.length
      ? "A verifier that cannot be fooled is the point.\n"
      : "Something got through — investigate before recording.\n",
  );

  rmSync(work, { recursive: true, force: true });
  return clean && caught === outcomes.length ? 0 : 1;
}
