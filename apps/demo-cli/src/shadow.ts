/**
 * \`pnpm shadow <address>\` — the onboarding wedge (docs/PRODUCT_ROADMAP.md F1).
 *
 * Paste a public Hyperliquid address; get back what the gate would have done to
 * that account's real trading. No keys, no custody, no integration, nothing to
 * install on the user's side.
 *
 * Three rules this file refuses to break:
 *   1. Every number says what it is. Reconstructed equity is labelled,
 *      attributed PnL is labelled, and the depth rule is declared unevaluated
 *      rather than guessed.
 *   2. The rulebook is printed at the top. A block rate is meaningless without
 *      knowing which rules produced it.
 *   3. The account is described before it is judged. "99.6% refused" is a fact
 *      about the rulebook, not about the trader.
 *
 * \`buildShadowReport\` and \`renderShadowReport\` are the whole product surface:
 * the CLI and the hosted read-only service call exactly the same code, so a
 * report proves nothing different depending on where it was produced.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PublicReader } from "@vetoos/adapter-hl/public-reads";
import { hashOf } from "@vetoos/audit";
import { blockedByRule, shadowReplay, type MarketMeta, type ShadowReport } from "@vetoos/replay";
import { policySchema, type Policy } from "@vetoos/risk";
import { repoRoot } from "./config.js";

/** Default rulebook for a shadow run: the shipped conservative template. */
export const SHADOW_POLICY_FILE = "configs/templates/conservative.json";

/**
 * Cap and daily-loss limit are scaled to the account, because a fixed $1,000
 * order cap applied to a $300k account refuses 100% of its orders and tells the
 * user nothing. The percentages are printed with the result.
 */
export const SCALE_ORDER_PCT = 0.10;
export const SCALE_DAILY_LOSS_PCT = 0.05;

export function loadShadowPolicy(path?: string): Policy {
  const file = path ?? join(repoRoot(), SHADOW_POLICY_FILE);
  const parsed = policySchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error("invalid shadow policy at " + file + ": " + (parsed.error.issues[0]?.message ?? "unknown"));
  }
  return parsed.data;
}

export function scalePolicyToAccount(base: Policy, equityUsd: number): { policy: Policy; scaled: boolean } {
  if (!(equityUsd > 0)) return { policy: base, scaled: false };
  const orderCap = Math.max(base.max_order_notional_usd, Math.round(equityUsd * SCALE_ORDER_PCT));
  const dailyLoss = Math.max(base.max_daily_loss_usd, Math.round(equityUsd * SCALE_DAILY_LOSS_PCT));
  const changed = orderCap !== base.max_order_notional_usd || dailyLoss !== base.max_daily_loss_usd;
  return { policy: { ...base, max_order_notional_usd: orderCap, max_daily_loss_usd: dailyLoss }, scaled: changed };
}

export interface ShadowRun {
  report: ShadowReport;
  policy: Policy;
  scaled: boolean;
  /** How many venue calls produced this report (provenance, for the reader). */
  venueCalls: number;
}

/**
 * The whole pipeline: read, reconstruct, replay. No keys are involved at any
 * point, which is what makes it safe to run on a public host.
 */
export async function buildShadowReport(
  address: string,
  opts: { policyPath?: string; reader?: PublicReader } = {},
): Promise<ShadowRun> {
  const reader = opts.reader ?? new PublicReader("mainnet");
  const base = loadShadowPolicy(opts.policyPath);

  const errors: string[] = [];
  const note = (what: string) => (err: unknown) => {
    errors.push(what + ": " + String(err instanceof Error ? err.message : err));
  };

  const equity = await reader.getAccountValue(address).catch((err) => {
    note("account value")(err);
    return 0;
  });
  const { policy, scaled } = scalePolicyToAccount(base, equity);

  const [fills, meta] = await Promise.all([
    reader.getUserFills(address),
    reader.getMeta().catch((err) => {
      note("market meta")(err);
      return {} as Record<string, MarketMeta>;
    }),
  ]);
  if (fills.length === 0) {
    throw new Error(
      "no fills for " + address + " — the address has never traded perps on Hyperliquid, or it is not an account address",
    );
  }

  const since = fills[0]!.time - 86_400_000;
  const [funding, ledger] = await Promise.all([
    reader.getUserFunding(address, since).catch((err) => {
      note("funding history")(err);
      return [];
    }),
    reader.getUserLedger(address, since).catch((err) => {
      note("ledger history")(err);
      return [];
    }),
  ]);

  const report = shadowReplay({
    user: address,
    policy,
    policySemanticHash: hashOf(policy),
    now: Date.now(),
    currentEquityUsd: equity,
    fills,
    funding,
    ledger,
    markets: meta,
  });
  // A gap in the inputs is a caveat on the report, never a silent assumption.
  for (const e of errors) report.caveats.push("Input unavailable — " + e);

  return { report, policy, scaled, venueCalls: reader.provenance.length };
}

const usd = (n: number): string =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

