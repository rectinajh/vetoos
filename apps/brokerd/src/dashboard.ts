/**
 * VetoOS Risk Terminal — a trading-terminal-grade console:
 *   left rail : live HIP-3 mainnet market data + scenario simulator
 *   center    : THE GATE (rule pipeline) + risk utilization gauges
 *   right rail: risk alerts + venue account
 * Everything is live: scenario buttons fire real intents, the gate replays
 * the engine's own trace, alerts derive from the same counters the rules use.
 */

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VetoOS — Risk Terminal</title>
<style>
  :root {
    --bg: #05080e; --panel: #0a101a; --panel2: #0e1622; --line: #182335;
    --fg: #dbe6f3; --dim: #64748f; --accent: #22d3ee;
    --green: #3fb950; --red: #f85149; --amber: #d29922;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 12px/1.45 -apple-system, "SF Pro", "Segoe UI", sans-serif;
         font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 14px 16px 48px; }
  header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; letter-spacing: 1px; }
  h1 span { color: var(--accent); }
  .tag { font-size: 11px; color: var(--dim); }
  .badge { border: 1px solid var(--line); border-radius: 4px; padding: 2px 8px;
           font-size: 10.5px; color: var(--dim); }
  #statusDot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; }
  #statusDot.frozen { background: var(--red); animation: blink 0.7s infinite alternate; }
  @keyframes blink { to { opacity: 0.3; } }

  .stage { display: grid; grid-template-columns: 272px minmax(0,1fr) 292px; gap: 10px; margin-top: 12px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; }
  .phead { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px;
           border-bottom: 1px solid var(--line); font-size: 10px; color: var(--dim);
           letter-spacing: 1.2px; text-transform: uppercase; font-weight: 600; }
  .pbody { padding: 10px; }
  .chip { font-size: 9.5px; padding: 1px 6px; border-radius: 3px; font-weight: 700; letter-spacing: 0.5px; }
  .chip.hip { background: rgba(34,211,238,0.12); color: var(--accent); }
  .chip.test { background: rgba(210,153,34,0.14); color: var(--amber); }

  .mark { font-size: 26px; font-weight: 800; letter-spacing: 0.5px; }
  .mark small { font-size: 11px; color: var(--dim); font-weight: 400; margin-left: 6px; }
  .kv { display: flex; justify-content: space-between; padding: 3.5px 0; font-size: 11.5px; }
  .kv .k { color: var(--dim); }
  .kv .v { font-weight: 600; }
  .depthbar { height: 4px; background: #131c2c; border-radius: 2px; overflow: hidden; margin: 3px 0 7px; }
  .depthbar i { display: block; height: 100%; }

  button.scn { display: block; width: 100%; text-align: left; margin-top: 6px;
    background: var(--panel2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 7px 9px; font-size: 11.5px; cursor: pointer; }
  button.scn:hover { border-color: var(--accent); color: var(--accent); }
  button.scn.danger:hover { border-color: var(--red); color: var(--red); }
  button.scn:disabled { opacity: 0.45; cursor: wait; }
  .scn .who { color: var(--dim); font-size: 10px; display: block; }

  .gate { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
          position: relative; overflow: hidden; min-height: 430px; margin-bottom: 10px; }
  .pipe { padding: 8px 10px; position: relative; z-index: 2; }
  .rule { display: flex; align-items: center; gap: 9px; padding: 5px 7px; border-radius: 6px;
          transition: background 0.25s; }
  .rule .light { width: 9px; height: 9px; border-radius: 50%; background: #1b2637;
                 border: 1px solid var(--line); flex-shrink: 0; transition: all 0.25s; }
  .rule .rn { font-size: 11.5px; width: 128px; flex-shrink: 0; }
  .rule .dt { font-size: 10.5px; color: var(--dim); }
  .rule.pass .light { background: var(--green); box-shadow: 0 0 7px rgba(63,185,80,0.7); }
  .rule.pass .rn { color: var(--green); }
  .rule.fail { background: rgba(248,81,73,0.09); }
  .rule.fail .light { background: var(--red); box-shadow: 0 0 9px rgba(248,81,73,0.8); }
  .rule.fail .rn, .rule.fail .dt { color: var(--red); }
  .rule.skip .light { background: #2a3648; }
  .rule.skip .rn, .rule.skip .dt { color: #48576e; }
  #stamp { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-10deg) scale(0);
           font-size: 40px; font-weight: 900; letter-spacing: 4px; padding: 4px 22px;
           border: 5px solid; border-radius: 10px; z-index: 5; transition: transform 0.35s cubic-bezier(.2,2,.4,1); }
  #stamp.show { transform: translate(-50%,-50%) rotate(-10deg) scale(1); }
  #stamp.denied { color: var(--red); border-color: var(--red); background: rgba(5,8,14,0.92); }
  #stamp.allowed { color: var(--green); border-color: var(--green); background: rgba(5,8,14,0.92); font-size: 30px; }
  #chip2 { position: absolute; z-index: 4; background: var(--accent); color: #04202a; font-weight: 700;
          font-size: 10.5px; padding: 4px 9px; border-radius: 5px; opacity: 0; white-space: nowrap;
          transition: all 0.45s ease; pointer-events: none; }

  .gauges { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .gauge { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  .gauge .ghead { display: flex; justify-content: space-between; font-size: 10px; color: var(--dim);
                  margin-bottom: 6px; letter-spacing: 0.3px; }
  .gauge .gval { font-weight: 700; font-size: 11px; }
  .gbar { height: 5px; background: #131c2c; border-radius: 3px; overflow: hidden; }
  .gbar i { display: block; height: 100%; transition: width 0.5s ease, background 0.5s ease; }

  .alert { display: flex; gap: 8px; align-items: flex-start; padding: 7px 0; border-bottom: 1px solid #101826; }
  .alert:last-child { border-bottom: 0; }
  .alert .lvl { font-size: 9px; font-weight: 800; padding: 2px 6px; border-radius: 3px; flex-shrink: 0; margin-top: 1px; }
  .lvl.crit { background: rgba(248,81,73,0.16); color: var(--red); }
  .lvl.warn { background: rgba(210,153,34,0.16); color: var(--amber); }
  .lvl.info { background: rgba(34,211,238,0.12); color: var(--accent); }
  .alert .txt { font-size: 11.5px; }
  .noalerts { color: var(--dim); font-size: 11.5px; padding: 6px 0; }

  .big2 { font-size: 19px; font-weight: 800; }
  .sub2 { font-size: 10px; color: var(--dim); }
  .truth { border-left: 3px solid var(--green); }
  .truth.bad { border-left-color: var(--red); }

  h2 { font-size: 11px; color: var(--dim); letter-spacing: 1.5px; margin: 20px 0 6px;
       text-transform: uppercase; font-weight: 600; }
  #feed { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
          padding: 8px 10px; height: 200px; overflow-y: auto; font-size: 11px; }
  #feed .row { padding: 2px 0; border-bottom: 1px solid #0e1622; }
  #feed .t { color: #48576e; margin-right: 8px; }
  .allow { color: var(--green); font-weight: 700; }
  .deny { color: var(--red); font-weight: 700; }
  .freezeEv { color: var(--red); font-weight: 800; }
  .other { color: var(--amber); }

  #overlay { position: fixed; inset: 0; background: rgba(20,4,4,0.96); z-index: 50;
             display: none; align-items: center; justify-content: center; text-align: center; }
  #overlay .box { max-width: 640px; padding: 40px; }
  #overlay h2 { color: var(--red); font-size: 38px; letter-spacing: 6px; margin: 0 0 14px; text-transform: none; }
  #overlay p { color: #f3c1c1; }
  #overlay button { margin-top: 22px; background: var(--red); color: #fff; border: 0;
                    padding: 13px 26px; font-size: 14px; font-weight: 800; border-radius: 8px; cursor: pointer; }
  .dashrow { display: grid; grid-template-columns: 1.2fr 1fr 0.7fr; gap: 12px; margin-top: 12px; }
  .dashlabel { font-size: 9.5px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  #spark { width: 100%; height: 60px; background: #0a1320; border-radius: 6px; }
  .bc { display: flex; align-items: center; gap: 6px; margin: 3px 0; font-size: 10.5px; }
  .bc .nm { width: 118px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bc .bb { height: 8px; border-radius: 2px; background: var(--red); min-width: 2px; }
  .bc .ct { font-weight: 700; }
  .cfhero { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
  .cfnum { font-size: 30px; font-weight: 900; color: var(--green); }
  .cfside { min-width: 200px; }
  .cfrow { display: flex; gap: 8px; font-size: 10.5px; padding: 3px 0; border-bottom: 1px solid #0e1622; align-items: baseline; }
  .cfrow .t { color: #48576e; width: 58px; flex-shrink: 0; }
  .cfrow .m { flex: 1; }
  .cfrow .p { font-weight: 700; }
  .pnl-pos { color: var(--green); }
  .pnl-neg { color: var(--red); }
  .fillrow { display: flex; justify-content: space-between; font-size: 10.5px; padding: 2.5px 0; border-bottom: 1px solid #0e1622; }
  .fillrow .b { color: var(--green); font-weight: 700; }
  .fillrow .s { color: var(--red); font-weight: 700; }
  .wbtn { background: var(--panel2); color: var(--fg); border: 1px solid var(--line);
          border-radius: 6px; padding: 5px 12px; font-size: 11.5px; cursor: pointer; }
  .wbtn:hover { border-color: var(--accent); color: var(--accent); }
  .wbtn.connected { border-color: var(--green); color: var(--green); cursor: default; }
  #toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(80px);
           background: var(--panel2); color: var(--fg); border: 1px solid var(--accent);
           border-radius: 8px; padding: 9px 16px; font-size: 12px; z-index: 80;
           opacity: 0; transition: all 0.3s ease; max-width: 80vw; text-align: center; }
  #toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
  .foot { margin-top: 20px; color: var(--dim); font-size: 10.5px; }
  a { color: var(--accent); text-decoration: none; }
  @media (max-width: 740px) { .dashrow { grid-template-columns: 1fr; } }

  @media (max-width: 1120px) {
    .stage { grid-template-columns: 250px minmax(0,1fr); }
    .rail-r { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 10px; }
    .rail-r .panel { margin-bottom: 0; }
  }
  @media (max-width: 740px) {
    .wrap { padding: 10px 10px 40px; }
    .stage { grid-template-columns: 1fr; }
    .gate { order: -2; min-height: 400px; }
    .rail-r { order: -1; }
    .rule .rn { width: 100px; font-size: 10.5px; }
    .rule .dt { font-size: 9.5px; }
    #stamp { font-size: 26px; border-width: 4px; padding: 3px 14px; }
    .mark { font-size: 22px; }
    #overlay h2 { font-size: 24px; letter-spacing: 3px; }
    #overlay .box { padding: 24px 14px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Veto<span>OS</span></h1>
    <span id="statusDot"></span>
    <span class="tag" id="statusText">OPERATIONAL</span>
    <span class="badge" id="fresh" style="color:var(--green);border-color:var(--green)">LIVE · 0s</span>
    <span class="badge mono" id="policy">policy …</span>
    <span class="badge" id="nets">…</span>
    <span class="badge mono" id="clock"></span>
    <span style="flex:1"></span>
    <button id="walletBtn" class="wbtn">Connect Wallet</button>
  </header>

  <div class="stage">
    <div class="col rail-l">
      <div class="panel">
        <div class="phead"><span>HIP-3 · MAINNET</span><span class="chip hip" id="hipChip">xyz</span></div>
        <div class="pbody">
          <div class="mark mono" id="hipMark">–<small id="hipName"></small></div>
          <div class="kv"><span class="k">funding</span><span class="v mono" id="hipFund">–</span></div>
          <div class="kv"><span class="k">open interest</span><span class="v mono" id="hipOi">–</span></div>
          <div class="kv"><span class="k">asset id</span><span class="v mono" id="hipAsset">–</span></div>
          <div class="kv"><span class="k">book depth (bid side)</span><span class="v mono" id="hipDepthB">–</span></div>
          <div class="depthbar"><i id="hipDepthBBar" style="background:var(--green)"></i></div>
          <div class="kv"><span class="k">book depth (ask side)</span><span class="v mono" id="hipDepthA">–</span></div>
          <div class="depthbar"><i id="hipDepthABar" style="background:var(--red)"></i></div>
          <div class="kv"><span class="k">trade market (testnet)</span><span class="v mono" id="tradeMark">–</span></div>
        </div>
      </div>

      <div class="panel">
        <div class="phead"><span>Simulator</span><span class="chip test">LIVE FIRE</span></div>
        <div class="pbody">
          <button class="scn" data-s="legal">▶ Legal small buy<span class="who">strategy-a · should ALLOW + fill</span></button>
          <button class="scn" data-s="yolo">▶ Oversized order<span class="who">strategy-b · should DENY at notional</span></button>
          <button class="scn" data-s="smuggle">▶ Smuggle policy override<span class="who">ai-proposer · refused at intent layer</span></button>
          <button class="scn" data-s="fomo">▶ FOMO rampage ×4<span class="who">ai-proposer · stopped by FOMO guard</span></button>
          <button class="scn danger" data-s="tamper">▶ Tamper the ledger<span class="who">fault injection → freeze</span></button>
        </div>
      </div>
    </div>

    <div class="col">
      <div class="gate panel" id="gate">
        <div class="phead"><span>THE GATE · deterministic pipeline</span><span class="mono" id="gatehash" style="font-size:10px"></span></div>
        <div class="pipe" id="pipe"></div>
        <div id="stamp"></div>
        <div id="chip2"></div>
      </div>

      <div class="panel">
        <div class="phead"><span>Risk dashboard · utilization</span></div>
        <div class="pbody">
          <div class="gauges">
            <div class="gauge"><div class="ghead"><span>FOMO adds</span><span class="gval mono" id="gFomoV">–</span></div><div class="gbar"><i id="gFomo"></i></div></div>
            <div class="gauge"><div class="ghead"><span>orders / min</span><span class="gval mono" id="gRateV">–</span></div><div class="gbar"><i id="gRate"></i></div></div>
            <div class="gauge"><div class="ghead"><span>daily loss</span><span class="gval mono" id="gLossV">–</span></div><div class="gbar"><i id="gLoss"></i></div></div>
            <div class="gauge"><div class="ghead"><span>margin use</span><span class="gval mono" id="gMarginV">–</span></div><div class="gbar"><i id="gMargin"></i></div></div>
            <div class="gauge"><div class="ghead"><span>cool-down</span><span class="gval mono" id="gCoolV">–</span></div><div class="gbar"><i id="gCool"></i></div></div>
          </div>
          <div class="dashrow">
            <div class="dashcol">
              <div class="dashlabel">equity curve (session)</div>
              <svg id="spark" viewBox="0 0 300 60" preserveAspectRatio="none"></svg>
            </div>
            <div class="dashcol">
              <div class="dashlabel">denials by rule</div>
              <div id="bycode"></div>
            </div>
            <div class="dashcol small">
              <div class="dashlabel">track record</div>
              <div class="kv"><span class="k">allowed</span><span class="v mono" id="stAllow" style="color:var(--green)">0</span></div>
              <div class="kv"><span class="k">denied</span><span class="v mono" id="stDeny" style="color:var(--red)">0</span></div>
              <div class="kv"><span class="k">fills</span><span class="v mono" id="stFill">0</span></div>
              <div class="kv"><span class="k">freezes</span><span class="v mono" id="stFrz">0</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="phead"><span>Without the gate · counterfactual</span><span class="chip test">what-if</span></div>
        <div class="pbody">
          <div class="cfhero">
            <div><div class="cfnum" id="cfSaved">$0.00</div><div class="dashlabel">loss blocked by vetoes (denied intents marked to market)</div></div>
            <div class="cfside">
              <div class="kv"><span class="k">denied notional</span><span class="v mono" id="cfNotional">–</span></div>
              <div class="kv"><span class="k">vs equity</span><span class="v mono" id="cfLev">–</span></div>
              <div class="kv"><span class="k">missed gains</span><span class="v mono" id="cfMissed">$0.00</span></div>
            </div>
          </div>
          <div id="cfrows"></div>
        </div>
      </div>
    </div>

    <div class="col rail-r">
      <div class="panel">
        <div class="phead"><span>Risk alerts</span><span class="chip hip" id="alertCount">0</span></div>
        <div class="pbody" id="alerts"><div class="noalerts">no active alerts — nominal</div></div>
      </div>
      <div class="panel">
        <div class="phead"><span>Venue account · testnet execution</span><span class="chip test" id="venueNet">testnet</span></div>
        <div class="pbody">
          <div class="big2 mono" id="equity">–</div><div class="sub2">equity (USD)</div>
          <div class="kv" style="margin-top:8px"><span class="k">available</span><span class="v mono" id="avail">–</span></div>
          <div class="kv"><span class="k">position</span><span class="v mono" id="pos">–</span></div>
          <div class="kv"><span class="k">entry px</span><span class="v mono" id="posEntry">–</span></div>
          <div class="kv"><span class="k">unrealized pnl</span><span class="v mono" id="posUpnl">–</span></div>
          <div class="dashlabel" style="margin-top:8px">recent venue fills</div>
          <div id="fills"></div>
        </div>
      </div>
      <div class="panel truth" id="truth">
        <div class="pbody"><div class="big2" id="truthV" style="color:var(--green)">CLEAN</div><div class="sub2">fill-truth reconciliation</div></div>
      </div>
    </div>
  </div>

  <h2>Decision feed</h2>
  <div id="feed" class="mono"></div>

  <div class="foot">
    API: <a href="/openapi.json">/openapi.json</a> · idempotent by intent id ·
    unfreeze human-only · audit JSONL carries the policy hash · HIP-3 panel is mainnet truth
  </div>
</div>

<div id="toast"></div>

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
var state = { lastKey: null, busy: false, tradeMarket: "BTC", lastOk: 0, wallet: null };

// ---- wallet: optional. Only the human unfreeze uses it (EIP-191 proof). ----
function shortAddr(a){ return a.slice(0,6) + "…" + a.slice(-4); }
function toast(msg, ms) {
  var t = $("toast");
  t.textContent = msg;
  t.className = "show";
  clearTimeout(t._h);
  t._h = setTimeout(function(){ t.className = ""; }, ms || 3200);
}
function walletProvider() {
  // prefer MetaMask when multiple providers fight; fall back to any injected one
  if (window.ethereum) {
    if (window.ethereum.providers && window.ethereum.providers.length) {
      var mm = window.ethereum.providers.find(function(p){ return p.isMetaMask; });
      return mm || window.ethereum.providers[0];
    }
    return window.ethereum;
  }
  return null;
}
function initWallet() {
  var btn = $("walletBtn");
  btn.addEventListener("click", function(){
    if (state.wallet) { toast("wallet " + shortAddr(state.wallet) + " connected"); return; }
    var eth = walletProvider();
    if (!eth || !eth.request) {
      toast("No wallet detected — install MetaMask, or open this page in your wallet's browser. Console works without one.");
      return;
    }
    toast("check your wallet to approve the connection…");
    eth.request({ method: "eth_requestAccounts" }).then(function(accs){
      if (!accs || !accs[0]) { toast("no account selected"); return; }
      state.wallet = accs[0];
      btn.textContent = shortAddr(accs[0]);
      btn.className = "wbtn connected";
      btn.title = "connected — your signature is the human proof for unfreeze";
      toast("wallet " + shortAddr(accs[0]) + " connected — it is your unfreeze key");
    }).catch(function(err){
      toast("wallet connection failed: " + ((err && err.message) || "rejected"));
    });
  });
  var eth = walletProvider();
  if (eth && eth.on) {
    eth.on("accountsChanged", function(accs){
      state.wallet = accs && accs[0] ? accs[0] : null;
      var b = $("walletBtn");
      if (state.wallet) { b.textContent = shortAddr(state.wallet); b.className = "wbtn connected"; }
      else { b.textContent = "Connect Wallet"; b.className = "wbtn"; }
    });
  }
}
initWallet();
setInterval(function(){
  var el = $("fresh"); if (!el) return;
  var age = state.lastOk ? Math.round((Date.now() - state.lastOk) / 1000) : 99;
  if (age <= 8) { el.textContent = "LIVE · " + age + "s"; el.style.color = "var(--green)"; el.style.borderColor = "var(--green)"; }
  else { el.textContent = "STALE · " + age + "s"; el.style.color = "var(--red)"; el.style.borderColor = "var(--red)"; }
}, 1000);
var $ = function(id){ return document.getElementById(id); };
var fmt = function(n,d){ return Number(n).toLocaleString(undefined,{maximumFractionDigits:(d===undefined?2:d)}); };
function gaugeColor(pct){ return pct>=0.9?"var(--red)":(pct>=0.7?"var(--amber)":"var(--green)"); }

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
  var chip = $("chip2"), gate = $("gate");
  chip.textContent = side.toUpperCase()+" "+size+" "+market;
  chip.style.transition = "none";
  chip.style.left = "10px"; chip.style.top = "52px"; chip.style.opacity = "0";
  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    chip.style.transition = "all 0.45s ease"; chip.style.opacity = "1"; chip.style.left = "44px";
  });});
  var i = 0;
  var iv = setInterval(function(){
    if (i >= trace.length) {
      clearInterval(iv);
      var st = $("stamp");
      st.textContent = decision === "allow" ? "ALLOWED" : "DENIED";
      st.className = "show " + (decision === "allow" ? "allowed" : "denied");
      chip.style.left = (gate.clientWidth - chip.offsetWidth - 44) + "px";
      setTimeout(function(){ chip.style.opacity = "0"; state.busy = false; }, 1400);
      return;
    }
    lightRule(trace[i]); i++;
  }, 240);
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
  if (kind === "tamper") { fetch("/v1/demo/tamper", {method:"POST"}).finally(function(){ setTimeout(done, 600); }); return; }
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
    step(); return;
  }
  fetch("/v1/intents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(intentFor(kind, state.tradeMarket))})
    .finally(function(){ setTimeout(done, 800); });
}
document.querySelectorAll("button.scn").forEach(function(b){
  b.addEventListener("click", function(){ fire(b.getAttribute("data-s")); });
});
$("ovBtn").onclick = function(){
  // Preferred path: the operator signs — cryptographic proof of humanity.
  var eth = walletProvider();
  if (state.wallet && eth) {
    var msg = "VetoOS human unfreeze\\n" + new Date().toISOString();
    toast("check your wallet to sign the unfreeze message…");
    eth.request({ method: "personal_sign", params: [msg, state.wallet] })
      .then(function(sig){
        return fetch("/v1/unfreeze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: state.wallet, message: msg, signature: sig }),
        });
      })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.error) toast(res.error);
        else toast("unfrozen by wallet signature");
        refresh();
      })
      .catch(function(){ toast("signature rejected — stays frozen, correctly"); });
    return;
  }
  // Fallback: local human token (judges without a wallet).
  fetch("/v1/unfreeze", { method: "POST", headers: { "x-vetoos-human": "I_AM_HUMAN" } }).then(refresh);
};

