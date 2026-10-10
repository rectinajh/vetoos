# Colosseum Crypto World's Fair — Submission Pack (VetoOS)

Working document for the submission portal. Binding source:
[Official Rules](https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf).
Everything submitted must be in **English** (§12(a)(i)).

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
  `metaAndAssetCtxs`, `l2Book`, `clearinghouseState` (mainnet reads drive
  vetoes); Exchange API order placement with HIP-3 asset-id mapping on
  testnet (real fills, controlled size); builder-code attribution placeholder.
- TypeScript monorepo: `@nktkas/hyperliquid`, zod, vitest, pnpm.

### Team
- TODO: names, backgrounds, location (one line each).

### Logo
`assets/logo.svg` — "the brake with a checkmark". Export a PNG before upload.

### Repository
https://github.com/rectinajh/vetoos — public, MIT. Prior-development disclosure below.

### Prior-development disclosure (FAQ requirement)
This project was bootstrapped on 2026-10-10 inside the contest window
(2026-09-14 → 2026-10-12). All code, docs, and demos were written within the
window. Third-party code: runtime dependencies (`@nktkas/hyperliquid`, zod,
dotenv) and dev dependencies (typescript, tsx, vitest) under their own
licenses; no pre-existing project code was reused.

## 2. Judging-criteria map (§8) — what to say where

| Criterion | Our answer | Where it shows |
|---|---|---|
| Functionality | Working broker as a SERVICE: HTTP API, idempotent submissions, allow→fill→reconcile, deny paths, freeze; 72 unit tests green | demo video, repo |
| Potential impact | Every bot/AI trading on HL needs a trustworthy kill switch; HIP-3 multiplies the venues that need it; policy templates make it usable day one | pitch video, GTM |
| Novelty | Power structure is the product: proposal/veto separation + fill-truth layer + anti-FOMO guards; reference AI proposer shows both ends of the paradigm | pitch video |
| UX | Web console (freeze banner, live stats, bilingual decision feed); plain-language deny reasons; human-only unfreeze | console screenshot, demo video |
| Open-source | MIT; typed client + 5-line TS/Python examples + OpenAPI + policy templates — any strategy plugs in | repo |
| Business plan | Open core + builder-code attribution + hosted monitoring for funds | §3 below |

## 3. GTM / demand validation (draft)

- **Beachhead**: individual quants and small trading teams already running
  scripts on Hyperliquid — they feel the "no master switch" pain today.
- **Distribution**: open-source repo + Hyperliquid builder/trader communities,
  Discord, X; demo video as the artifact people forward.
- **Demand signal**: prevalence of blown-up bot accounts and "revenge trading"
  anecdotes; HIP-3 growth means more deployers, more dexes, more agents —
  each needs a guardrail layer. TODO: add 2–3 concrete user conversations
  before submission if possible.
- **Business model**: open-source core, builder-code fee attribution on
  routed flow, paid hosted monitoring/policy templates for funds later.
  No signal selling, no lock-in.

## 4. Demo video script (≤ 3:00, English voiceover)

> Record with `pnpm demo --step N` per act; terminal font ≥ 16pt; dark theme.

| Time | Scene | Narration (say) |
|---|---|---|
| 0:00–0:15 | Title card + `cat configs/policy.demo.json` | "VetoOS: AI proposes, rules dispose. This is the rulebook — hashed into every audit record." |
| 0:15–0:35 | `pnpm preflight` green | "Preflight pulls REAL mainnet HIP-3 data: xyz:XYZ100, asset id 110000, live mark, funding, open interest. If this fails, the broker refuses to start." |
| 0:35–1:05 | console: click **Legal small buy** | "Watch the gate: every deterministic rule lights up green against real market data — allowed. Real testnet fill, and the venue's own position confirms the ledger. Truth, not trust." |
| 1:05–1:35 | console: **Oversized order**, then **Smuggle policy override** | "Strategy B wants 10x the cap — the pipeline dies at the notional rule, with a reason anyone can read. Instant retry hits the cool-down. And when the AI smuggles `max_leverage: 999` into its intent, the intent layer refuses it outright." |
| 1:35–2:05 | console: **FOMO rampage ×4** | "The AI keeps adding the same side. Third add in an hour — the FOMO guard fires. The brake cannot be argued with." |
| 2:05–2:40 | console: **Tamper the ledger** → freeze overlay | "The nasty case: a fill that never happened appears in the local ledger. Reconciliation compares it with the venue's real position, catches the lie, and freezes everything. Only a human can unfreeze." |
| 2:40–3:00 | `pnpm test` green + repo scroll | "Open source, MIT, composable Intent IR. Rules outrank models. VetoOS." |

## 5. Pitch video script (2:00–2:59, English)

1. **Hook (0:00–0:20)** — "Bots and AI agents already trade Hyperliquid. What
   they don't have is a brake. VetoOS is the brake."
2. **Problem (0:20–0:50)** — runaway bots, local-vs-venue book mismatch,
   FOMO revenge trading, closed black-box agents demanding trust.
3. **Product (0:50–1:30)** — single signing exit; deterministic rules;
   fill-truth reconciliation; anti-FOMO guards; 20-second clip of act 4 freeze.
4. **Why us / traction (1:30–2:00)** — TODO: team background one-liner;
   working demo today; real HIP-3 integration, not slides.
5. **Vision (2:00–2:30)** — the standard risk middleware for the agent-trading
   era: policy templates, hosted monitoring, HIP-4 market-level policies.
6. **Close (2:30–2:45)** — "Machines can think. Rules decide. VetoOS."

## 6. Timeline (Beijing time)

- 10/10 — code complete, tests green ✅
- 10/11 — testnet keys + full `pnpm demo --auto` rehearsal; fix anything red
- 10/12 AM — record demo video; PM — record pitch video; fill portal
- 10/12 evening — submit. Hard deadline 10/13 15:59 Beijing = 10/12 23:59 PT.
