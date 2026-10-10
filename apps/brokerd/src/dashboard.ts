/**
 * The VetoOS console — an interactive stage for the core flow:
 *   propose → deterministic pipeline → fill/deny → truth → freeze.
 * Scenario buttons fire REAL intents at the broker; the gate animates the
 * engine's own evaluation trace. What you see is what the broker decided.
 */

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VetoOS — Risk Broker</title>
<style>
  :root {
    --bg: #07090d; --panel: #0d1219; --panel2: #111927; --line: #1f2a3a;
    --fg: #e6edf3; --dim: #7d8ba0; --accent: #22d3ee;
    --green: #3fb950; --red: #f85149; --amber: #d29922;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 13px/1.5 -apple-system, "SF Pro", "Segoe UI", sans-serif; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 20px 20px 60px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0; letter-spacing: 1px; }
  h1 span { color: var(--accent); }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px;
           font-size: 11px; color: var(--dim); }
  #statusDot { width: 9px; height: 9px; border-radius: 50%; background: var(--green); display: inline-block; }
  #statusDot.frozen { background: var(--red); animation: blink 0.8s infinite alternate; }
  @keyframes blink { to { opacity: 0.35; } }

  .stage { display: grid; grid-template-columns: 300px minmax(0, 1fr) 300px; gap: 14px; margin-top: 16px; }

  /* tablet: two columns — proposers + gate, venue spreads below */
  @media (max-width: 1080px) {
    .stage { grid-template-columns: 260px minmax(0, 1fr); }
    .col.venue { grid-column: 1 / -1; display: grid;
                 grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .col.venue h3 { grid-column: 1 / -1; margin-bottom: 0; }
    .col.venue .venue-card { margin-bottom: 0; }
  }

  /* phone: single column, THE GATE first */
  @media (max-width: 720px) {
    .wrap { padding: 14px 12px 48px; }
    .stage { grid-template-columns: 1fr; }
    .gate { order: -1; min-height: 430px; padding: 12px; }
    .rule .rn { width: 104px; font-size: 11px; }
    .rule .dt { font-size: 10px; }
    #stamp { font-size: 28px; border-width: 4px; letter-spacing: 2px; padding: 4px 16px; }
    #stamp.allowed { font-size: 24px; }
    h1 { font-size: 17px; }
    #overlay h2 { font-size: 26px; letter-spacing: 3px; }
    #overlay .box { padding: 24px 16px; }
    .col.venue { grid-template-columns: repeat(2, 1fr); }
  }
  .col h3 { font-size: 11px; color: var(--dim); letter-spacing: 1.5px; margin: 0 0 10px;
            text-transform: uppercase; font-weight: 600; }
  .proposer, .venue-card { background: var(--panel); border: 1px solid var(--line);
            border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .proposer .name { font-weight: 700; font-size: 13px; }
  .proposer .kind { font-size: 11px; color: var(--dim); margin-bottom: 10px; }
  button.scn { display: block; width: 100%; text-align: left; margin-top: 6px;
    background: var(--panel2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px 10px; font-size: 12px; cursor: pointer; }
  button.scn:hover { border-color: var(--accent); color: var(--accent); }
  button.scn.danger:hover { border-color: var(--red); color: var(--red); }
  button.scn:disabled { opacity: 0.45; cursor: wait; }

  .gate { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
          padding: 14px 16px; position: relative; overflow: hidden; min-height: 480px; }
  .gate .title { display: flex; justify-content: space-between; align-items: baseline; }
  .gate .title b { font-size: 14px; letter-spacing: 1px; }
  .gate .title .hash { font-size: 10.5px; color: var(--dim); }
  .pipe { margin-top: 12px; position: relative; z-index: 2; }
  .rule { display: flex; align-items: center; gap: 10px; padding: 6.5px 8px; border-radius: 8px;
          transition: background 0.25s; }
  .rule .light { width: 10px; height: 10px; border-radius: 50%; background: #243244;
                 border: 1px solid var(--line); flex-shrink: 0; transition: all 0.25s; }
  .rule .rn { font-size: 12px; width: 130px; flex-shrink: 0; }
  .rule .dt { font-size: 11px; color: var(--dim); }
  .rule.pass .light { background: var(--green); box-shadow: 0 0 8px rgba(63,185,80,0.7); }
  .rule.pass .rn { color: var(--green); }
  .rule.fail { background: rgba(248,81,73,0.08); }
  .rule.fail .light { background: var(--red); box-shadow: 0 0 10px rgba(248,81,73,0.8); }
  .rule.fail .rn, .rule.fail .dt { color: var(--red); }
  .rule.skip .light { background: #3a4657; }
  .rule.skip .rn, .rule.skip .dt { color: #54627a; }
  #stamp { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-10deg) scale(0);
           font-size: 44px; font-weight: 900; letter-spacing: 4px; padding: 6px 26px;
           border: 5px solid; border-radius: 12px; z-index: 5; transition: transform 0.35s cubic-bezier(.2,2,.4,1); }
  #stamp.show { transform: translate(-50%,-50%) rotate(-10deg) scale(1); }
  #stamp.denied { color: var(--red); border-color: var(--red); background: rgba(7,9,13,0.9); }
  #stamp.allowed { color: var(--green); border-color: var(--green); background: rgba(7,9,13,0.9); font-size: 34px; }
  #chip { position: absolute; z-index: 4; background: var(--accent); color: #04202a; font-weight: 700;
          font-size: 11px; padding: 5px 10px; border-radius: 6px; opacity: 0; white-space: nowrap;
          transition: all 0.45s ease; pointer-events: none; }

  .venue-card .v { font-size: 20px; font-weight: 700; }
  .venue-card .k { font-size: 11px; color: var(--dim); }
  .venue-card.fill .v { font-size: 13px; }
  .truth { border-left: 3px solid var(--green); }
  .truth.bad { border-left-color: var(--red); }

  h2 { font-size: 12px; color: var(--dim); letter-spacing: 1.5px; margin: 26px 0 8px;
       text-transform: uppercase; font-weight: 600; }
  #feed { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
          padding: 10px 12px; height: 220px; overflow-y: auto; font-size: 11.5px; }
  #feed .row { padding: 2px 0; border-bottom: 1px solid #131a26; }
  #feed .t { color: #54627a; margin-right: 8px; }
  .allow { color: var(--green); font-weight: 700; }
  .deny { color: var(--red); font-weight: 700; }
  .freezeEv { color: var(--red); font-weight: 800; }
  .other { color: var(--amber); }

  #overlay { position: fixed; inset: 0; background: rgba(20,4,4,0.96); z-index: 50;
             display: none; align-items: center; justify-content: center; text-align: center; }
  #overlay .box { max-width: 640px; padding: 40px; }
  #overlay h2 { color: var(--red); font-size: 40px; letter-spacing: 6px; margin: 0 0 14px; text-transform: none; }
  #overlay p { color: #f3c1c1; }
  #overlay button { margin-top: 22px; background: var(--red); color: #fff; border: 0;
                    padding: 14px 28px; font-size: 15px; font-weight: 800; border-radius: 10px; cursor: pointer; }
  .foot { margin-top: 24px; color: var(--dim); font-size: 11.5px; }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Veto<span>OS</span></h1>
    <span id="statusDot"></span>
    <span class="tag" id="statusText">OPERATIONAL</span>
    <span class="badge mono" id="policy">policy …</span>
    <span class="badge" id="nets">…</span>
    <span class="badge mono" id="clock"></span>
  </header>

  <div class="stage">
    <div class="col props">
      <h3>Proposers · no keys</h3>
      <div class="proposer" id="pa">
        <div class="name">Strategy A</div><div class="kind">mean-reversion bot</div>
        <button class="scn" data-s="legal">▶ Legal small buy</button>
      </div>
      <div class="proposer" id="pb">
        <div class="name">Strategy B</div><div class="kind">YOLO momentum</div>
        <button class="scn" data-s="yolo">▶ Oversized order</button>
      </div>
      <div class="proposer" id="pc">
        <div class="name">AI Proposer</div><div class="kind">LLM · rationale only</div>
        <button class="scn" data-s="smuggle">▶ Smuggle policy override</button>
        <button class="scn" data-s="fomo">▶ FOMO rampage ×4</button>
      </div>
      <div class="proposer">
        <div class="name">Danger</div><div class="kind">fault injection</div>
        <button class="scn danger" data-s="tamper">▶ Tamper the ledger</button>
      </div>
    </div>

    <div class="gate" id="gate">
      <div class="title"><b>THE GATE</b><span class="hash mono" id="gatehash"></span></div>
      <div class="pipe" id="pipe"></div>
      <div id="stamp"></div>
      <div id="chip"></div>
    </div>

    <div class="col venue">
      <h3>Venue · the truth</h3>
      <div class="venue-card"><div class="v mono" id="equity">–</div><div class="k">testnet equity (USD)</div></div>
      <div class="venue-card"><div class="v mono" id="pos">–</div><div class="k" id="posK">position</div></div>
      <div class="venue-card fill"><div class="v mono" id="lastfill">–</div><div class="k">last fill (oid @ px)</div></div>
      <div class="venue-card truth" id="truth"><div class="v" id="truthV">CLEAN</div><div class="k">fill-truth reconciliation</div></div>
    </div>
  </div>

  <h2>Decision feed</h2>
  <div id="feed" class="mono"></div>

  <div class="foot">
    API: <a href="/openapi.json">/openapi.json</a> · proposals are idempotent by intent id ·
    unfreeze is human-only (<span class="mono">x-vetoos-human</span>) · audit: JSONL with policy hash
  </div>