function feedLine(ev) {
  var d = ev.data || {};
  var cls = "other", txt = ev.type;
  if (ev.type === "decision") {
    var code = d.code || (d.validationError ? "INVALID" : "?");
    cls = (d.decision === "allow") ? "allow" : "deny";
    txt = (d.decision || "deny").toUpperCase() + " · " + code + (d.duplicate ? " · DUP" : "");
    txt += " — " + (d.message_zh || d.error || "");
  } else if (ev.type === "order_placed") { cls = "allow"; txt = "FILL " + d.filledSize + " @ " + d.avgPx + " (oid " + d.oid + ")"; }
  else if (ev.type === "freeze") { cls = "freezeEv"; txt = "FROZEN — " + (d.reason || ""); }
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

function setGauge(id, idV, used, cap, suffix) {
  var pct = cap > 0 ? used / cap : 0;
  $(id).style.width = Math.min(pct * 100, 100) + "%";
  $(id).style.background = gaugeColor(pct);
  $(idV).textContent = suffix ? used + suffix : (used + "/" + cap);
}

var equitySeries = [];
function drawSpark() {
  var svg = $("spark");
  if (equitySeries.length < 2) { svg.innerHTML = ""; return; }
  var vals = equitySeries.map(function(p){ return p.v; });
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  var span = (max - min) || 1;
  var pts = equitySeries.map(function(p, i){
    var x = i / (equitySeries.length - 1) * 300;
    var y = 54 - ((p.v - min) / span) * 48;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  var up = vals[vals.length - 1] >= vals[0];
  svg.innerHTML = '<polyline points="' + pts + '" fill="none" stroke="' +
    (up ? "#3fb950" : "#f85149") + '" stroke-width="1.6"/>';
}

function refresh() {
  Promise.all([
    fetch("/v1/status").then(function(r){return r.json();}),
    fetch("/v1/account").then(function(r){return r.json();}),
    fetch("/v1/feed?n=60").then(function(r){return r.json();}),
    fetch("/v1/market").then(function(r){return r.json();}),
    fetch("/v1/risk").then(function(r){return r.json();}),
    fetch("/v1/execution").then(function(r){return r.json();}),
    fetch("/v1/stats").then(function(r){return r.json();}),
    fetch("/v1/counterfactual").then(function(r){return r.json();}),
  ]).then(function(all){
    var status = all[0], account = all[1], feed = all[2], market = all[3], risk = all[4],
        execution = all[5], stats = all[6], cf = all[7];
    state.lastOk = Date.now();
    state.tradeMarket = status.tradeMarket || "BTC";
    $("policy").textContent = "policy " + String(status.policyHash||"").slice(0,12) + "…";
    $("gatehash").textContent = "sha256 " + String(status.policyHash||"").slice(0,16) + "…";
    $("nets").textContent = status.tradeMarket + " · read " + status.readNetwork + " · write " + status.writeNetwork;

    var h = market.hip3 || {};
    $("hipChip").textContent = (h.market || "HIP-3").split(":")[0];
    $("hipName").textContent = " " + (h.market || "");
    $("hipMark").firstChild.nodeValue = h.markPx ? fmt(h.markPx, 2) : "–";
    $("hipFund").textContent = h.funding !== undefined ? (h.funding * 100).toFixed(5) + "%" : "–";
    $("hipOi").textContent = h.openInterest !== undefined ? fmt(h.openInterest, 3) : "–";
    $("hipAsset").textContent = h.assetId !== undefined ? h.assetId : "–";
    $("hipDepthB").textContent = h.depthBuy !== undefined ? fmt(h.depthBuy, 4) : "–";
    $("hipDepthA").textContent = h.depthSell !== undefined ? fmt(h.depthSell, 4) : "–";
    var dMax = Math.max(h.depthBuy || 0, h.depthSell || 0, 1);
    $("hipDepthBBar").style.width = ((h.depthBuy || 0) / dMax * 100) + "%";
    $("hipDepthABar").style.width = ((h.depthSell || 0) / dMax * 100) + "%";
    $("tradeMark").textContent = (market.trade || {}).market + " @ " + fmt((market.trade || {}).markPx || 0, 1);

    $("equity").textContent = "$" + fmt(account.equityUsd);
    $("avail").textContent = "$" + fmt(account.availableMarginUsd);
    $("pos").textContent = Number(account.positionSize).toFixed(6) + " " + (account.tradeMarket || "");

    // execution panel: position detail + venue fills
    var pd = execution.position;
    $("posEntry").textContent = pd ? fmt(pd.entryPx, 1) : "–";
    if (pd) {
      $("posUpnl").textContent = (pd.unrealizedPnl >= 0 ? "+$" : "-$") + fmt(Math.abs(pd.unrealizedPnl));
      $("posUpnl").className = "v mono " + (pd.unrealizedPnl >= 0 ? "pnl-pos" : "pnl-neg");
    } else { $("posUpnl").textContent = "–"; $("posUpnl").className = "v mono"; }
    $("fills").innerHTML = (execution.fills || []).length
      ? execution.fills.map(function(f){
          var t = new Date(f.ts).toISOString().slice(11, 19);
          return '<div class="fillrow"><span class="' + (f.side === "B" ? "b" : "s") + '">' +
            (f.side === "B" ? "BUY" : "SELL") + '</span><span class="mono">' + f.size + " " + f.coin +
            '</span><span class="mono">@ ' + fmt(f.px, 1) + '</span><span class="mono" style="color:#48576e">' + t + "</span></div>";
        }).join("")
      : '<div class="noalerts">no fills yet this session</div>';

    // equity sparkline (session window)
    equitySeries.push({ t: Date.now(), v: Number(account.equityUsd) });
    if (equitySeries.length > 120) equitySeries.shift();
    drawSpark();

    // stats panel
    $("stAllow").textContent = stats.allow || 0;
    $("stDeny").textContent = stats.deny || 0;
    $("stFill").textContent = stats.fills || 0;
    $("stFrz").textContent = stats.freeze || 0;
    var codes = Object.keys(stats.byCode || {});
    var maxC = Math.max.apply(null, codes.map(function(c){ return stats.byCode[c]; }).concat([1]));
    $("bycode").innerHTML = codes.length
      ? codes.sort(function(a,b){ return stats.byCode[b] - stats.byCode[a]; }).map(function(c){
          var w = Math.max(4, stats.byCode[c] / maxC * 100);
          return '<div class="bc"><span class="nm mono">' + c + '</span><span class="bb" style="width:' + w + '%"></span><span class="ct">' + stats.byCode[c] + "</span></div>";
        }).join("")
      : '<div class="noalerts">no denials yet</div>';

    // counterfactual panel
    $("cfSaved").textContent = "$" + fmt(cf.avoidedLoss);
    $("cfSaved").style.color = cf.avoidedLoss > 0 ? "var(--green)" : "var(--dim)";
    $("cfNotional").textContent = "$" + fmt(cf.grossNotional);
    $("cfLev").textContent = cf.worstLeverage > 0 ? cf.worstLeverage.toFixed(1) + "x equity" : "–";
    $("cfMissed").textContent = "$" + fmt(cf.missedGain);
    $("cfrows").innerHTML = (cf.rows || []).length
      ? cf.rows.slice().reverse().map(function(r){
          var cls = r.pnl >= 0 ? "pnl-pos" : "pnl-neg";
          var pv = (r.pnl >= 0 ? "+$" : "-$") + fmt(Math.abs(r.pnl));
          return '<div class="cfrow"><span class="t mono">' + r.ts.slice(11, 19) + '</span><span class="m">' +
            r.side.toUpperCase() + " " + r.size + " " + r.market + ' <span style="color:#48576e">[' + r.code + "]</span></span>" +
            '<span class="mono" style="color:#48576e">' + fmt(r.entryPx, 1) + "→" + fmt(r.nowPx, 1) + '</span>' +
            '<span class="p mono ' + cls + '">' + pv + "</span></div>";
        }).join("")
      : '<div class="noalerts">no denied intents yet — fire the oversized scenario</div>';

    var g = risk.gauges || {};
    if (g.fomo_adds) setGauge("#gFomo", "#gFomoV", g.fomo_adds.used, g.fomo_adds.cap);
    if (g.rate_per_min) setGauge("#gRate", "#gRateV", g.rate_per_min.used, g.rate_per_min.cap);
    if (g.daily_loss) setGauge("#gLoss", "#gLossV", g.daily_loss.used, g.daily_loss.cap);
    if (g.margin_use) { setGauge("#gMargin", "#gMarginV", g.margin_use.pct * 100, 100); $("gMarginV").textContent = (g.margin_use.pct * 100).toFixed(0) + "%"; }
    if (g.cooldown) {
      var cd = g.cooldown;
      var frac = cd.capS > 0 ? 1 - cd.remainingS / cd.capS : 1;
      $("gCool").style.width = (frac * 100) + "%";
      $("gCool").style.background = cd.remainingS > 0 ? "var(--amber)" : "var(--green)";
      $("gCoolV").textContent = cd.remainingS > 0 ? cd.remainingS + "s" : "idle";
    }

    var alerts = risk.alerts || [];
    $("alertCount").textContent = alerts.length;
    $("alerts").innerHTML = alerts.length
      ? alerts.map(function(a){ return '<div class="alert"><span class="lvl '+a.level+'">'+a.level.toUpperCase()+'</span><span class="txt">'+a.text+'</span></div>'; }).join("")
      : '<div class="noalerts">no active alerts — nominal</div>';

    $("overlay").style.display = status.frozen ? "flex" : "none";
    $("statusDot").className = status.frozen ? "frozen" : "";
    $("statusText").textContent = status.frozen ? "FROZEN" : "OPERATIONAL";
    if (status.frozen) $("ovReason").textContent = status.freezeReason || "";
    $("truthV").textContent = status.frozen ? "MISMATCH" : "CLEAN";
    $("truthV").style.color = status.frozen ? "var(--red)" : "var(--green)";
    $("truth").className = "panel truth" + (status.frozen ? " bad" : "");

    var events = feed.events || [];
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
