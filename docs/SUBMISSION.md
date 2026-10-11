# Colosseum Crypto World's Fair — Submission Pack (VetoOS)

Working document for the submission portal. Binding source:
[Official Rules](https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf).
Everything submitted must be in **English** (§12(a)(i)).

> **Hard deadline: 2026-10-12 23:59 PT = 2026-10-13 06:59 UTC = 2026-10-13 14:59 Beijing.**
> (PT is UTC−7 in October — PDT.) Plan to submit by 2026-10-13 12:00 Beijing at the latest.

## 0. Compliance checklist

- [ ] Every team member registered on colosseum.com **before 2026-10-12 23:59 PT** (§6a)
- [ ] Team leader uploads the Project Submission before the deadline (§6b)
- [ ] All portal content in English (§12(a)(i))
- [ ] Product name + brief description
- [ ] Blockchains & tools integrated (answer below)
- [ ] All teammates + backgrounds + location
- [ ] Product logo (`assets/logo.svg`, export PNG 1024×1024)
- [ ] GitHub repo link — public (open-source encouraged) or grant hackathon@colosseum.com
- [ ] Presentation video, 2–3 minutes
- [ ] Product demo video, ≤ 3 minutes
- [ ] GTM strategy + demand validation + distribution plan
- [ ] Prior-development disclosure (§/FAQ: judged only on work inside the contest window)
- [ ] No Colosseum trademarks used without consent (§17)

## 1. Portal answers (drafts)

### Product name
VetoOS

### Brief description
VetoOS is an open-source risk-control OS for Hyperliquid HIP-3: AI agents and
strategies may propose trades, but a deterministic rule engine is the only
component that can sign. Every fill is reconciled against the venue's real
positions, and any mismatch freezes the broker. Rules outrank models; fills
outrank claims.

### Blockchains and tools integrated
- **Hyperliquid (Hypercore)** — HIP-3 builder perp dexes: `perpDexs`,
  `metaAndAssetCtxs { dex }`, `l2Book`, `clearinghouseState { dex }`, `userFills`,
  `openOrders` (mainnet reads drive vetoes); Exchange API order placement with
  HIP-3 asset-id mapping, client order ids and venue price/lot rules on testnet
  (real main-dex BTC fills and a real builder-dex `xyz:XYZ100` fill — see
  [EVIDENCE.md](EVIDENCE.md)); `sendAsset` to fund a builder dex;
  builder-code attribution placeholder.
- TypeScript monorepo: `@nktkas/hyperliquid`, viem (EIP-191 unfreeze), zod, vitest, pnpm.

### Hyperliquid-track alignment (what the resources page asks for)
- **Asset IDs.** HIP-3: `100000 + dexIndex * 10000 + metaIndex`. `xyz:XYZ100` is `110000` on mainnet (dex 1) and `750000` on testnet (dex 65). Main-dex BTC is plain index `0`.
- **Tick and lot.** Prices rounded to ≤ 5 significant figures and ≤ `6 − szDecimals` decimals before signing. Sizes floored to the lot, with the float-boundary snap so `0.0012` does not become `0.0011`.
- **Oracle band.** A caller limit more than `max_oracle_deviation_bps` (default 500) from the mark is denied in the trace (`ORACLE_DEVIATION`) instead of being rejected by the venue after signing. Market orders are clamped to the same band by the adapter.
- **Agent wallet and nonces.** One agent key, only inside the broker process. `brokerd.lock` is the single writer, so two processes cannot race nonces on the same account. Concurrent duplicate intent ids share one in-flight order and one venue `cloid`.
- **Info vs Exchange.** Vetoes read mainnet info (`perpDexs`, `metaAndAssetCtxs`, `l2Book`). Fills are testnet exchange actions. Builder dexes use their own `clearinghouseState { dex }`.
- **Streams.** Fill truth is a 60s reconcile loop plus per-order position snapshots, not a WebSocket. That is deliberate fail-closed polling; a reconnecting `userFills` stream is filed as a follow-up, not claimed as done.
- **Builder code.** Optional on every order via `HL_BUILDER_ADDRESS` and `HL_BUILDER_FEE_TENTHS_BPS`. Unset means the field is omitted — we do not invent an address.

