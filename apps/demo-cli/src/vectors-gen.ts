#!/usr/bin/env tsx
/**
 * \`pnpm vectors:gen\` — regenerate the golden conformance vectors.
 *
 * A vector is (DecisionInput, expected verdictHash). The point is that a THIRD
 * PARTY can implement the gate in any language and check itself against us —
 * "open source" becomes "independently reproducible" rather than "you can read
 * our code". Regenerate only after an intentional rule change (the vectors
 * test failing is the signal that a rule moved).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateIntent } from "@vetoos/intent";
import {
  buildDecisionInput,
  canonicalDecisionInput,
  contextFromDecisionInput,
  evaluateIntent,
  loadPolicy,
  verdictHashOf,
  type AccountSnapshot,
  type BuildDecisionInputArgs,
  type HistoryEvent,
  type MarketSnapshot,
} from "@vetoos/risk";
import { repoRoot } from "@vetoos/demo-cli/config";

const policy = loadPolicy(join(repoRoot(), "configs/policy.demo.json"));
const MARKET = policy.policy.default_market;
const NOW = 1_700_000_000_000;

function market(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return { market: MARKET, markPx: 31000, funding: 0.00000625, openInterest: 7500, depthWithinBand: 5, szDecimals: 3, ...over };
}
function account(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return { equityUsd: 1000, availableMarginUsd: 1000, dailyRealizedPnlUsd: 0, currentPositionNotionalUsd: 0, currentPositionSize: 0, ...over };
}
function intent(over: Record<string, unknown> = {}) {
  const parsed = validateIntent({
    version: "0.1",
    id: randomUUID(),
    ts: new Date(NOW).toISOString(),
    source: "strategy-a",
    market: MARKET,
    side: "buy",
    size: "0.001",
    order_type: "market",
    ...over,
  });
  if (!parsed.ok) throw new Error("vector intent invalid: " + parsed.error);
  return parsed.intent;
}
function fills(count: number, minutesAgo: number, side: "buy" | "sell" = "buy"): HistoryEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: NOW - (i + 1) * minutesAgo * 60_000,
    market: MARKET,
    side,
    kind: "fill" as const,
  }));
}

interface Scenario {
  name: string;
  args: Partial<BuildDecisionInputArgs> & { intent: BuildDecisionInputArgs["intent"] };
}

const scenarios: Scenario[] = [
  { name: "allow: small order inside every limit", args: { intent: intent() } },
  { name: "allow: reduce-only exits are exempt from the FOMO guards", args: { intent: intent({ side: "sell", size: "0.001", reduce_only: true }), account: account({ currentPositionSize: 0.002, currentPositionNotionalUsd: 62 }), history: fills(5, 1) } },
  { name: "deny: notional above the single-order cap", args: { intent: intent({ size: "1" }) } },
  { name: "deny: leverage above the cap", args: { intent: intent({ size: "0.02" }), account: account({ equityUsd: 100 }) } },
  { name: "deny: daily-loss circuit breaker already tripped", args: { intent: intent(), account: account({ dailyRealizedPnlUsd: -250 }) } },
  { name: "deny: same-side add count in the last hour", args: { intent: intent(), history: fills(3, 5) } },
  { name: "deny: frozen broker outranks everything else", args: { intent: intent(), frozen: true, freezeReason: "reconcile mismatch" } },
  { name: "deny: no market data fails closed", args: { intent: intent(), market: market({ markPx: 0 }) } },
  { name: "deny: book too thin for the size", args: { intent: intent({ size: "0.01" }), market: market({ depthWithinBand: 0.0001 }) } },
  { name: "deny: market not on the allow-list", args: { intent: intent({ market: "NOTLISTED" }) } },
  { name: "deny: post-deny cool-down still active", args: { intent: intent(), history: [{ ts: NOW - 5_000, market: MARKET, side: "buy", kind: "deny" }] } },
  { name: "deny: limit price too far from the oracle mark", args: { intent: intent({ order_type: "limit", limit_px: "20000" }) } },
];

const vectors = scenarios.map((scenario) => {
  const input = buildDecisionInput({
    intent: scenario.args.intent,
    policy: policy.policy,
    policyBytesHash: policy.contentHash,
    market: scenario.args.market ?? market(),
    account: scenario.args.account ?? account(),
    history: scenario.args.history ?? [],
    frozen: scenario.args.frozen ?? false,
    ...(scenario.args.freezeReason !== undefined ? { freezeReason: scenario.args.freezeReason } : {}),
    now: NOW,
  });
  const decision = evaluateIntent(input.intent, input.policy, contextFromDecisionInput(input));
  return {
    name: scenario.name,
    expected: { decision: decision.decision, code: decision.code },
    verdictHash: verdictHashOf(decision),
    input: JSON.parse(canonicalDecisionInput(input)) as unknown,
  };
});

const out = {
  schema: "vetoos.vectors/1",
  policyBytesHash: policy.contentHash,
  note: "Golden conformance vectors: re-run evaluateIntent on each input and you must obtain verdictHash.",
  vectors,
};
const dir = join(repoRoot(), "packages/risk/vectors");
mkdirSync(dir, { recursive: true });
const file = join(dir, "decisions.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("[vectors] wrote " + vectors.length + " vectors to " + file);
for (const v of vectors) console.log("  " + v.expected.decision.padEnd(5) + " " + v.expected.code.padEnd(26) + " " + v.name);
