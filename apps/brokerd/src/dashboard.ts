/**
 * VetoOS Risk Terminal — a trading-terminal-grade console:
 *   left rail : live HIP-3 mainnet market data + scenario simulator
 *   center    : THE GATE (rule pipeline) + risk utilization gauges
 *   right rail: risk alerts + venue account
 * Everything is live: scenario buttons fire real intents, the gate replays
 * the engine's own trace, alerts derive from the same counters the rules use.
 */

export function renderDashboard(build = "dev"): string {
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
  .creed { display: flex; justify-content: space-between; gap: 18px; align-items: flex-end;
           border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-top: 12px; }
  .creed-kicker { font-size: 18px; font-weight: 650; letter-spacing: -0.02em; }
  .creed-sub { color: var(--dim); font-size: 12px; margin-top: 4px; max-width: 680px; }
  .creed-metric { text-align: right; }
  .creed-metric .cfnum { font-size: 28px; font-weight: 750; }
  .compare { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
             margin-top: 8px; font-size: 12px; color: var(--dim); }
  .compare b { color: var(--fg); font-weight: 600; }
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
             display: flex; align-items: center; justify-content: center; text-align: center; }
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
  .radarwrap { display: flex; justify-content: center; }
  #radar { width: 100%; max-width: 340px; }
  .aihero { display: flex; align-items: baseline; gap: 12px; }
  .ainum { font-size: 34px; font-weight: 900; }
  .ailvl .chip { font-size: 10px; padding: 2px 8px; }
  .ailvl .low { background: rgba(63,185,80,0.14); color: var(--green); }
  .ailvl .moderate { background: rgba(34,211,238,0.12); color: var(--accent); }
  .ailvl .high { background: rgba(210,153,34,0.16); color: var(--amber); }
  .ailvl .critical { background: rgba(248,81,73,0.16); color: var(--red); }
  .aicomment { margin-top: 8px; font-size: 11.5px; }
  .aicomment.en { color: var(--dim); font-size: 10.5px; margin-top: 3px; }
  .aidisclaimer { margin-top: 8px; font-size: 9.5px; color: #48576e; }
  .foot { margin-top: 20px; color: var(--dim); font-size: 10.5px; }
  a { color: var(--accent); text-decoration: none; }
  @media (max-width: 740px) {
    .dashrow { grid-template-columns: 1fr; }
    .creed { flex-direction: column; align-items: flex-start; }
    .creed-metric { text-align: left; }
  }

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
    <span class="badge mono" id="chain" title="sha256 hash-chained audit JSONL (GET /v1/audit/verify)">audit chain …</span>
    <span class="badge mono" title="build hash — hard-refresh if this is stale">${build}</span>
  </header>
  <div class="creed">
    <div>
      <div class="creed-kicker">Don't trust the agent. Verify the fill.</div>
      <div class="creed-sub">Models propose. A deterministic gate is the only signer. The venue's own state is the only truth about fills. The advisory score cannot place an order.</div>
    </div>
    <div class="creed-metric">
      <div class="cfnum mono" id="cfSavedHero">$0.00</div>
      <div class="dashlabel">loss blocked by vetoes</div>
    </div>
  </div>
  <div class="compare" id="compare">
    <span>model wanted <b id="cmpWanted">waiting for a proposal</b></span>
    <span>rule allows <b id="cmpCap">—</b></span>
    <span class="mono" id="cmpCode"></span>
  </div>

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
        <div class="phead"><span>Simulator</span><span class="chip test" id="simChip">LIVE — CONFIRM</span></div>
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
        <div class="phead"><span>Risk radar · live gate dimensions</span><span class="chip hip" id="radarSrc">–</span></div>
        <div class="pbody radarwrap"><svg id="radar" viewBox="0 0 320 300"></svg></div>
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
        <div class="phead"><span>AI risk score · advisory</span><span class="chip hip" id="aiSrc">–</span></div>
        <div class="pbody">
          <div class="aihero">
            <div class="ainum mono" id="aiScore">–</div>
            <div class="ailvl"><span class="chip" id="aiLevel">–</span></div>
          </div>
          <div class="aicomment" id="aiCommentEn">–</div>
          <div class="aicomment en" id="aiCommentZh">–</div>
          <div class="aidisclaimer">AI summarizes deterministic counters only — it never decides allow/deny.</div>
        </div>
      </div>
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

<div id="overlayHost"></div>

<script>
var RULES = ["freeze","market_data","oracle_distance","allowed_market","notional","leverage","daily_loss","cooldown","same_side_adds","rate_limit","book_depth","margin"];
var RULE_LABEL = {freeze:"global freeze",market_data:"real market data",oracle_distance:"oracle distance",allowed_market:"allowed market",notional:"notional cap",leverage:"leverage cap",daily_loss:"daily-loss breaker",cooldown:"post-deny cool-down",same_side_adds:"FOMO same-side adds",rate_limit:"order frequency",book_depth:"book capacity",margin:"margin check"};
var TOKEN = "";
try { TOKEN = new URLSearchParams(location.search).get("token") || ""; } catch (e) {}
function postHeaders() {
  var h = { "content-type": "application/json" };
  if (TOKEN) h["x-vetoos-token"] = TOKEN;
  return h;
}
// All reads go through here so an optional read-guard token is honoured too.
function get(url) { return fetch(url, TOKEN ? { headers: { "x-vetoos-token": TOKEN } } : undefined).then(function(r){ return r.json(); }); }
// Every value interpolated into innerHTML is escaped — intents are untrusted input.
function esc(v) {
  return String(v === undefined || v === null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var state = { lastKey: null, busy: false, tradeMarket: "BTC", lastOk: 0, offline: false };
setInterval(function(){
  var el = $("fresh"); if (!el) return;
  var age = state.lastOk ? Math.round((Date.now() - state.lastOk) / 1000) : 99;
  if (age <= 8) { el.textContent = "LIVE · " + age + "s"; el.style.color = "var(--green)"; el.style.borderColor = "var(--green)"; }
  else { el.textContent = "STALE · " + age + "s"; el.style.color = "var(--red)"; el.style.borderColor = "var(--red)"; }
}, 1000);
var $ = function(id){ return document.getElementById(id.charAt(0) === "#" ? id.slice(1) : id); };
var fmt = function(n,d){ return Number(n).toLocaleString(undefined,{maximumFractionDigits:(d===undefined?2:d)}); };
function gaugeColor(pct){ return pct>=0.9?"var(--red)":(pct>=0.7?"var(--amber)":"var(--green)"); }

function buildPipe() {
  $("pipe").innerHTML = RULES.map(function(r){
    return '<div class="rule" id="rule-'+esc(r)+'"><div class="light"></div><div class="rn mono">'+esc(RULE_LABEL[r])+'</div><div class="dt"></div></div>';
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
  if (kind === "tamper") { fetch("/v1/demo/tamper", {method:"POST", headers:postHeaders()}).finally(function(){ setTimeout(function(){ done(); refresh(); }, 600); }); return; }
  if (kind === "fomo") {
    var n = 0;
    var step = function(){
      if (n >= 4) { done(); return; }
      n++;
      fetch("/v1/intents",{method:"POST",headers:postHeaders(),body:JSON.stringify(intentFor("fomo", state.tradeMarket))})
        .then(function(r){ return r.json(); })
        .then(function(res){
          var code = res.decision && res.decision.code;
          if (code === "FOMO_SAME_SIDE_ADDS" || code === "FOMO_COOLDOWN") { done(); return; }
          setTimeout(step, 750);
        }).catch(function(){ done(); });
    };
    step(); return;
  }
  fetch("/v1/intents",{method:"POST",headers:postHeaders(),body:JSON.stringify(intentFor(kind, state.tradeMarket))})
    .finally(function(){ setTimeout(function(){ done(); refresh(); }, 800); });
}
document.querySelectorAll("button.scn").forEach(function(b){
  b.addEventListener("click", function(){
    var kind = b.getAttribute("data-s");
    if (!state.offline) {
      var ok = window.confirm("LIVE testnet: this button sends a real intent (or freezes the broker). Continue?");
      if (!ok) return;
    }
    fire(kind);
  });
});
function bindUnfreeze() {
  var btn = $("ovBtn");
  if (!btn) return;
  btn.onclick = function(){
    var uh = postHeaders(); uh["x-vetoos-human"] = "I_AM_HUMAN";
    fetch("/v1/unfreeze", { method: "POST", headers: uh }).then(refresh);
  };
}
function renderOverlay(status) {
  var host = $("overlayHost");
  if (!status.frozen) { host.innerHTML = ""; return; }
  if (!$("ovBtn")) {
    host.innerHTML = '<div id="overlay"><div class="box"><h2>BROKER FROZEN</h2><p id="ovReason"></p>' +
      '<p style="color:#a78">Ledger and venue disagree. The brake cannot be argued with —<br/>only a human can release it.</p>' +
      '<button id="ovBtn">I AM HUMAN — UNFREEZE</button></div></div>';
    bindUnfreeze();
  }
  $("ovReason").textContent = status.freezeReason || "";
}

function paintCompare(feed, policyDoc) {
  var capFallback = policyDoc && policyDoc.policy ? policyDoc.policy.max_order_notional_usd : 0;
  var events = (feed && feed.events) || [];
  var last = null;
  for (var i = events.length - 1; i >= 0; i--) {
    var ev = events[i];
    if (ev.type === "decision" && ev.data && ev.data.snapshot) { last = ev.data; break; }
  }
  if (!last) {
    $("cmpWanted").textContent = "waiting for a proposal";
    $("cmpCap").textContent = capFallback ? "≤ $" + fmt(capFallback) + " notional" : "—";
    $("cmpCode").textContent = "";
    return;
  }
  var s = last.snapshot;
  var cap = s.allowed_notional_usd || capFallback;
  $("cmpWanted").textContent = String(s.side || "").toUpperCase() + " " + (s.size || "") + " " + (s.market || "") + " · ~$" + fmt(s.notional_usd || 0);
  $("cmpCap").textContent = cap ? "≤ $" + fmt(cap) + " notional" : "—";
  $("cmpCode").textContent = last.code || "";
  $("cmpCode").style.color = last.decision === "allow" ? "var(--green)" : "var(--red)";
}
function feedLine(ev) {
  var d = ev.data || {};
  var cls = "other", txt = ev.type;
  if (ev.type === "decision") {
    var code = d.code || (d.validationError || d.error ? "INVALID" : "?");
    cls = (d.decision === "allow") ? "allow" : "deny";
    txt = (d.decision || "deny").toUpperCase() + " · " + code + (d.duplicate ? " · DUP" : "") + (d.late_freeze_check ? " · LATE-FREEZE" : "");
    txt += " — " + (d.message_zh || d.error || "");
  } else if (ev.type === "order_placed") {
    cls = d.filledSize > 0 ? "allow" : "other";
    txt = (d.filledSize > 0 ? "FILL " + d.filledSize + " @ " + d.avgPx : "NO FILL (" + (d.status || "?") + ")") + " (oid " + d.oid + ")";
  }
  else if (ev.type === "freeze") { cls = "freezeEv"; txt = "FROZEN — " + (d.reason || ""); }
  else if (ev.type === "reconcile") { txt = "reconcile " + (d.ok ? "OK" : "MISMATCH") + " (" + d.market + ")"; }
  else if (ev.type === "unfreeze") { cls = "allow"; txt = "human unfreeze"; }
  else if (ev.type === "startup") { txt = "startup · policy loaded · real ctx " + (d.market || ""); }
  else if (ev.type === "error") { cls = "deny"; txt = "ERROR · " + (d.where || "") + " — " + (d.error || d.note || ""); }
  return '<div class="row"><span class="t">'+esc((ev.ts||"").slice(11,19))+'</span><span class="'+cls+'" title="#'+esc(ev.seq)+'">'+esc(txt)+'</span></div>';
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
  $(idV).textContent = suffix ? fmt(used) + suffix : (fmt(used) + "/" + fmt(cap));
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

var refreshing = false;
function refresh() {
  // One unified refresher; the server caches venue reads (2.5s–30s), so the
  // 2s poll costs local file reads only. Skips while hidden or still in flight.
  if (document.hidden || refreshing) return;
  refreshing = true;
  Promise.all([
    get("/v1/status"),
    get("/v1/account"),
    get("/v1/feed?n=60"),
    get("/v1/market"),
    get("/v1/risk"),
    get("/v1/execution"),
    get("/v1/stats"),
    get("/v1/counterfactual"),
    get("/v1/policy"),
  ]).then(function(all){
    var status = all[0], account = all[1], feed = all[2], market = all[3], risk = all[4],
        execution = all[5], stats = all[6], cf = all[7], policyDoc = all[8];
    state.lastOk = Date.now();
    state.tradeMarket = status.tradeMarket || "BTC";
    state.offline = status.offline === true;
    $("simChip").textContent = state.offline ? "OFFLINE — ONE CLICK" : "LIVE — CONFIRM";
    $("policy").textContent = "policy " + String(status.policyHash||"").slice(0,12) + "…";
    $("gatehash").textContent = "sha256 " + String(status.policyHash||"").slice(0,16) + "…";
    $("nets").textContent = status.offline
      ? status.tradeMarket + " · OFFLINE FIXTURE VENUE (no real orders)"
      : status.tradeMarket + " · read " + status.readNetwork + " · write " + status.writeNetwork;
    $("nets").style.color = status.offline ? "var(--amber)" : "";
    var ch = status.auditChain || {};
    $("chain").textContent = ch.ok === false ? "audit chain BROKEN @" + ch.brokenAt : "audit chain OK · " + (ch.length || 0);
    $("chain").style.color = ch.ok === false ? "var(--red)" : "var(--dim)";

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
            (f.side === "B" ? "BUY" : "SELL") + '</span><span class="mono">' + esc(f.size) + " " + esc(f.coin) +
            '</span><span class="mono">@ ' + esc(fmt(f.px, 1)) + '</span><span class="mono" style="color:#48576e">' + esc(t) + "</span></div>";
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
          return '<div class="bc"><span class="nm mono">' + esc(c) + '</span><span class="bb" style="width:' + w + '%"></span><span class="ct">' + esc(stats.byCode[c]) + "</span></div>";
        }).join("")
      : '<div class="noalerts">no denials yet</div>';

    // counterfactual panel
    $("cfSaved").textContent = "$" + fmt(cf.avoidedLoss);
    $("cfSaved").style.color = cf.avoidedLoss > 0 ? "var(--green)" : "var(--dim)";
    $("cfSavedHero").textContent = $("cfSaved").textContent;
    $("cfSavedHero").style.color = $("cfSaved").style.color;
    paintCompare(feed, policyDoc);
    $("cfNotional").textContent = "$" + fmt(cf.grossNotional);
    $("cfLev").textContent = cf.worstLeverage > 0 ? cf.worstLeverage.toFixed(1) + "x equity" : "–";
    $("cfMissed").textContent = "$" + fmt(cf.missedGain);
    $("cfrows").innerHTML = (cf.rows || []).length
      ? cf.rows.slice().reverse().map(function(r){
          var cls = r.pnl >= 0 ? "pnl-pos" : "pnl-neg";
          var pv = (r.pnl >= 0 ? "+$" : "-$") + fmt(Math.abs(r.pnl));
          return '<div class="cfrow"><span class="t mono">' + esc(r.ts.slice(11, 19)) + '</span><span class="m">' +
            esc(r.side.toUpperCase()) + " " + esc(r.size) + " " + esc(r.market) + ' <span style="color:#48576e">[' + esc(r.code) + "]</span></span>" +
            '<span class="mono" style="color:#48576e">' + esc(fmt(r.entryPx, 1)) + "→" + esc(fmt(r.nowPx, 1)) + '</span>' +
            '<span class="p mono ' + cls + '">' + esc(pv) + "</span></div>";
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
      ? alerts.map(function(a){ var lv = a.level === "crit" || a.level === "warn" ? a.level : "info"; return '<div class="alert"><span class="lvl '+lv+'">'+esc(lv.toUpperCase())+'</span><span class="txt">'+esc(a.text)+'</span></div>'; }).join("")
      : '<div class="noalerts">no active alerts — nominal</div>';

    renderOverlay(status);
    $("statusDot").className = status.frozen ? "frozen" : "";
    $("statusText").textContent = status.frozen ? "FROZEN" : "OPERATIONAL";
    $("truthV").textContent = status.frozen ? "MISMATCH" : "CLEAN";
    $("truthV").style.color = status.frozen ? "var(--red)" : "var(--green)";
    $("truth").className = "panel truth" + (status.frozen ? " bad" : "");

    var events = feed.events || [];
    $("feed").innerHTML = events.slice().reverse().map(feedLine).join("") ||
      '<div class="row"><span class="t">--:--:--</span><span class="other">idle — fire a scenario on the left</span></div>';
    handleNewEvents(events);
    $("clock").textContent = new Date().toISOString().slice(11,19) + "Z";
  }).catch(function(){}).finally(function(){ refreshing = false; });
}

// ---- risk radar + AI advisory score ----
var LEVEL_COLOR = { low: "var(--green)", moderate: "var(--accent)", high: "var(--amber)", critical: "var(--red)" };
function radarPoint(cx, cy, r, i, n) {
  var a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function drawRadar(axes) {
  var cx = 160, cy = 150, R = 100, n = axes.length;
  var s = "";
  [1 / 3, 2 / 3, 1].forEach(function(f) {
    var pts = [];
    for (var i = 0; i < n; i++) pts.push(radarPoint(cx, cy, R * f, i, n).join(","));
    s += '<polygon points="' + pts.join(" ") + '" fill="none" stroke="#1b2637" stroke-width="1" stroke-dasharray="' + (f === 1 ? "0" : "3,3") + '"/>';
  });
  for (var i = 0; i < n; i++) {
    var p = radarPoint(cx, cy, R, i, n);
    s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0] + '" y2="' + p[1] + '" stroke="#182335" stroke-width="1"/>';
  }
  var poly = axes.map(function(a, i) {
    var p = radarPoint(cx, cy, (R * Math.max(a.value, 2)) / 100, i, n);
    return p[0].toFixed(1) + "," + p[1].toFixed(1);
  }).join(" ");
  s += '<polygon points="' + poly + '" fill="rgba(34,211,238,0.16)" stroke="#22d3ee" stroke-width="2"/>';
  axes.forEach(function(a, i) {
    var p = radarPoint(cx, cy, (R * Math.max(a.value, 2)) / 100, i, n);
    s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="#22d3ee"/>';
    var lp = radarPoint(cx, cy, R + 22, i, n);
    var anchor = Math.abs(lp[0] - cx) < 20 ? "middle" : lp[0] > cx ? "start" : "end";
    s += '<text x="' + lp[0] + '" y="' + lp[1] + '" text-anchor="' + anchor + '" font-size="9.5" fill="#7d8ba0">' + esc(a.label) + "</text>";
    var vp = radarPoint(cx, cy, R + 36, i, n);
    var col = a.value >= 85 ? "#f85149" : a.value >= 60 ? "#d29922" : "#22d3ee";
    s += '<text x="' + vp[0] + '" y="' + vp[1] + '" text-anchor="' + anchor + '" font-size="10" font-weight="700" fill="' + col + '">' + (a.unknown ? "?" : esc(a.value)) + "</text>";
  });
  s += '<circle cx="' + cx + '" cy="' + cy + '" r="2.5" fill="#7d8ba0"/>';
  $("radar").innerHTML = s;
}
function pollAiRisk() {
  if (document.hidden) return;
  get("/v1/ai-risk").then(function(rep) {
    if (!rep || !rep.axes) return;
    drawRadar(rep.axes);
    $("radarSrc").textContent = rep.source === "llm" ? "AI+rules" : "rules counters";
    $("aiScore").textContent = rep.score;
    $("aiScore").style.color = LEVEL_COLOR[rep.level] || "var(--fg)";
    $("aiLevel").textContent = (rep.level || "?").toUpperCase();
    $("aiLevel").className = "chip " + rep.level;
    $("aiSrc").textContent = rep.source === "llm" ? "LLM" : "heuristic";
    $("aiCommentZh").textContent = rep.comment_zh || "";
    $("aiCommentEn").textContent = rep.comment_en || "";
  }).catch(function(){});
}

buildPipe();
refresh();
setInterval(refresh, 2000);
pollAiRisk();
setInterval(pollAiRisk, 15000);
document.addEventListener("visibilitychange", function(){ if (!document.hidden) { refresh(); pollAiRisk(); } });
</script>
</body>
</html>`;
}
