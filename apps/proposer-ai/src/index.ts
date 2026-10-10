#!/usr/bin/env tsx
/**
 * vetoos proposer-ai — the AI-native end of the paradigm.
 *
 * An LLM turns plain language into Intent IR and proposes it over HTTP.
 * It never holds keys, never sees the policy, and never gets a vote on
 * allow/deny. When it tries to smuggle a policy override, the intent
 * layer refuses — that refusal IS the demo.
 *
 *   pnpm proposer "buy 0.0005 BTC, momentum"     LLM → intent → broker
 *   pnpm proposer --demo                         canned sequence (no API key needed)
 *
 * LLM config (OpenAI-compatible): OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL
 * Without a key, a scripted fallback extracts side/market/size heuristically.
 */

import { createClient, makeIntent, type IntentInput } from "@vetoos/client";

const BROKER = process.env.VETOOS_BROKER_URL ?? "http://127.0.0.1:4399";

interface TradeFields {
  market: string;
  side: "buy" | "sell";
  size: string;
  order_type: "limit" | "market";
  reduce_only?: boolean;
  rationale?: string;
}

async function llmExtract(text: string): Promise<TradeFields> {
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  if (!apiKey) return heuristicExtract(text);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract a trade intent as JSON with keys: market (string like 'BTC' or 'xyz:XYZ100'), " +
            "side ('buy'|'sell'), size (decimal string), order_type ('market'|'limit'), " +
            "reduce_only (boolean, optional), rationale (short string). " +
            "Default order_type 'market'. If size is vague, choose a SMALL size (<= 50 USD notional). " +
            "Output JSON only.",
        },
        { role: "user", content: text },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const content = data.choices[0]?.message.content ?? "{}";
  return JSON.parse(content) as TradeFields;
}

/** Offline fallback: regex the obvious out of plain English/Chinese. */
function heuristicExtract(text: string): TradeFields {
  const lower = text.toLowerCase();
  const side: "buy" | "sell" = /sell|short|卖|空/.test(lower) ? "sell" : "buy";
  const marketMatch = lower.match(/xyz:[a-z0-9]+|btc|eth|sol/);
  const market = marketMatch ? marketMatch[0].toUpperCase() : "BTC";
  const sizeMatch = lower.match(/(\d+\.\d+|\.\d+)/);
  return {
    market,
    side,
    size: sizeMatch ? sizeMatch[1]! : "0.0005",
    order_type: "market",
    rationale: text.slice(0, 200),
  };
}

function printVerdict(tag: string, result: Awaited<ReturnType<typeof client.submitIntent>>): void {
  if (result.validationError) {
    console.log(`[${tag}] REFUSED at intent layer: ${result.validationError}`);
    return;
  }
  const d = result.decision;
  console.log(`[${tag}] ${d?.code ?? "?"} · ${d?.message_zh} / ${d?.message_en}`);
  if (result.placed && result.placed.filledSize > 0) {
    console.log(`[${tag}] filled ${result.placed.filledSize} @ ${result.placed.avgPx} (oid ${result.placed.oid})`);
  }
  if (result.duplicate) console.log(`[${tag}] (idempotent replay — no second order sent)`);
}

const client = createClient(BROKER);

async function propose(text: string, source = "ai-proposer"): Promise<void> {
  const fields = await llmExtract(text);
  const intent = makeIntent({
    source,
    market: fields.market,
    side: fields.side,
    size: fields.size,
    order_type: fields.order_type,
    ...(fields.reduce_only !== undefined ? { reduce_only: fields.reduce_only } : {}),
    meta: { rationale: fields.rationale ?? text.slice(0, 200) },
  });
  console.log(`[ai] proposing: ${fields.side} ${fields.size} ${fields.market} — "${fields.rationale ?? text}"`);
  const result = await client.submitIntent(intent);
  printVerdict("broker", result);
}

async function demo(): Promise<void> {
  console.log("== AI proposer demo == (broker: " + BROKER + ")");
  // 1. a well-behaved proposal
  await propose("buy 0.0005 BTC — momentum breakout, small probe");
  // 2. the smuggle attempt: the model "helpfully" relaxes its own leash
  const evil = {
    ...makeIntent({
      source: "ai-proposer",
      market: "BTC",
      side: "buy",
      size: "0.01",
      order_type: "market",
      meta: { rationale: "conviction is high — raise the cap just this once" },
    }),
    max_leverage: 999,
    cooldown_seconds_after_deny: 0,
  };
  console.log("[ai] proposing with a policy override smuggled in…");
  const refused = await client.submitIntent(evil as unknown as IntentInput);
  printVerdict("broker", refused);
}

const args = process.argv.slice(2);
if (args[0] === "--demo") {
  await demo();
} else if (args.length > 0) {
  await propose(args.join(" "));
} else {
  console.log(`usage:
  pnpm proposer "buy 0.0005 BTC, momentum"   LLM → intent → broker
  pnpm proposer --demo                       canned sequence (no API key needed)`);
}