const signed = (n: number): string =>
  (n < 0 ? "-$" : "+$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

export function renderShadowReport(run: ShadowRun): string {
  const { report, policy, scaled, venueCalls } = run;
  const out: string[] = [];
  const from = new Date(report.windowFrom).toISOString().slice(0, 16).replace("T", " ");
  const to = new Date(report.windowTo).toISOString().slice(0, 16).replace("T", " ");
  out.push("");
  out.push("VetoOS shadow report — " + report.user);
  out.push(
    "  read from api.hyperliquid.xyz · " +
      venueCalls +
      " calls · " +
      report.fillsConsidered +
      " fills · " +
      from +
      " → " +
      to +
      " UTC",
  );
  out.push(
    "  rulebook: conservative" +
      (scaled ? " (order cap and daily loss scaled to your account)" : "") +
      "\n    order cap " +
      usd(policy.max_order_notional_usd) +
      " · daily loss " +
      usd(policy.max_daily_loss_usd) +
      " · max leverage " +
      policy.max_leverage +
      "x · " +
      policy.max_same_side_adds_per_hour +
      " same-side adds/h · " +
      policy.cooldown_seconds_after_deny +
      "s cool-down · " +
      policy.max_orders_per_minute +
      " orders/min",
  );

  const p = report.profile;
  out.push("");
  out.push("YOUR TRADING PROFILE");
  out.push(
    "  " +
      report.fillsConsidered +
      " fills over " +
      (p.spanMinutes >= 1440 ? (p.spanMinutes / 1440).toFixed(1) + " days" : p.spanMinutes.toFixed(0) + " minutes") +
      " · " +
      p.distinctMarkets +
      " markets · " +
      (p.reduceOnlyShare * 100).toFixed(0) +
      "% position-reducing",
  );
  out.push(
    "  order rate p50 " +
      p.ordersPerMinuteP50.toFixed(1) +
      "/min, p95 " +
      p.ordersPerMinuteP95.toFixed(1) +
      "/min · order size median " +
      usd(p.medianOrderNotionalUsd) +
      ", p95 " +
      usd(p.p95OrderNotionalUsd),
  );
  if (p.bindingConstraints.length > 0) {
    out.push("  where this rulebook and your style disagree:");
    for (const c of p.bindingConstraints) out.push("    - " + c);
  }

  const s = report.summary;
  out.push("");
  out.push("RESULT");
  out.push(
    "  " + s.totalOrders + " orders replayed · " + s.blocked + " would have been refused (" + (s.blockRate * 100).toFixed(1) + "%)",
  );
  out.push("  refused notional: " + usd(s.blockedNotionalUsd));
  out.push(
    "  attributed PnL of refused orders: " +
      signed(s.blockedAttributedPnlUsd) +
      (s.blockedAttributedPnlUsd < 0
        ? "  (the gate would have kept this much)"
        : "  (the gate would have cost you this much)"),
  );

  const byRule = blockedByRule(report);
  if (byRule.length > 0) {
    out.push("");
    out.push("BY RULE");
    for (const row of byRule) {
      out.push(
        "  " + row.code.padEnd(26) + String(row.count).padStart(5) + "  " + usd(row.notionalUsd).padStart(14) + "  " + signed(row.attributedPnlUsd).padStart(12),
      );
    }
  }

  if (report.blocked.length > 0) {
    out.push("");
    out.push("EXAMPLES (first 5)");
    for (const e of report.blocked.slice(0, 5)) {
      const when = new Date(e.ts).toISOString().slice(0, 16).replace("T", " ");
      out.push(
        "  " +
          when +
          "  " +
          e.coin.padEnd(12) +
          e.side.padEnd(5) +
          String(e.size) +
          " @ " +
          e.px +
          "  → " +
          e.code +
          (e.attributedPnlUsd !== undefined ? "  (attributed " + signed(e.attributedPnlUsd) + ")" : ""),
      );
    }
  }

  out.push("");
  out.push("WHAT THIS REPORT DOES NOT KNOW");
  for (const c of report.caveats) out.push("  - " + c);
  out.push("");
  out.push("  policy hash " + report.policySemanticHash.slice(0, 16) + "…  ·  replay is deterministic: same fills, same verdicts");
  out.push("");
  return out.join("\n");
}

export async function shadowCommand(argv: string[]): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const address = argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  if (!address) {
    console.error("usage: pnpm shadow <0x address> [--policy configs/templates/conservative.json] [--json] [--out FILE]");
    return 1;
  }

  let run: ShadowRun;
  try {
    run = await buildShadowReport(address, {
      ...(arg("--policy") ? { policyPath: arg("--policy")! } : {}),
    });
  } catch (err) {
    console.error("[shadow] " + String(err instanceof Error ? err.message : err));
    return 1;
  }

  const out = arg("--out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(run.report, null, 2) + "\n", "utf8");
    console.log("[shadow] full report written to " + out);
  }

  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(run.report, null, 2) + "\n");
  } else {
    process.stdout.write(renderShadowReport(run));
  }
  return 0;
}