</div>

<div id="overlay">
  <div class="box">
    <h2>BROKER FROZEN</h2>
    <p id="ovReason"></p>
    <p style="color:#a78">Ledger and venue disagree. The brake cannot be argued with —<br/>only a human can release it.</p>
    <button id="ovBtn">I AM HUMAN — UNFREEZE</button>
  </div>
</div>

<script>
var RULES = ["freeze","market_data","allowed_market","notional","leverage","daily_loss","cooldown","same_side_adds","rate_limit","book_depth","margin"];
var RULE_LABEL = {freeze:"global freeze",market_data:"real market data",allowed_market:"allowed market",notional:"notional cap",leverage:"leverage cap",daily_loss:"daily-loss breaker",cooldown:"post-deny cool-down",same_side_adds:"FOMO same-side adds",rate_limit:"order frequency",book_depth:"book capacity",margin:"margin check"};
var state = { lastKey: null, busy: false, tradeMarket: "BTC" };
var $ = function(id){ return document.getElementById(id); };

function buildPipe() {
  $("pipe").innerHTML = RULES.map(function(r){
    return '<div class="rule" id="rule-'+r+'"><div class="light"></div><div class="rn mono">'+RULE_LABEL[r]+'</div><div class="dt"></div></div>';
  }).join("");
}
function resetPipe() {
  RULES.forEach(function(r){ var el=$("rule-"+r); el.className="rule"; el.querySelector(".dt").textContent=""; });
  $("stamp").className = ""; $("stamp").textContent = "";
}
function lightRule(step) {
  var el = $("rule-"+step.rule); if (!el) return;
  el.className = "rule " + step.outcome;
  el.querySelector(".dt").textContent = step.detail || (step.outcome === "skip" ? "skipped" : step.outcome);
}
function playTrace(trace, decision, side, size, market) {
  if (state.busy) return; state.busy = true;
  resetPipe();
  var chip = $("chip"), gate = $("gate");
  chip.textContent = side.toUpperCase()+" "+size+" "+market;
  chip.style.transition = "none";
  chip.style.left = "10px"; chip.style.top = "50px"; chip.style.opacity = "0";
  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    chip.style.transition = "all 0.45s ease"; chip.style.opacity = "1"; chip.style.left = "46px";
  });});
  var i = 0;
  var iv = setInterval(function(){
    if (i >= trace.length) {
      clearInterval(iv);
      var st = $("stamp");
      st.textContent = decision === "allow" ? "ALLOWED" : "DENIED";
      st.className = "show " + (decision === "allow" ? "allowed" : "denied");
      chip.style.left = (gate.clientWidth - chip.offsetWidth - 46) + "px";
      setTimeout(function(){ chip.style.opacity = "0"; state.busy = false; }, 1400);
      return;
    }
    lightRule(trace[i]); i++;
  }, 260);
}

