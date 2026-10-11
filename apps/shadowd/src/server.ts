#!/usr/bin/env tsx
/**
 * vetoos shadowd — the public, read-only face of the shadow report.
 *
 * WHY this process is separate from brokerd: brokerd signs orders and therefore
 * holds a hot key. This service exists so a stranger can get a real report
 * without anyone having to trust a hosted key. It imports the same
 * buildShadowReport the CLI imports and nothing from the signing side of the
 * repo, so the CLI and the hosted page can never disagree about a report, and
 * this process can never place an order.
 *
 * Boundaries that are enforced here rather than promised in a README:
 *   - GET only; every other method is 405 and every other path is 404.
 *   - The address must match /^0x[0-9a-fA-F]{40}$/ before any upstream call.
 *   - Five builds per IP per ten minutes, two builds in flight, a bounded queue.
 *   - A successful report is cached in memory for two minutes; nothing is ever
 *     written to disk and the process holds no key material (see scrubKeyEnv).
 *
 * Env:
 *   PORT                      listen port (default 4477)
 *   HOST                      bind address (default 127.0.0.1; containers set 0.0.0.0)
 *   VETOOS_TRUST_PROXY=1      trust the first x-forwarded-for hop for rate limiting
 *   VETOOS_SHADOW_TIMEOUT_MS  upstream budget per build (default 25000)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildShadowReport, type ShadowRun } from "@vetoos/demo-cli/shadow";
import { blockedByRule, type ShadowReport } from "@vetoos/replay";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_SWEEP_AT = 4096;
const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 256;
const MAX_CONCURRENT_BUILDS = 2;
const MAX_QUEUED_BUILDS = 16;
const QUEUE_FULL_RETRY_SECONDS = 5;

/**
 * demo-cli's config module calls dotenv at import time because the CLI wants a
 * .env, and the import above drags that module in. We cannot stop the read from
 * here, so we do the next best thing: once the import graph has settled, every
 * key-shaped variable is removed from this process's environment. A public
 * service should be unable to hold a key, not merely promise not to use one.
 */
const SECRET_ENV_RE = /(PRIVATE_KEY|SECRET|MNEMONIC|SEED|PASSPHRASE|RECEIPT_KEY|_KEY$)/i;

function scrubKeyEnv(): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(process.env)) {
    if (SECRET_ENV_RE.test(name)) {
      delete process.env[name];
      removed.push(name);
    }
  }
  return removed;
}

const scrubbedEnv = scrubKeyEnv();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(name + " must be a positive integer, got " + raw);
  }
  return parsed;
}

const PORT = envInt("PORT", 4477);
const HOST = process.env.HOST ?? "127.0.0.1";
const TRUST_PROXY = process.env.VETOOS_TRUST_PROXY === "1";
const BUILD_TIMEOUT_MS = envInt("VETOOS_SHADOW_TIMEOUT_MS", 25_000);

/** An error carrying the HTTP status the caller should see. */
class BuildError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | undefined;

  constructor(status: number, message: string, retryAfterSec?: number) {
    super(message);
    this.name = "BuildError";
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/* ------------------------------------------------------------------------- *
 * Rate limiting — five builds per IP per ten minutes, in memory only.
 * ------------------------------------------------------------------------- */

const rateHits = new Map<string, number[]>();

function sweepRateLimits(now: number): void {
  for (const [ip, stamps] of rateHits) {
    const live = stamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (live.length === 0) rateHits.delete(ip);
    else rateHits.set(ip, live);
  }
}

/** Take one token for this IP, or report how long the caller should wait. */
function takeToken(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const stamps = (rateHits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (stamps.length >= RATE_LIMIT_MAX) {
    rateHits.set(ip, stamps);
    const oldest = stamps[0] ?? now;
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  stamps.push(now);
  rateHits.set(ip, stamps);
  if (rateHits.size > RATE_LIMIT_SWEEP_AT) sweepRateLimits(now);
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * X-Forwarded-For is user-controlled, so it is only believed when the operator
 * says a proxy is in front of this process; otherwise a caller could mint a new
 * identity per request and the limit would mean nothing.
 */
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header[0] : header;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/* ------------------------------------------------------------------------- *
 * Cache — refresh-spam must not become upstream load.
 * ------------------------------------------------------------------------- */

const cache = new Map<string, { run: ShadowRun; expiresAt: number }>();

function cacheGet(key: string): ShadowRun | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Re-insert so the oldest key is genuinely the least recently used.
  cache.delete(key);
  cache.set(key, entry);
  return entry.run;
}

function cacheSet(key: string, run: ShadowRun): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { run, expiresAt: Date.now() + CACHE_TTL_MS });
}

/* ------------------------------------------------------------------------- *
 * Concurrency gate — a public page must not open fifty venue reads at once.
 * ------------------------------------------------------------------------- */

class BuildGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.active < MAX_CONCURRENT_BUILDS) {
      this.active++;
      return () => this.release();
    }
    if (this.waiting.length >= MAX_QUEUED_BUILDS) {
      throw new BuildError(
        503,
        "The service is at capacity (" +
          MAX_CONCURRENT_BUILDS +
          " builds in flight, " +
          MAX_QUEUED_BUILDS +
          " queued). Try again in a few seconds.",
        QUEUE_FULL_RETRY_SECONDS,
      );
    }
    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // Hand the slot to the next waiter instead of freeing it, otherwise a fresh
    // request could slip in between the release and the waiter waking up.
    if (next) next();
    else this.active--;
  }
}