### Team
- **TODO (needs the team's own words — cannot be invented):** one line per member:
  name · background (e.g. "quant dev, 5y market-making infra") · city/country.
  Also decide who is the **team leader** who uploads the submission (§6b).

### Logo
`assets/logo.svg` and `assets/logo.png` (1024×1024) — the brake with a checkmark. Upload the PNG.

### Repository
https://github.com/rectinajh/vetoos — public, MIT. Prior-development disclosure below.

### Prior-development disclosure (FAQ requirement)
This project was bootstrapped on 2026-10-10 inside the contest window
(2026-09-14 → 2026-10-12). All code, docs, and demos were written within the
window (git history: first commit 2026-10-10). Third-party code: runtime
dependencies (`@nktkas/hyperliquid`, viem, zod, dotenv) and dev dependencies
(typescript, tsx, vitest) under their own licenses; no pre-existing project
code was reused.

## 2. Judging-criteria map (§8) — what to say where

| Criterion | Our answer | Where it shows |
|---|---|---|
| Functionality | Working broker as a SERVICE: HTTP API, idempotent + concurrency-safe submissions (venue cloid), allow→real fill→reconcile, deny paths, freeze, background session reconcile, hash-chained audit; 121 tests green incl. route-level tests | demo video, repo, [EVIDENCE.md](EVIDENCE.md) |
| Potential impact | Every bot/AI trading on HL needs a trustworthy kill switch; HIP-3 multiplies the venues that need it; policy templates make it usable day one | pitch video, GTM |
| Novelty | Power structure is the product: proposal/veto separation + fill-truth layer + anti-FOMO guards; reference AI proposer shows both ends of the paradigm; AI radar is advisory only | pitch video |
| UX | Risk-terminal console: live gate animation per rule, risk radar, counterfactual "loss blocked", freeze takeover; plain-language bilingual deny reasons; human-only unfreeze | console screenshot, demo video |
| Open-source | MIT; typed client + 5-line TS/Python examples + OpenAPI + policy templates — any strategy plugs in; offline demo for judges | repo |
| Business plan | Open core · builder-code bps on routed flow · hosted subscription for teams/funds | §3 below |

## 3. Business plan, GTM and demand validation

### Who pays, and for what

| Tier | Who | What they get | Price |
|---|---|---|---|
| **Open core** (free, MIT) | individual quants, bot builders, open-source trading tools | the broker, engine, console, templates, client | $0 — self-hosted |
| **Builder-code attribution** | everyone whose flow is routed through VetoOS | nothing extra — the venue pays us | **builder fee 1–2 bps** on routed notional (Hyperliquid builder codes; set by the operator, capped by the venue). Illustrative: $50M/month routed ≈ $5–10k/month |
| **Hosted VetoOS** | small trading teams, prop desks, AI-agent operators | managed brokerd, read-only investor console, alerting (freeze / breaker / resting-order), policy versioning & approvals, retention of the hash-chained audit log | **$299–$999 / month per account** |
| **Funds / institutions** | multi-account, compliance-driven | multi-sig unfreeze, SSO, custom rule packs, on-chain anchoring of the audit chain, support SLA | **$2–5k / month** + onboarding |

We never sell signals and never take custody; the key stays with the operator (HL agent wallet).

### Market size (order of magnitude)

- Hyperliquid runs multi-billion-dollar daily perp volume; HIP-3 adds builder-deployed markets
  (equities, commodities, indices) that multiply the venues an agent can touch.
- Serviceable: the **automated** slice of that flow (bots, strategies, AI agents). At 1 bps on even
  1 % of volume routed through a guardrail layer, attribution alone is a seven-figure annual line;
  hosted seats are the margin.
- Every HIP-3 deployer is also a prospect: a dex that ships "trade here through a brake" has a
  safety story for its users.

### Demand validation (what we have, what we'll add)

- **Observed pain:** blown-up bot accounts and "revenge trading" are a recurring theme in HL
  trader communities; the HL agent-wallet model ("trade-only key") proves users already want
  permission limits — VetoOS is the missing rules layer on top.
- **Built-in validation:** the repo ships the exact integration a user would do (5 lines);
  the console's counterfactual panel ("loss blocked by vetoes") is the metric a buyer cares about.
- **The instrument we now have (shipped):** @@pnpm shadow <address>@@ turns the question from
  "do you think this is useful?" into "here is what it would have refused in **your** last 2000
  fills" — a concrete number a trader can argue with. That is the validation loop, and it costs
  the user nothing (no key, no signup).
- **FILL IN BEFORE THE DEADLINE (only the team can write this):** 2–3 named conversations with HL
  bot operators / HIP-3 deployers — who, what they said, what they would pay. Run each of them
  through @@pnpm shadow <their address>@@ first and quote their reaction; that is far stronger
  than paraphrasing a chat. Then post the demo in HL Discord / X and link the thread here.

### The product surface (what a user actually touches)

| Step | What it asks of the user | What they get | Status |
|---|---|---|---|
| `pnpm demo:offline` → `pnpm verify` → `pnpm prove` | nothing — no keys, no network | the four acts, then a verifier that catches four kinds of tampering | shipped |
| `pnpm shadow <address>` | a public Hyperliquid address, nothing else | a report on their own last 2000 fills: trading profile, what the gate would have refused, attributed PnL, and five explicit caveats | shipped |
| hosted shadow report | a URL | the same report in a browser | `apps/shadowd` — read-only service, no keys, deployable from this repo |
| `pnpm brokerd` with an approved agent wallet | an agent key the user approves in their own wallet | live enforcement on their account | shipped, testnet |

The shadow path is the wedge, and it is deliberately the least invasive thing we could build:
it needs no key, holds no custody, and cannot place an order. A stranger can point it at an
address and see their **own** numbers before deciding whether to trust us with anything.

**What a shadow report says, and what it refuses to say.** It separates three categories
instead of blurring them: rules evaluated exactly (notional, same-side adds, cool-down, rate,
daily realized loss, position size), rules reconstructed approximately (equity, walked back
from today's account value through realized PnL, fees, funding and ledger movements, so the
leverage and margin verdicts are labelled approximate), and rules **not evaluated at all**
(book depth — Hyperliquid publishes no historical order books, so the depth guard is
neutralised and named in every report rather than guessed).

### Distribution

1. Open-source repo + demo video as the forwardable artifact.
2. Hyperliquid builder & trader communities (Discord, X), HIP-3 deployer outreach ("ship a brake with your dex").
3. Integrations: policy templates per community (conservative / degen / fund), Python + TS clients,
   OpenAPI; later a WebSocket feed so other dashboards can embed the gate.

### Accelerator screen (Tier 3 — private to Colosseum, still required)

**How do you know people actually need this?**
We do not claim to know yet, and that is the honest state. What we have is a way to test it
per account instead of asserting it: the shadow report takes any public address and answers
"would this rulebook have changed anything for **you**?" with the account's own fills. That is
the conversation opener, and it produces evidence rather than opinion. The recurring public
signal — agents and bots that keep adding to a losing position, and the Hyperliquid
agent-wallet model itself (a trade-only key is already a permission limit people accept) —
points the same way, but a signal is not validation.

**How far along are you? Do you have users?**
No paying users. What exists and is verifiable today: a working broker (real mainnet HIP-3
reads, real testnet fills including one on a builder dex), a deterministic rule engine with
185 tests, a Veto Receipt chain that a third party can recompute, an attack suite that catches
four kinds of tampering, and a read-only shadow report any address can be run through.
Next 30 days: 10 addresses through the shadow report, 3 of them running it continuously, and
a written answer from each on which refusal they disagreed with — that is the first real
product signal we will have.

### 90-day plan

| When | What |
|---|---|
| Weeks 1–2 | WebSocket fill truth (`userFills` / `webData2`), hosted alpha for 5 design partners, builder code live on mainnet with controlled size |
| Weeks 3–6 | multi-account console, policy approvals (human-in-the-loop edits), on-chain anchoring of the audit chain (HyperEVM) |
| Weeks 7–12 | paid hosted tier, fund features (multi-sig unfreeze), HIP-4 market-level policy research |

## 4. Demo video script (≤ 3:00, English voiceover)

> Record with `pnpm demo --step N` per act, or `pnpm demo:record` for the whole run with
> the cool-down WINDOW compressed (the rule is unchanged — only the 30 s waits, which
> would otherwise eat ~90 s of a 3-minute video; the profile's hash is recorded in every
> receipt). Terminal font ≥ 16pt; dark theme.

| Time | Scene | Narration (say) |
|---|---|---|
| 0:00–0:15 | Title card + `cat configs/policy.demo.json` | "VetoOS: AI proposes, rules dispose. This is the rulebook — hashed into every audit record." |
| 0:15–0:35 | `pnpm preflight` green | "Preflight pulls REAL mainnet HIP-3 data: xyz:XYZ100, asset id 110000, live mark, funding, open interest. If this fails, the broker refuses to start. We also filled a real order on the xyz builder dex on testnet — asset id 750000 — details in EVIDENCE.md." |
| 0:35–1:05 | console: click **Legal small buy** | "Watch the gate: every deterministic rule lights up green against real market data — allowed. Real testnet fill, and the venue's own position confirms the ledger. Truth, not trust." |
| 1:05–1:35 | console: **Oversized order**, then **Smuggle policy override** | "Strategy B wants 10x the cap — the pipeline dies at the notional rule, with a reason anyone can read. Instant retry hits the cool-down. And when the AI smuggles `max_leverage: 999` into its intent, the intent layer refuses it outright." |
| 1:35–2:05 | console: **FOMO rampage ×4** | "The AI keeps adding the same side. Third add in an hour — the FOMO guard fires. The brake cannot be argued with." |
| 2:05–2:32 | console: **Tamper the ledger** → freeze overlay | "The nasty case: a fill that never happened appears in the local ledger. Reconciliation compares it with the venue's real position, catches the lie, and freezes everything. Only a human can unfreeze." |
| 2:32–2:58 | terminal: `pnpm prove` (attack suite) | "Now attack the record itself. Flip a denial into an approval — **caught at seq 7**. Delete a receipt — **caught at seq 8**. Swap the archived input behind a receipt — **caught by content address**. Publish a Merkle root that doesn't match — **caught against the anchor**. Four ways to lie, four catches, each naming the exact sequence number. Don't trust the model. Verify the verdict." |

## 5. Pitch video script (2:00–2:59, English)

1. **Hook (0:00–0:20)** — "Bots and AI agents already trade Hyperliquid. What
   they don't have is a brake. VetoOS is the brake."
2. **Problem (0:20–0:50)** — runaway bots, local-vs-venue book mismatch,
   FOMO revenge trading, closed black-box agents demanding trust.
3. **Product (0:50–1:30)** — single signing exit; deterministic rules;
   fill-truth reconciliation; anti-FOMO guards; 20-second clip of act 4 freeze.
4. **Why us / traction (1:30–2:00)** — TODO (team): background one-liner;
   working demo today; real HIP-3 integration incl. a builder-dex fill, not slides.
5. **Vision (2:00–2:30)** — the standard risk middleware for the agent-trading
   era: policy templates, hosted monitoring, HIP-4 market-level policies.
6. **Close (2:30–2:45)** — "Machines can think. Rules decide. VetoOS."

## 6. Timeline (Beijing time)

- 10/10 — code complete, tests green ✅; optimisation pass (concurrency, venue PnL, HIP-3 fill, caches, audit chain) ✅
- 10/11 — full console rehearsal on testnet; fix anything red; team section + 2–3 user quotes
- 10/12 AM — record demo video; PM — record pitch video; fill portal
- 10/12 evening — submit. **Hard deadline 2026-10-12 23:59 PT = 10/13 06:59 UTC = 10/13 14:59 Beijing.**