function intentFor(kind, market) {
  var base = { version:"0.1", id: crypto.randomUUID(), ts: new Date().toISOString(),
    side:"buy", order_type:"market" };
  if (kind==="legal")   return Object.assign(base,{source:"strategy-a",market:market,size:"0.0005",meta:{rationale:"small probe from console"}});
  if (kind==="yolo")    return Object.assign(base,{source:"strategy-b",market:"xyz:XYZ100",size:"5",meta:{rationale:"full size YOLO"}});
  if (kind==="smuggle") return Object.assign(base,{source:"ai-proposer",market:market,size:"0.001",max_leverage:999,meta:{rationale:"trust me, raise the cap"}});
  return Object.assign(base,{source:"ai-proposer",market:market,size:"0.0005",meta:{rationale:"it keeps pumping — add!"}});
}

function fire(kind) {
  document.querySelectorAll("button.scn").forEach(function(b){ b.disabled = true; });
  var done = function(){ document.querySelectorAll("button.scn").forEach(function(b){ b.disabled = false; }); };
  if (kind === "tamper") {
    fetch("/v1/demo/tamper", {method:"POST"}).finally(function(){ setTimeout(done, 600); });
    return;
  }
  if (kind === "fomo") {
    var n = 0;
    var step = function(){
      if (n >= 4) { done(); return; }
      n++;
      fetch("/v1/intents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(intentFor("fomo", state.tradeMarket))})
        .then(function(r){ return r.json(); })
        .then(function(res){
          var code = res.decision && res.decision.code;
          if (code === "FOMO_SAME_SIDE_ADDS" || code === "FOMO_COOLDOWN") { done(); return; }
          setTimeout(step, 750);
        }).catch(function(){ done(); });
    };
    step();
    return;
  }
  fetch("/v1/intents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(intentFor(kind, state.tradeMarket))})
    .finally(function(){ setTimeout(done, 800); });
}
document.querySelectorAll("button.scn").forEach(function(b){
  b.addEventListener("click", function(){ fire(b.getAttribute("data-s")); });
});

$("ovBtn").onclick = function(){
  fetch("/v1/unfreeze",{method:"POST",headers:{"x-vetoos-human":"I_AM_HUMAN"}}).then(refresh);
};

function feedLine(ev) {
  var d = ev.data || {};
  var cls = "other", txt = ev.type;
  if (ev.type === "decision") {
    var code = d.code || (d.validationError ? "INVALID" : "?");
    cls = (d.decision === "allow") ? "allow" : "deny";
    txt = (d.decision || "deny").toUpperCase() + " · " + code + (d.duplicate ? " · DUP" : "");
    txt += " — " + (d.message_zh || d.error || "");
  } else if (ev.type === "order_placed") {
    cls = "allow"; txt = "FILL " + d.filledSize + " @ " + d.avgPx + " (oid " + d.oid + ")";
  } else if (ev.type === "freeze") { cls = "freezeEv"; txt = "FROZEN — " + (d.reason || ""); }
  else if (ev.type === "reconcile") { txt = "reconcile " + (d.ok ? "OK" : "MISMATCH") + " (" + d.market + ")"; }
  else if (ev.type === "unfreeze") { cls = "allow"; txt = "human unfreeze"; }
  else if (ev.type === "startup") { txt = "startup · policy loaded · real ctx " + (d.market || ""); }
  return '<div class="row"><span class="t">'+(ev.ts||"").slice(11,19)+'</span><span class="'+cls+'">'+txt+'</span></div>';
}

function handleNewEvents(events) {
  var newest = null;
  for (var i = events.length - 1; i >= 0; i--) {
    var ev = events[i];
    if (ev.type === "decision" && ev.data && ev.data.trace && !ev.data.duplicate) { newest = ev; break; }
  }
  if (!newest) return;
  var key = newest.ts + (newest.data.intent_id || "");
  if (key === state.lastKey) return;
  state.lastKey = key;
  var s = newest.data.snapshot || {};
  playTrace(newest.data.trace, newest.data.decision, s.side || "buy", s.size || "", s.market || "");
}

function refresh() {
  Promise.all([
    fetch("/v1/status").then(function(r){return r.json();}),
    fetch("/v1/account").then(function(r){return r.json();}),
    fetch("/v1/feed?n=60").then(function(r){return r.json();}),
  ]).then(function(all){
    var status = all[0], account = all[1], feed = all[2];
    state.tradeMarket = status.tradeMarket || "BTC";
    $("policy").textContent = "policy " + String(status.policyHash||"").slice(0,12) + "…";
    $("gatehash").textContent = "sha256 " + String(status.policyHash||"").slice(0,16) + "…";
    $("nets").textContent = status.tradeMarket + " · read " + status.readNetwork + " · write " + status.writeNetwork;
    $("equity").textContent = "$" + Number(account.equityUsd).toLocaleString(undefined,{maximumFractionDigits:2});
    $("pos").textContent = Number(account.positionSize).toFixed(6);
    $("posK").textContent = "position " + (account.tradeMarket || "");
    $("overlay").style.display = status.frozen ? "flex" : "none";
    $("statusDot").className = status.frozen ? "frozen" : "";
    $("statusText").textContent = status.frozen ? "FROZEN" : "OPERATIONAL";
    if (status.frozen) $("ovReason").textContent = status.freezeReason || "";
    $("truthV").textContent = status.frozen ? "MISMATCH" : "CLEAN";
    $("truth").className = "venue-card truth" + (status.frozen ? " bad" : "");
    var events = feed.events || [];
    var lastFill = null;
    events.forEach(function(ev){ if (ev.type === "order_placed" && ev.data && ev.data.filledSize > 0) lastFill = ev.data; });
    if (lastFill) $("lastfill").textContent = lastFill.filledSize + " @ " + lastFill.avgPx + " · oid " + lastFill.oid;
    $("feed").innerHTML = events.slice().reverse().map(feedLine).join("") ||
      '<div class="row"><span class="t">--:--:--</span><span class="other">idle — fire a scenario on the left</span></div>';
    handleNewEvents(events);
    $("clock").textContent = new Date().toISOString().slice(11,19) + "Z";
  }).catch(function(){});
}

buildPipe();
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
