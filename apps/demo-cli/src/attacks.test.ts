/**
 * The attack suite must keep catching things. If someone loosens a check in
 * verify.ts, this test fails — which is the only way "we catch tampering"
 * stays true over time.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "@vetoos/audit";
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
import { attacksCommand } from "./attacks.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");

describe("attack suite", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vetoos-attacks-"));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("catches every attack on a run that verifies clean", async () => {
    const policy = loadPolicy(join(REPO_ROOT, "configs/policy.demo.json"));
    const audit = new AuditLog(dir, policy.contentHash);
    const inputs = join(dir, "inputs");
    mkdirSync(inputs, { recursive: true });

    // Two intents: one allowed (with a fill), one denied — enough shape for
    // every attack to have something to lie about.
    for (const size of ["0.001", "1000"]) {
      const parsed = validateIntent({
        version: "0.1",
        id: randomUUID(),
        ts: new Date(1_700_000_000_000).toISOString(),
        source: "attack-fixture",
        market: policy.policy.default_market,
        side: "buy",
        size,
        order_type: "market",
      });
      if (!parsed.ok) throw new Error(parsed.error);
      const input = buildDecisionInput({
        intent: parsed.intent,
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
        now: 1_700_000_000_000,
      });
      audit.record("intent_received", { intent: parsed.intent, at: 1_700_000_000_000 });
      const decision = evaluateIntent(input.intent, input.policy, contextFromDecisionInput(input));
      const inputsHash = decisionInputHash(input);
      writeFileSync(join(inputs, inputsHash + ".json"), canonicalDecisionInput(input), "utf8");
      audit.record(
        "decision",
        { intent_id: parsed.intent.id, ...decision },
        { inputsHash, verdictHash: verdictHashOf(decision) },
      );
      if (decision.decision === "allow") {
        audit.record("order_placed", {
          intent_id: parsed.intent.id,
          market: parsed.intent.market,
          side: parsed.intent.side,
          at: 1_700_000_000_100,
          filledSize: 0.001,
          avgPx: 31000,
          oid: 1,
        });
      }
    }

    const code = await attacksCommand(["--receipts", audit.path, "--inputs", inputs]);
    expect(code).toBe(0);
  });

  it("fails loudly when there are no receipts to attack", async () => {
    const code = await attacksCommand(["--receipts", join(dir, "missing.jsonl")]);
    expect(code).toBe(1);
  });
});
