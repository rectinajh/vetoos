# Product Requirements: VetoOS

**Subtitle:** the AI-era risk-control OS for Hyperliquid HIP-3 — veto first, then fill.

**Tagline:** *Don't trust the agent. Verify the fill. Enforce the rules. Outlast FOMO.*

> 中文原稿见 [zh/PRD.md](zh/PRD.md). This English version is the submission copy and reflects the shipped code.

## 0. Positioning (the 10-second version)

**One sentence:** a brake for HIP-3 in the age of AI agents — models propose, rules dispose, and the books must match the venue.

**Three keywords:** AI-native paradigm · risk-control OS · real HIP-3.

## 1. What it is

VetoOS is not another "AI trades for you" bot. It is a **risk-control OS purpose-built for HIP-3**.
It sits between **strategies / AI agents** and **real Hyperliquid HIP-3 markets** as the **single
exit**: programs may submit trade *intents*, but only the deterministic rulebook can turn an intent
into a signed order, and every fill is reconciled against the venue's own account state afterwards.
Cool-downs, daily-loss and frequency limits stop emotional chasing (FOMO) on the way.

Think of a self-driving car: navigation (the AI, the impulse) may ask for speed, but **the brake and
the speed limit cannot be edited by emotion**.

## 2. Background

Scripts, bots and AI agents increasingly trade on Hyperliquid. APIs and "trade-only, no-withdraw"
agent wallets already exist. What is missing is a **trustworthy master switch**. Once a human hands
order rights to a black box, the failure modes are not just accounting errors — they are runaway
same-side adds during a pump. The cypherpunk answer: self-custody of permissions, rules above
models, fills that can be verified.

## 3. Users

- **Primary:** people running their own quant / multi-strategy stacks.
- **Secondary:** traders who want AI assistance but fear loss of control and tilt.
- **Ecosystem:** other open-source trading tools that adopt VetoOS as their standard exit.

## 4. Pain points

1. **Can't stop it** — several programs / agents can each hit the exchange directly; no master switch.
2. **Books don't match** — local state says "filled", the venue says otherwise.
3. **Risk is invisible** — thin books and tight margin, yet the bot keeps pushing.
4. **Closed agents demand trust** — "just believe us".
5. **Tilt and FOMO** — more leverage, more frequency, more chasing when the market heats up; regret later.

## 5. Solution

### Principles (cypherpunk)

Self-custody where possible · **rules > models** · open-source and auditable · verify fills, don't
trust promises · **cool-down mechanics against FOMO**.

### Three steps

1. **Propose** — strategies / AI emit a standard **Intent IR**; they hold no keys and cannot reach the exchange.
2. **Check (the rules)** — allowed market, notional cap, leverage, daily-loss breaker, post-deny
   cool-down, same-side-add count, order frequency, real book depth, margin. Denials come with a
   plain-language bilingual reason (including "looks like FOMO chasing").
3. **Reconcile (the truth)** — venue fills and positions are compared with the local ledger; a
   mismatch freezes all new orders until a human releases it.

Later narrative: policy-defined "trading envelopes"; HIP-4 market-level policies as a future extension (not in MVP).

## 5.1 Real HIP-3 and real data (hard requirement)

The MVP does **not** ship on a simulated book. It must:

1. Enumerate real HIP-3 perp dexes via the official Info API (`perpDexs`) and pin at least one live dex (`xyz` on mainnet).
2. Pull that dex's **real mark, funding, open interest and book** via `metaAndAssetCtxs { dex }` + `l2Book`.
3. Compute vetoes (capacity, notional, FOMO frequency …) from that **live data**.
4. Place orders with the HIP-3 asset-id rule `100000 + perp_dex_index * 10000 + index_in_meta`
   (coins are `dex:COIN`); at least one real, size-controlled fill on testnet.
5. Reconcile against the **real account state** returned by the API, not a local ledger talking to itself.

**Not in scope:** staking 500k HYPE to deploy our own HIP-3 dex. We **guard existing real HIP-3 markets**; we are not the deployer.

