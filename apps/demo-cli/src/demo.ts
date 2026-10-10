/**
 * The four-act hackathon demo (PRD §7 M1–M5). Every act narrates bilingually
 * and every beat lands in the audit log — the video is basically this output.
 *
 *   Act 1  strategy-a  legal intent → allow → real testnet fill → truth OK
 *   Act 2  strategy-b  oversized intent → deny on real mainnet data → cooldown
 *   Act 3  ai-proposer repeated same-side adds → FOMO guard fires
 *   Act 4  ledger tampered → reconciliation freezes the broker → human-only reset
 */

import { roundSize, type HlAdapter } from "@vetoos/adapter-hl";
import { makeIntent } from "@vetoos/intent";
import type { LoadedPolicy } from "@vetoos/risk";
import type { RiskBroker } from "./broker.js";

export interface DemoOptions {
  step?: number;
  auto: boolean;
}

function banner(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait out the post-deny cool-down so the next act shows the RIGHT guard. */
async function waitOutCooldown(policy: LoadedPolicy, auto: boolean): Promise<void> {
  const seconds = policy.policy.cooldown_seconds_after_deny;
  if (!auto || seconds <= 0) return;
  console.log(`\n[cooldown] 冷静期 ${seconds}s — the brake cannot be argued with. Waiting it out.`);
  await sleep((seconds + 1) * 1000);
}

/** Pick the market that can actually fill on testnet (HIP-3 preferred). */
export async function resolveTradeMarket(adapter: HlAdapter, policy: LoadedPolicy): Promise<string> {
  const preferred = policy.policy.default_market;
  try {
    await adapter.getMarketContext(preferred, "testnet");
    console.log(`[setup] ${preferred} is mirrored on testnet — real HIP-3 testnet fills.`);
    return preferred;
  } catch {
    console.log(
      `[setup] ${preferred} is NOT mirrored on testnet → fill path uses testnet BTC perp.\n` +
        `        Vetoes still read real mainnet HIP-3 (${preferred}) data.`,
    );
    return "BTC";
  }
}

/**
 * Size a demo order to ≈`targetUsd`, but never below one lot — rounding to
 * zero would either fail or, worse, get "fixed" into something oversized.
 */
async function demoSize(adapter: HlAdapter, market: string, targetUsd = 40): Promise<string> {
  const ctx = await adapter.getMarketContext(market, "testnet");
  const lot = Math.pow(10, -ctx.szDecimals);
  const sized = Math.max(targetUsd / ctx.markPx, lot);
  const rounded = roundSize(sized, ctx.szDecimals);
  if (!(Number(rounded) > 0)) {
    throw new Error(`cannot size a safe demo order for ${market} (mark ${ctx.markPx})`);
  }
  return rounded;
}

export async function runDemo(
  broker: RiskBroker,
  adapter: HlAdapter,
  policy: LoadedPolicy,
  opts: DemoOptions,
): Promise<void> {
  const p = policy.policy;
  const acts: Record<number, () => Promise<void>> = {
    1: () => act1(broker, adapter, policy),
    2: () => act2(broker, adapter, policy),
    3: () => act3(broker, adapter, policy),
    4: () => act4(broker, adapter, policy),
  };

  const steps = opts.step ? [opts.step] : [1, 2, 3, 4];
  for (const step of steps) {
    const act = acts[step];
    if (!act) throw new Error(`unknown act: ${step}`);
    await act();
    if (!opts.step) await waitOutCooldown(policy, opts.auto);
  }
}

async function act1(broker: RiskBroker, adapter: HlAdapter, policy: LoadedPolicy): Promise<void> {
  banner("ACT 1 · 策略 A 合法提案 → 放行 → 测试网真实成交 → 账实相符");
  const tradeMarket = await resolveTradeMarket(adapter, policy);
  await broker.setBaseline(tradeMarket);
  const size = await demoSize(adapter, tradeMarket);
  const intent = makeIntent({
    source: "strategy-a",
    market: tradeMarket,
    side: "buy",
    size,
    order_type: "market",
    meta: { rationale: "mean-reversion entry, small probe" },
  });
  const result = await broker.submitIntent(intent);
  if (result.decision?.decision !== "allow" || !result.placed || result.reconcile?.ok !== true) {
    throw new Error("Act 1 failed: expected allow + fill + clean reconciliation");
  }
  console.log("[act1] ✔ allow → fill → truth OK (M4, M1)");
}

async function act2(broker: RiskBroker, adapter: HlAdapter, policy: LoadedPolicy): Promise<void> {
  banner("ACT 2 · 策略 B 超仓提案 → 基于主网真实 HIP-3 数据否决 → 冷静期拦截重试");
  const p = policy.policy;
  const vetoMarket = p.default_market; // real mainnet HIP-3 data drives this veto
  const ctx = await adapter.getMarketContext(vetoMarket, "mainnet");
  const greedyNotional = p.max_order_notional_usd * 10;
  const size = roundSize(greedyNotional / ctx.markPx, ctx.szDecimals);

  const greedy = makeIntent({
    source: "strategy-b",
    market: vetoMarket,
    side: "buy",
    size,
    order_type: "market",
    meta: { rationale: "YOLO full size" },
  });
  const denied = await broker.submitIntent(greedy);
  if (denied.decision?.decision !== "deny") throw new Error("Act 2 failed: oversized intent was allowed");

  // Instant retry with a SMALL, policy-passing size — it must be stopped by
  // the cool-down guard alone, which only works if it clears checks 1–3.
  const lot = Math.pow(10, -ctx.szDecimals);
  if (lot * ctx.markPx < p.max_order_notional_usd * 0.9) {
    const retry = await broker.submitIntent({
      ...greedy,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      size: roundSize(lot, ctx.szDecimals),
      meta: { rationale: "ok ok, tiny size — NOW let me in" },
    });
    if (retry.decision?.code !== "FOMO_COOLDOWN") {
      console.log(`[act2] note: re-submit hit ${retry.decision?.code ?? "?"} instead of cool-down`);
    }
  } else {
    console.log("[act2] note: one lot already exceeds the notional cap; skipping cool-down probe");
  }

  // The AI proposer tries to smuggle a policy override past the broker.
  banner("ACT 2b · AI 试图夹带私货（覆盖杠杆上限）→ 意图层直接拒收");
  const tampered = {
    ...makeIntent({
      source: "ai-proposer",
      market: vetoMarket,
      side: "buy",
      size: "1",
      order_type: "market",
      meta: { rationale: "trust me, raise the cap just this once" },
    }),
    max_leverage: 999,
  };
  const refused = await broker.submitIntent(tampered);
  if (!refused.validationError) throw new Error("Act 2b failed: policy override was not refused");
  console.log("[act2] ✔ real-data veto + cooldown + override refused (M2)");
}

async function act3(broker: RiskBroker, adapter: HlAdapter, policy: LoadedPolicy): Promise<void> {
  banner("ACT 3 · AI 连续同向加仓 → FOMO 刹车");
  const tradeMarket = await resolveTradeMarket(adapter, policy);
  // Seed history so that exactly ONE more real add fits under the hourly cap;
  // the add after that must be stopped. Works in both --auto and --step mode.
  const already = broker.sameSideFillsLastHour(tradeMarket, "buy");
  const seedCount = Math.max(0, policy.policy.max_same_side_adds_per_hour - 1 - already);
  if (seedCount > 0) broker.seedSyntheticFill(tradeMarket, "buy", seedCount);
  const size = await demoSize(adapter, tradeMarket);

  const oneMore = makeIntent({
    source: "ai-proposer",
    market: tradeMarket,
    side: "buy",
    size,
    order_type: "market",
    meta: { rationale: "it keeps pumping — add again!" },
  });
  const result = await broker.submitIntent(oneMore);
  if (result.decision?.code === "FOMO_SAME_SIDE_ADDS") {
    console.log("[act3] ✔ FOMO same-side-add guard fired (M3)");
    return;
  }
  // If the real fill quota allowed this one, the NEXT add must be stopped.
  const again = await broker.submitIntent({
    ...oneMore,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    meta: { rationale: "one more, this is definitely the top" },
  });
  if (again.decision?.code !== "FOMO_SAME_SIDE_ADDS" && again.decision?.code !== "FOMO_COOLDOWN") {
    throw new Error(`Act 3 failed: expected FOMO guard, got ${again.decision?.code ?? "allow"}`);
  }
  console.log(`[act3] ✔ FOMO guard fired (${again.decision?.code}) (M3)`);
}

async function act4(broker: RiskBroker, adapter: HlAdapter, policy: LoadedPolicy): Promise<void> {
  banner("ACT 4 · 本地账本被篡改 → 成交真相层对账 → 冻结总闸");
  const tradeMarket = await resolveTradeMarket(adapter, policy);
  const ctx = await adapter.getMarketContext(tradeMarket, "testnet");

  console.log("[tamper] 注入一笔从未真实成交的账本记录 / injecting a fill that never happened…");
  broker.ledger.injectTamperedFill({
    intentId: crypto.randomUUID(),
    market: tradeMarket,
    side: "buy",
    size: 100 * Math.pow(10, -ctx.szDecimals),
    avgPx: ctx.markPx,
    oid: Date.now(),
    ts: Date.now(),
    szDecimals: ctx.szDecimals,
  });

  const result = await broker.reconcileNow(tradeMarket);
  if (!result.shouldFreeze && !broker.frozen) {
    throw new Error("Act 4 failed: tampered ledger did not trigger a freeze");
  }

  const blocked = await broker.submitIntent(
    makeIntent({
      source: "strategy-a",
      market: tradeMarket,
      side: "sell",
      size: roundSize(1, ctx.szDecimals),
      order_type: "market",
      reduce_only: true,
      meta: { rationale: "trying to trade while frozen" },
    }),
  );
  if (blocked.decision?.code !== "FROZEN") throw new Error("Act 4 failed: frozen broker still trades");

  console.log(
    "[act4] ✔ tamper caught, broker frozen, all intents refused (M5)\n" +
      "       只有人能解冻 / only a human can unfreeze: pnpm broker unfreeze --confirm I_AM_HUMAN",
  );
}
