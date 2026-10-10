/**
 * The VetoOS console: a single self-contained page served by brokerd.
 * No build step, no framework — open http://127.0.0.1:4310/ and watch the
 * broker think. Read-only for machines; the unfreeze button is for humans.
 */

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VetoOS — Risk Broker Console</title>
<style>
  :root {
    --bg: #0b0f14; --panel: #11161d; --panel2: #161d27; --line: #232c38;
    --fg: #e6edf3; --dim: #8b98a9; --accent: #22d3ee;
    --green: #3fb950; --red: #f85149; --amber: #d29922;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 14px/1.5 -apple-system, "SF Pro", "Segoe UI", sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 22px; margin: 0; letter-spacing: 0.5px; }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px;
           font-size: 12px; color: var(--dim); font-family: ui-monospace, Menlo, monospace; }
  #banner { display: none; margin: 18px 0 0; padding: 14px 18px; border-radius: 10px;
            background: var(--red); color: #fff; font-weight: 700; font-size: 16px;
            align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  #banner small { font-weight: 400; opacity: 0.92; display: block; margin-top: 4px; }
  #banner button { background: #fff; color: var(--red); border: 0; border-radius: 8px;
                   padding: 8px 16px; font-weight: 700; cursor: pointer; }
  #okbar { margin: 18px 0 0; padding: 10px 18px; border-radius: 10px; color: var(--green);
           border: 1px solid var(--line); background: var(--panel); font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 12px; margin-top: 18px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .card .v { font-size: 22px; font-weight: 700; font-family: ui-monospace, Menlo, monospace; }
  .card .k { font-size: 12px; color: var(--dim); margin-top: 2px; }
  h2 { font-size: 14px; color: var(--dim); font-weight: 600; margin: 28px 0 8px;
       text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line);
           font-size: 12.5px; vertical-align: top; }
  th { color: var(--dim); font-weight: 600; background: var(--panel2); }
  tr:last-child td { border-bottom: 0; }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .allow { color: var(--green); font-weight: 700; }
  .deny { color: var(--red); font-weight: 700; }
  .freeze { color: var(--red); font-weight: 700; }
  .other { color: var(--amber); font-weight: 600; }
  .reason { color: var(--dim); display: block; margin-top: 2px; }
  .foot { margin-top: 28px; color: var(--dim); font-size: 12px; }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>VetoOS</h1>
    <span class="tag">Risk Broker Console — rules outrank models</span>
    <span class="badge" id="policy">policy …</span>
    <span class="badge" id="nets">…</span>
    <span class="badge mono" id="clock"></span>
  </header>

  <div id="banner">
    <div>BROKER FROZEN<small id="freezeReason"></small></div>
    <button id="unfreezeBtn">HUMAN UNFREEZE</button>
  </div>
  <div id="okbar">OPERATIONAL — evaluating intents against deterministic rules</div>

  <div class="grid">
    <div class="card"><div class="v" id="equity">–</div><div class="k">testnet equity (USD)</div></div>
    <div class="card"><div class="v" id="avail">–</div><div class="k">available margin</div></div>
    <div class="card"><div class="v" id="pos">–</div><div class="k" id="posK">position</div></div>
    <div class="card"><div class="v" id="fills">–</div><div class="k">ledger fills</div></div>
    <div class="card"><div class="v" id="events">–</div><div class="k">history events</div></div>
  </div>

  <h2>Intent &amp; decision feed</h2>
  <table>
    <thead><tr><th>time</th><th>type</th><th>market</th><th>side</th><th>size</th><th>decision</th><th>reason</th></tr></thead>
    <tbody id="feed"></tbody>
  </table>

  <div class="foot">
    <span id="auditPath"></span> · API: <a href="/openapi.json">/openapi.json</a> ·
    unfreeze requires the human header — no API for models.
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const fmt = (n, d=2) => Number(n).toLocaleString(undefined, {maximumFractionDigits: d});

function classify(ev) {
  if (ev.type === "freeze") return "freeze";
  if (ev.type === "decision" && ev.data && ev.data.decision === "deny") return "deny";
  if (ev.type === "decision") return "allow";
  if (ev.type === "order_placed") return "allow";
  return "other";
}

function rowFor(ev) {
  const d = ev.data || {};
  const intent = d.intent || {};
  const cls = classify(ev);
  const market = d.market || intent.market || (d.snapshot && d.snapshot.market) || "";
  const side = d.side || intent.side || (d.snapshot && d.snapshot.side) || "";
  const size = d.size || intent.size || (d.snapshot && d.snapshot.size) || "";
  let decision = ev.type;
  if (ev.type === "decision") decision = d.validationError ? "invalid" : (d.decision || "?").toUpperCase() + (d.code && d.code !== "ALLOW" ? " · " + d.code : "");
  if (d.duplicate) decision += " · DUP";
  const reason = d.message_zh ? d.message_zh + " / " + d.message_en
    : d.reason || d.error || (d.freeze_reason ? "freeze: " + d.freeze_reason : "");
  const t = (ev.ts || "").slice(11, 19);
  return "<tr><td class=mono>" + t + "</td><td>" + ev.type + "</td><td>" + market +
    "</td><td>" + side + "</td><td class=mono>" + size + "</td><td class=" + cls + ">" +
    decision + "</td><td><span class=reason>" + (reason || "") + "</span></td></tr>";
}

async function refresh() {
  try {
    const [status, account, feed] = await Promise.all([
      fetch("/v1/status").then(r => r.json()),
      fetch("/v1/account").then(r => r.json()),
      fetch("/v1/feed?n=40").then(r => r.json()),
    ]);
    $("policy").textContent = "policy " + String(status.policyHash || "").slice(0, 12) + "…";
    $("nets").textContent = status.tradeMarket + " · read " + status.readNetwork + " · write " + status.writeNetwork;
    $("equity").textContent = "$" + fmt(account.equityUsd);
    $("avail").textContent = "$" + fmt(account.availableMarginUsd);
    $("pos").textContent = fmt(account.positionSize, 6);
    $("posK").textContent = "position " + (account.tradeMarket || "");
    $("fills").textContent = status.ledgerFills;
    $("events").textContent = status.historyEvents;
    $("banner").style.display = status.frozen ? "flex" : "none";
    $("okbar").style.display = status.frozen ? "none" : "block";
    if (status.frozen) $("freezeReason").textContent = status.freezeReason || "";
    const rows = (feed.events || []).slice().reverse().map(rowFor);
    $("feed").innerHTML = rows.join("") || "<tr><td colspan=7 class=mono>no events yet — POST an intent to /v1/intents</td></tr>";
    $("clock").textContent = new Date().toISOString().slice(11, 19) + "Z";
  } catch (e) { /* brokerd restarting — next tick retries */ }
}

$("unfreezeBtn").onclick = async () => {
  if (!confirm("Human unfreeze — confirm you reviewed the mismatch cause?")) return;
  const r = await fetch("/v1/unfreeze", { method: "POST", headers: { "x-vetoos-human": "I_AM_HUMAN" } });
  if (!r.ok) alert("unfreeze rejected: " + r.status);
  refresh();
};

fetch("/v1/policy").then(r => r.json()).then(p => { $("auditPath").textContent = "policy: " + p.path; });
refresh();
setInterval(refresh, 2500);
</script>
</body>
</html>`;
}
