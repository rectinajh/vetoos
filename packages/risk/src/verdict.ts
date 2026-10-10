/**
 * Verifiable decision record (docs/VERIFIABLE_RISK_ENGINE.md §4).
 *
 * A verdict is only "reproducible" if its input is fully specified and kept.
 * The engine is already pure — evaluateIntent(intent, policy, ctx) — but ctx
 * carries three things that are NOT derivable from the intent or the policy:
 *
 *     history  -> decides the cooldown, same-side-add and rate rules
 *     now      -> decides every time window
 *     frozen   -> the highest-priority rule of all
 *
 * So the unit of verification is this record, not the intent:
 *
 *     inputsHash  = hashOf(DecisionInput)                    -> content address
 *     verdictHash = hashOf({decision, code, trace})          -> what a replay must match
 *
 * A third party re-runs evaluateIntent on the archived input and must obtain
 * the identical verdictHash, rule-by-rule trace included. "Explainable" stops
 * being a claim about our UI and becomes a checked property.
 *
 * The record deliberately excludes the engine's \`snapshot\` blob from
 * verdictHash: the snapshot is derived from the inputs (already hashed) and is
 * full of floats, which must not leak into a digest.
 */

import { canonicalize, hashOf } from "@vetoos/audit";
import type { Intent } from "@vetoos/intent";
import type { AccountSnapshot, Decision, HistoryEvent, MarketSnapshot } from "./engine.js";
import type { Policy } from "./policy.js";
import { ENGINE_VERSION, RULESET_HASH } from "./ruleset.js";

export const DECISION_SCHEMA = "vetoos.decision/1";

/**
 * Provenance of the venue read that fed the decision. This is the honest
 * boundary of what we can prove: we archive WHICH endpoint was read, on which
 * network, at what time, and which marks were used — we do not claim to prove
 * the venue told the truth (see the oracle-trust limit in the design doc).
 */
export interface MarketSource {
  readNetwork: string;
  writeNetwork: string;
  /** Mark actually handed to the engine (the higher of read/write). */
  evalMarkPx: number;
  readMarkPx: number;
  writeMarkPx: number | null;
  readAt: number;
  market: string;
  dex: string | null;
  assetId: number;
}

export interface DecisionInput {
  schema: typeof DECISION_SCHEMA;
  intent: Intent;
  policy: Policy;
  /** sha256 of the policy file bytes — provenance of the file itself. */
  policyBytesHash: string;
  market: MarketSnapshot;
  account: AccountSnapshot;
  history: HistoryEvent[];
  frozen: boolean;
  freezeReason?: string;
  now: number;
  engineVersion: string;
  rulesetHash: string;
  marketSource?: MarketSource;
}

/** Every top-level key of a DecisionInput. Anything else is a bug or an attack. */
export const DECISION_INPUT_KEYS = [
  "schema",
  "intent",
  "policy",
  "policyBytesHash",
  "market",
  "account",
  "history",
  "frozen",
  "freezeReason",
  "now",
  "engineVersion",
  "rulesetHash",
  "marketSource",
] as const;

/** Names that would indicate model output leaking into the control path. */
const AI_CONTROL_PATTERN = /(^|_)(ai|advice|model|prompt|rationale|confidence|llm)(_|$)/i;

export interface BuildDecisionInputArgs {
  intent: Intent;
  policy: Policy;
  policyBytesHash: string;
  market: MarketSnapshot;
  account: AccountSnapshot;
  history: HistoryEvent[];
  frozen: boolean;
  freezeReason?: string;
  now: number;
  marketSource?: MarketSource;
}

export function buildDecisionInput(args: BuildDecisionInputArgs): DecisionInput {
  const input: DecisionInput = {
    schema: DECISION_SCHEMA,
    intent: args.intent,
    policy: args.policy,
    policyBytesHash: args.policyBytesHash,
    market: args.market,
    account: args.account,
    history: args.history,
    frozen: args.frozen,
    ...(args.freezeReason !== undefined ? { freezeReason: args.freezeReason } : {}),
    now: args.now,
    engineVersion: ENGINE_VERSION,
    rulesetHash: RULESET_HASH,
    ...(args.marketSource !== undefined ? { marketSource: args.marketSource } : {}),
  };
  assertNoAiControlFields(input);
  return input;
}

/**
 * Structural guarantee: model output is DATA, never CONTROL. The intent is the
 * proposal (it may legitimately carry model-authored text); everything else in
 * the record is market/account/history/time and must contain no AI-sourced key.
 * This makes "the model has no vote" a property of the record, not a promise.
 */
export function assertNoAiControlFields(input: DecisionInput): void {
  for (const key of Object.keys(input)) {
    if (!(DECISION_INPUT_KEYS as readonly string[]).includes(key)) {
      throw new Error("DecisionInput: unexpected key '" + key + "' — the record must be fully specified");
    }
    if (key === "intent") continue; // the proposal itself, by definition model-authorable
    scanForAiFields((input as unknown as Record<string, unknown>)[key], key);
  }
}

function scanForAiFields(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) scanForAiFields(value[i], path + "[" + i + "]");
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (AI_CONTROL_PATTERN.test(key)) {
      throw new Error(
        "DecisionInput: AI-sourced field '" + path + "." + key + "' found in the control path — " +
          "model output must never influence a verdict",
      );
    }
    scanForAiFields(nested, path + "." + key);
  }
}

/** Content address of the full input — the name of its archive file. */
export function decisionInputHash(input: DecisionInput): string {
  return hashOf(input);
}

/** Canonical bytes for the archive: identical input ⇒ identical file content. */
export function canonicalDecisionInput(input: DecisionInput): string {
  return canonicalize(input);
}

/** What a replay must reproduce: the verdict and its rule-by-rule trace. */
export function verdictHashOf(decision: Decision): string {
  return hashOf({ decision: decision.decision, code: decision.code, trace: decision.trace });
}

/** Rebuild the engine context from an archived input (used by verification). */
export function contextFromDecisionInput(input: DecisionInput): {
  now: number;
  frozen: boolean;
  freezeReason?: string;
  market: MarketSnapshot;
  account: AccountSnapshot;
  history: HistoryEvent[];
} {
  return {
    now: input.now,
    frozen: input.frozen,
    ...(input.freezeReason !== undefined ? { freezeReason: input.freezeReason } : {}),
    market: input.market,
    account: input.account,
    history: input.history,
  };
}