const gate = new BuildGate();

/** Race a build against the upstream budget so a request cannot hang forever. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new BuildError(504, "The venue read did not finish within " + Math.round(ms / 1000) + "s.")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Map a build failure onto something a stranger can act on. */
function classify(err: unknown): BuildError {
  if (err instanceof BuildError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/no fills/i.test(message)) {
    return new BuildError(422, message);
  }
  return new BuildError(502, "The public Hyperliquid read failed: " + message.slice(0, 300));
}

/* ------------------------------------------------------------------------- *
 * Formatting helpers — every one of them returns a string safe to print.
 * ------------------------------------------------------------------------- */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Every value on a report page is derived from a public address or from the
 * venue's response, so it is echoed through this function and never trusted.
 */
const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);

const num = (n: number, digits = 0): string => n.toLocaleString("en-US", { maximumFractionDigits: digits });
const usd = (n: number): string => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const signed = (n: number): string =>
  (n < 0 ? "-$" : "+$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (x: number): string => (x * 100).toFixed(1) + "%";
const utc = (ts: number): string => new Date(ts).toISOString().replace("T", " ").slice(0, 16);
const spanText = (minutes: number): string =>
  minutes >= 1440 ? (minutes / 1440).toFixed(1) + " days" : minutes.toFixed(0) + " minutes";

/* ------------------------------------------------------------------------- *
 * HTML
 * ------------------------------------------------------------------------- */

const HTML_TYPE = "text/html; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";

/** No scripts exist on these pages, so the policy can be maximally strict. */
const HTML_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #171a20; --muted: #5c626e; --line: #dde1e8;
  --panel: #f6f7f9; --accent: #1d5fd0; --accent-fg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --fg: #e5e8ee; --muted: #98a1af; --line: #262c36;
    --panel: #161a21; --accent: #7aa7ff; --accent-fg: #0b0e12;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 56rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
h1 { font-size: 1.45rem; margin: 0 0 .5rem; letter-spacing: -.01em; }
h2 {
  font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .09em;
  color: var(--muted); margin: 2.25rem 0 .7rem;
}
p { margin: .65rem 0; }
a { color: var(--accent); }
code, .n { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
ul { margin: .5rem 0; padding-left: 1.15rem; }
li { margin: .3rem 0; }
form { margin: 1.5rem 0 2rem; }
label { display: block; font-size: .8rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-bottom: .4rem; }
.row { display: flex; gap: .6rem; flex-wrap: wrap; }
input[type=text] {
  flex: 1 1 22rem; min-width: 0; padding: .6rem .7rem; border: 1px solid var(--line);
  border-radius: 7px; background: var(--panel); color: inherit; font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
button {
  padding: .6rem 1.1rem; border: 1px solid transparent; border-radius: 7px; cursor: pointer;
  background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600;
}
.hint { color: var(--muted); font-size: .88rem; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .7rem; margin: 1.25rem 0 .5rem; }
.fact { border: 1px solid var(--line); border-radius: 9px; padding: .7rem .85rem; background: var(--panel); }
.fact dt { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.fact dd { margin: .3rem 0 0; font-size: 1.3rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.fact .sub { font-size: .8rem; color: var(--muted); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
td.n, th.n { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
tbody th { font-weight: 500; color: var(--muted); }
tr.total td, tr.total th { font-weight: 700; color: var(--fg); border-bottom: none; }
.addr { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
footer { margin-top: 2.5rem; border-top: 1px solid var(--line); padding-top: .9rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function homePage(): string {
  return page(
    "VetoOS shadow report",
    `<h1>VetoOS shadow report</h1>
<p>Paste a public Hyperliquid address. This service reads that account's public
fills and re-judges every one of them against the shipped VetoOS conservative
rulebook, so you can see which orders a risk gate would have allowed and which it
would have refused.</p>

<form method="get" action="/report">
  <label for="address">Hyperliquid address</label>
  <div class="row">
    <input id="address" name="address" type="text" required spellcheck="false" autocomplete="off"
           placeholder="0x0000000000000000000000000000000000000000"
           pattern="0x[0-9a-fA-F]{40}" aria-describedby="address-help">
    <button type="submit">Build report</button>
  </div>
  <p id="address-help" class="hint">40 hex characters, 0x-prefixed. This is a public account
  address, never a key. The address is only used to read public fills.</p>
</form>

<h2>What this service is not</h2>
<ul>
  <li>No private key is needed, and none is held. This service cannot place, modify or cancel
  orders: it has no wallet, no signer and no trading endpoint.</li>
  <li>It is read-only. The only outbound calls are public Hyperliquid info requests for the
  address you typed.</li>
  <li>The analysis is a counterfactual. It replays trades that already happened against a
  rulebook that was never in force for that account. It is not advice, not a prediction, and
  not a statement about what the account should have done.</li>
  <li>Nothing is stored. Reports are cached in memory for two minutes and are gone on restart;
  nothing is written to disk.</li>
</ul>

<h2>What it does under load</h2>
<ul>
  <li>Five report builds per IP per ten minutes, then HTTP 429 with the wait time.</li>
  <li>At most two builds run at once; further requests queue briefly rather than hammering
  Hyperliquid's public API.</li>
  <li>A successful report is reused for 120 seconds, so refreshing is free.</li>
</ul>

<footer class="hint">
  <p>Machine-readable: <a href="/api/shadow?address=0xf5d81a135f756ca16544e53c20fc20643ec3ad53">/api/shadow?address=0x...</a>
  returns the full report as JSON. Health: <a href="/healthz">/healthz</a>.</p>
  <p>The same engine backs <code>pnpm shadow &lt;address&gt;</code> in the VetoOS repository, so the
  CLI and this page cannot disagree about a report.</p>
</footer>`,
  );
}

function reportPage(run: ShadowRun, fromCache: boolean): string {
  const { report, policy, scaled, venueCalls } = run;
  const summary = report.summary;
  const profile = report.profile;
  const byRule = blockedByRule(report);
  const shown = report.blocked.slice(0, 10);
  const address = esc(report.user);

  const ruleRows =
    byRule.length === 0
      ? ""
      : byRule
          .map(
            (row) =>
              "<tr><th scope=\"row\">" +
              esc(row.code) +
              "</th><td class=\"n\">" +
              num(row.count) +
              "</td><td class=\"n\">" +
              usd(row.notionalUsd) +
              "</td><td class=\"n\">" +
              signed(row.attributedPnlUsd) +
              "</td></tr>",
          )
          .join("");

  const byRuleTable =
    byRule.length === 0
      ? "<p>No order in this window would have been refused by this rulebook.</p>"
      : `<div class="scroll"><table>
<thead><tr><th scope="col">rule</th><th scope="col" class="n">orders</th><th scope="col" class="n">notional</th><th scope="col" class="n">attributed PnL</th></tr></thead>
<tbody>
${ruleRows}
<tr class="total"><th scope="row">total</th><td class="n">${num(summary.blocked)}</td><td class="n">${usd(summary.blockedNotionalUsd)}</td><td class="n">${signed(summary.blockedAttributedPnlUsd)}</td></tr>
</tbody>
</table></div>`;

  const exampleRows = shown
    .map((e) => {
      const when = utc(e.ts);
      const attributed = e.attributedPnlUsd === undefined ? "—" : signed(e.attributedPnlUsd);
      return (
        "<tr><td class=\"n\">" +
        esc(when) +
        "</td><td>" +
        esc(e.coin) +
        "</td><td>" +
        esc(e.side) +
        "</td><td class=\"n\">" +
        num(e.size, 8) +
        "</td><td class=\"n\">" +
        num(e.px, 6) +
        "</td><td class=\"n\">" +
        usd(e.notionalUsd) +
        "</td><td><code>" +
        esc(e.code) +
        "</code></td><td>" +
        esc(e.message_en) +
        "</td><td class=\"n\">" +
        esc(attributed) +
        "</td></tr>"
      );
    })
    .join("");

  const examplesTable =
    shown.length === 0
      ? ""
      : `<h2>First ${num(shown.length)} refused orders</h2>
<div class="scroll"><table>
<thead><tr><th scope="col">time (UTC)</th><th scope="col">market</th><th scope="col">side</th><th scope="col" class="n">size</th><th scope="col" class="n">price</th><th scope="col" class="n">notional</th><th scope="col">rule</th><th scope="col">why</th><th scope="col" class="n">attributed PnL</th></tr></thead>
<tbody>
${exampleRows}
</tbody>
</table></div>
${report.blocked.length > shown.length ? `<p class="hint">Showing ${num(shown.length)} of ${num(report.blocked.length)} refused orders. The full list is in the JSON report.</p>` : ""}`;

  const constraints =
    profile.bindingConstraints.length === 0
      ? ""
      : `<h2>Where this rulebook and this account disagree</h2>
<ul>${profile.bindingConstraints.map((c) => "<li>" + esc(c) + "</li>").join("")}</ul>`;

  const pnlNote =
    summary.blockedAttributedPnlUsd < 0
      ? "Negative means the refused orders lost money after they were sent: the gate would have kept that amount."
      : "Positive means the refused orders made money after they were sent: the gate would have cost that amount.";

  return page(
    "Shadow report " + report.user,
    `<h1>Shadow report</h1>
<p class="addr">${address}</p>
<p class="hint">Tested against the conservative rulebook${scaled ? ", with the order cap and daily loss limit scaled to this account's equity" : ""}.
Replayed over ${esc(utc(report.windowFrom))} → ${esc(utc(report.windowTo))} UTC from ${num(report.fillsConsidered)} public fills read in ${num(venueCalls)} venue calls.
This is a counterfactual: those trades already happened, and no order was ever sent by this service.</p>

<dl class="facts">
  <div class="fact"><dt>orders replayed</dt><dd>${num(summary.totalOrders)}</dd></div>
  <div class="fact"><dt>would be refused</dt><dd>${num(summary.blocked)} <span class="sub">${esc(pct(summary.blockRate))}</span></dd></div>
  <div class="fact"><dt>refused notional</dt><dd>${usd(summary.blockedNotionalUsd)}</dd></div>
  <div class="fact"><dt>attributed PnL of refused orders</dt><dd>${signed(summary.blockedAttributedPnlUsd)}</dd></div>
</dl>
<p class="hint">${esc(pnlNote)}</p>

<h2>Who this account is</h2>
<table>
<tbody>
<tr><th scope="row">fills considered</th><td class="n">${num(report.fillsConsidered)}</td></tr>
<tr><th scope="row">window span</th><td class="n">${esc(spanText(profile.spanMinutes))}</td></tr>
<tr><th scope="row">markets traded</th><td class="n">${num(profile.distinctMarkets)}</td></tr>
<tr><th scope="row">position-reducing share</th><td class="n">${esc(pct(profile.reduceOnlyShare))}</td></tr>
<tr><th scope="row">order rate p50 / p95</th><td class="n">${num(profile.ordersPerMinuteP50, 1)} / ${num(profile.ordersPerMinuteP95, 1)} per minute <span class="hint">(rulebook allows ${num(policy.max_orders_per_minute)})</span></td></tr>
<tr><th scope="row">order size median / p95</th><td class="n">${usd(profile.medianOrderNotionalUsd)} / ${usd(profile.p95OrderNotionalUsd)} <span class="hint">(rulebook cap ${usd(policy.max_order_notional_usd)})</span></td></tr>
<tr><th scope="row">allowed markets</th><td class="n">${esc(policy.allowed_markets.join(", "))}</td></tr>
</tbody>
</table>
${constraints}

<h2>The rulebook used</h2>
<p class="hint">conservative template${scaled ? " (scaled to this account)" : ""} · order cap ${usd(policy.max_order_notional_usd)} ·
daily loss ${usd(policy.max_daily_loss_usd)} · max leverage ${num(policy.max_leverage)}x ·
${num(policy.max_orders_per_minute)} orders/min · ${num(policy.max_same_side_adds_per_hour)} same-side adds/h ·
${num(policy.cooldown_seconds_after_deny)}s cool-down · depth multiple ${num(policy.min_book_depth_multiple, 1)} (declared unevaluated: no historical order books exist) ·
policy hash <code>${esc(report.policySemanticHash.slice(0, 16))}</code></p>

<h2>Refusals by rule</h2>
${byRuleTable}

${examplesTable}

<h2>What this report does not know</h2>
<ul>${report.caveats.map((c) => "<li>" + esc(c) + "</li>").join("")}</ul>

<footer class="hint">
<p>Generated ${esc(utc(report.generatedAt))} UTC${fromCache ? " · served from the two-minute in-memory cache" : ""}.
Replay is deterministic: the same fills produce the same verdicts, and the policy hash above names the rulebook that judged them.</p>
<p><a href="/api/shadow?address=${address}">Raw JSON</a> · <a href="/">Run another address</a></p>
</footer>`,
  );
}

/* ------------------------------------------------------------------------- *
 * HTTP plumbing
 * ------------------------------------------------------------------------- */

type Format = "html" | "json";

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body);
}

function fail(
  res: ServerResponse,
  format: Format,
  status: number,
  title: string,
  detail: string,
  extra: Record<string, string> = {},
): void {
  if (format === "json") {
    send(res, status, JSON_TYPE, JSON.stringify({ error: title, detail, status }) + "\n", extra);
    return;
  }
  const body = page(
    title,
    "<h1>" +
      esc(title) +
      '</h1><p>' +
      esc(detail) +
      '</p><p class="hint"><a href="/">Back to the form</a></p>',
  );
  send(res, status, HTML_TYPE, body, { ...HTML_HEADERS, ...extra });
}

type ShadowResponse = ShadowReport & {
  policy: ShadowRun["policy"];
  scaled: boolean;
  venueCalls: number;
  /** Present and false only for ?full=1; otherwise says how much was cut. */
  truncated: false | { episodes: number; blocked: number; note: string };
};

/** How many blocked episodes the default JSON payload carries. */
export const JSON_EPISODE_LIMIT = 100;

function sendReport(
  res: ServerResponse,
  format: Format,
  run: ShadowRun,
  fromCache: boolean,
  full = false,
): void {
  if (format === "json") {
    // A full report over 2,000 fills is several megabytes, almost all of it
    // per-episode rule traces that a caller reading a summary never touches.
    // The default payload therefore keeps the aggregate answer complete and
    // truncates the episode list, saying so in the body rather than silently
    // returning a partial report. ?full=1 returns everything.
    const episodes = full ? run.report.episodes : run.report.episodes.slice(0, JSON_EPISODE_LIMIT);
    const blocked = full ? run.report.blocked : run.report.blocked.slice(0, JSON_EPISODE_LIMIT);
    const payload: ShadowResponse = {
      // The report fields stay at the top level so a ShadowReport consumer needs
      // no unwrapping, and the run metadata the CLI prints is attached beside it.
      ...run.report,
      episodes,
      blocked,
      policy: run.policy,
      scaled: run.scaled,
      venueCalls: run.venueCalls,
      truncated: full
        ? false
        : {
            episodes: run.report.episodes.length - episodes.length,
            blocked: run.report.blocked.length - blocked.length,
            note: "Summary, profile and caveats are complete. Add ?full=1 for every episode and trace.",
          },
    };
    send(res, 200, JSON_TYPE, JSON.stringify(payload) + "\n");
    return;
  }
  send(res, 200, HTML_TYPE, reportPage(run, fromCache), HTML_HEADERS);
}

/**
 * The one path that spends upstream calls: validate, cache, rate limit, queue,
 * build. Everything that can be refused is refused before the venue is touched.
 */
async function reportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  format: Format,
): Promise<void> {
  const address = (url.searchParams.get("address") ?? "").trim();
  if (!ADDRESS_RE.test(address)) {
    fail(
      res,
      format,
      400,
      "Invalid address",
      address === ""
        ? "No address given. Pass a public Hyperliquid account address as ?address=0x followed by 40 hex characters."
        : "That is not a Hyperliquid account address. Expected 0x followed by 40 hex characters; this service has nothing to look up without one.",
    );
    return;
  }

  const key = address.toLowerCase();
  const full = url.searchParams.get("full") === "1";
  const cached = cacheGet(key);
  if (cached) {
    sendReport(res, format, cached, true, full);
    return;
  }

  const limit = takeToken(clientIp(req));
  if (!limit.allowed) {
    fail(
      res,
      format,
      429,
      "Rate limit reached",
      "This IP has already built " +
        RATE_LIMIT_MAX +
        " reports in the last ten minutes. Hyperliquid's public API is shared, so the limit exists to keep this service a good citizen. Try again in about " +
        limit.retryAfterSec +
        " seconds; a report you built recently is still served from cache.",
      { "retry-after": String(limit.retryAfterSec) },
    );
    return;
  }

  let release: (() => void) | undefined;
  try {
    release = await gate.acquire();
    const run = await withTimeout(buildShadowReport(address), BUILD_TIMEOUT_MS);
    cacheSet(key, run);
    sendReport(res, format, run, false, full);
  } catch (err) {
    const failure = classify(err);
    fail(res, format, failure.status, "Could not build the report", failure.message, {
      ...(failure.retryAfterSec === undefined ? {} : { "retry-after": String(failure.retryAfterSec) }),
    });
  } finally {
    if (release) release();
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    send(res, 405, TEXT_TYPE, "405 method not allowed — this service is read-only and answers GET only\n", {
      allow: "GET",
    });
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    send(res, 400, TEXT_TYPE, "400 malformed request URL\n");
    return;
  }

  switch (url.pathname) {
    case "/":
      send(res, 200, HTML_TYPE, homePage(), HTML_HEADERS);
      return;
    case "/healthz":
      send(res, 200, JSON_TYPE, JSON.stringify({ ok: true }) + "\n");
      return;
    case "/report":
      await reportRoute(req, res, url, "html");
      return;
    case "/api/shadow":
      await reportRoute(req, res, url, "json");
      return;
    default:
      if (url.pathname.startsWith("/api/")) {
        send(res, 404, JSON_TYPE, JSON.stringify({ error: "Not found", detail: "Unknown API path." }) + "\n");
      } else {
        send(
          res,
          404,
          HTML_TYPE,
          page("Not found", '<h1>Not found</h1><p>This service serves /, /report, /api/shadow and /healthz.</p><p class="hint"><a href="/">Back to the form</a></p>'),
          HTML_HEADERS,
        );
      }
      return;
  }
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const started = Date.now();
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  res.on("finish", () => {
    console.log("[shadowd] " + (req.method ?? "?") + " " + path + " " + res.statusCode + " " + (Date.now() - started) + "ms");
  });
  route(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shadowd] unhandled: " + message);
    if (!res.headersSent) send(res, 500, TEXT_TYPE, "500 internal error\n");
    else res.end();
  });
}

function main(): void {
  const server = createServer(handle);
  server.listen(PORT, HOST, () => {
    console.log("[shadowd] read-only shadow report service on http://" + HOST + ":" + PORT);
    console.log("[shadowd] routes GET / · /report · /api/shadow · /healthz — anything else is 404, any other method is 405");
    console.log(
      "[shadowd] limits: " +
        RATE_LIMIT_MAX +
        " builds per IP per " +
        RATE_LIMIT_WINDOW_MS / 60_000 +
        " min · " +
        MAX_CONCURRENT_BUILDS +
        " concurrent · " +
        CACHE_TTL_MS / 1000 +
        "s cache · upstream budget " +
        BUILD_TIMEOUT_MS / 1000 +
        "s · trust proxy " +
        (TRUST_PROXY ? "ON" : "OFF"),
    );
    console.log(
      "[shadowd] no key is present in this process" +
        (scrubbedEnv.length > 0 ? " — scrubbed key-shaped env vars: " + scrubbedEnv.join(", ") : ""),
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log("[shadowd] " + signal + " — draining and exiting");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

main();