## 6. Non-goals

- Not "an AI that prints a risk score".
- Not an all-in-one AI trading OS.
- No new market deployment this round.

## 7. MVP (what the judges see) — status

| ID | Capability | Evidence | Status |
|----|-----------|----------|--------|
| M1 | Multi-source intents | two strategies + an AI proposer submit Intent IR over HTTP | ✅ `apps/brokerd`, `apps/proposer-ai`, `@vetoos/client` |
| M2 | Hard veto | at least one denial computed from **real market / account data** (notional, depth, daily loss, frequency) | ✅ live mainnet `xyz:XYZ100` context; see [EVIDENCE.md](EVIDENCE.md) |
| M3 | Anti-FOMO | cool-down or same-side-add limit fires | ✅ 3 adds/hour + 30 s cool-down |
| M4 | Allowed fill | a real order on a real HIP-3 venue (testnet) | ✅ BTC main-dex fills and an `xyz:XYZ100` builder-dex fill (asset 750000) on testnet |
| M5 | Fill reconciliation | a bad ledger is detected and the broker stops | ✅ tamper → freeze → human-only unfreeze; background session reconcile |
| M6 | Open source + business page | GitHub + who pays | ✅ MIT repo; [SUBMISSION.md §3](SUBMISSION.md) |

## 8. Acceptance

- In the demo, **the model cannot change the breaker or the cool-down rules** (override fields are refused at the intent layer).
- Deny reasons are readable by a non-engineer (including the anti-tilt ones).
- A third party can clone the repo and plug in their own strategy in five lines.
- A ≤3-minute video: tagline → veto / reconcile / cool-down → close.

## 9. Judging-criteria self-check

Functionality: check + reconcile + anti-FOMO as a closed loop, as a service · Impact: the quant
middleware layer for Hyperliquid · Novelty: the **power structure** (proposal / veto separation,
fill truth) rather than prediction · UX: plain-language log, live gate console · Open source:
composable Intent IR, typed client, OpenAPI · Business: open core + builder attribution + hosted.

## 10. Business (one page) — see [SUBMISSION.md §3](SUBMISSION.md)

Free to self-host · builder-code attribution on routed flow funds maintenance · hosted monitoring
and policy management for funds is paid · we never sell signals or lock users in.

## 11. Risk boundary

Testnet / controlled environments first; rules do not replace P&L responsibility; on any anomaly
we **stop rather than push through** (fail closed).

## 12. Roadmap

Now: master switch + reconciliation + anti-FOMO as a service → next: strategy plug-ins and policy
templates, WebSocket fill truth, hosted console → later: alignment with new market types (HIP-4
policies), on-chain anchoring of the audit chain.

## Closing line for judges

Automated trading is here to stay; what is dangerous is losing control and losing your head.
VetoOS keeps the books honest, keeps the rules in charge and keeps FOMO out — on Hyperliquid, for
real HIP-3 markets. **Machines may think. Rules decide.**

## 13. Locked decisions (2026-10-10)

1. Demo: vetoes on **real mainnet HIP-3 data**; fills on testnet with controlled size.
2. Default dex `xyz`, default market `xyz:XYZ100` (configurable; `VETOOS_TRADE_MARKET` pins the fill market).
3. AI: natural language → Intent IR; it may *suggest* policy edits for a human to confirm; it **never** decides allow/deny.
4. Story: several strategies / an AI competing for one account's master switch + anti-FOMO + usable as middleware for anyone's strategy.
5. Keys only inside the Risk Broker; fail closed; FOMO ≤3 same-side adds/hour, 30 s post-deny cool-down; reconcile tolerance 0.5 % or 1 lot, else freeze.
6. Engineering: a runnable sharp wedge beats perfect packaging.
7. Bilingual materials; builder code on orders (placeholder allowed on testnet).
8. Red lines: no self-deployed HIP-3 dex; no full trading OS; the LLM never signs.
