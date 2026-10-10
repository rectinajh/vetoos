# VetoOS — Technical Architecture

> 中文原稿见 [zh/ARCHITECTURE.md](zh/ARCHITECTURE.md). This English version describes the code as shipped.

## 1. Goals and constraints

- **Goal:** the AI-era risk-control OS for HIP-3 — the single trusted order exit for strategies and
  AI agents (veto layer + fill-truth layer + anti-FOMO).
- **Hard constraints:** rules outrank models; no model process ever holds an exchange signing key;
  open source and auditable by default.
- **Hackathon scope:** real HIP-3 data and real (testnet) fills; no self-deployed dex, no
  production throughput claims.

## 2. Logical architecture

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Strategy A  │  │ Strategy B  │  │ AI Proposer │   no keys, Intent IR only
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │ HTTP  POST /v1/intents           │
       └────────────┬───┴────────────────┘
                    ▼
         ┌─────────────────────┐
         │   brokerd (HTTP)    │  auth (write-guard token), body limits, caches, console
         └──────────┬──────────┘
                    ▼
         ┌─────────────────────┐
         │   Risk Broker       │  the ONLY component that can sign
         │  · idempotency      │  processed map + in-flight map (concurrent dedupe)
         │  · rule engine      │  pure, deterministic, per-rule trace
         │  · late freeze check│  re-check frozen right before signing
         └──────────┬──────────┘
              allow │ deny + bilingual reason + trace
                    ▼
         ┌─────────────────────┐
         │ Hyperliquid Adapter │  mainnet InfoClient (reads) · testnet ExchangeClient (writes)
         │  · HIP-3 asset ids  │  cloid = intent id · price/size normalisation
         └──────────┬──────────┘
                    ▼
              Hyperliquid (Hypercore)
                    │  fills · clearinghouseState · userFills · openOrders
                    ▼
         ┌─────────────────────┐
         │   Fill Truth        │  per-order window + session baseline + 60 s background loop
         │   Audit (hash chain)│  mismatch ⇒ FREEZE (human-only unfreeze)
         └─────────────────────┘
```

**Key invariant:** only the Risk Broker holds / invokes signing. Strategies and AI are key-less proposers.

## 3. Modules

| Package / app | Responsibility | Notes |
|---|---|---|
| `packages/intent` | Intent IR schema (zod), validation, `makeIntent` | refuses policy-override fields on sight |
| `packages/risk` | deterministic rule engine + policy loader (sha256 content hash) | pure functions, per-rule trace, bilingual messages |
| `packages/adapter-hl` | the only module that talks to Hyperliquid | `@nktkas/hyperliquid`; HIP-3 asset ids; cloid; price & lot rounding; backoff on reads only |
| `packages/truth` | fill-vs-position reconciliation, append-only ledger | tolerance 0.5 % or 1 lot; `injectTamperedFill` for the drill |
| `packages/audit` | hash-chained JSONL audit log | `seq / prev_hash / hash`, `verifyChain`, legacy-prefix tolerant |
| `packages/client` | typed TS client for the brokerd API | 5-line integration |
| `apps/brokerd` | the Risk Broker as a service: HTTP API + web console | `app.ts` (routes, testable) / `server.ts` (process) / `dashboard.ts` |
| `apps/proposer-ai` | LLM → Intent IR reference proposer | no keys, no vote |
| `apps/demo-cli` | `RiskBroker` class, CLI (init / preflight / demo / status / submit / unfreeze / close / reset) | routes through a running brokerd when one owns the state dir |
| `configs/` | `policy.demo.json` + templates (`conservative`, `degen`, `fund`) | hash recorded in every audit event |

## 4. Intent IR

```json
{
  "version": "0.1",
  "id": "uuid",
  "source": "strategy-a | ai-proposer",
  "ts": "ISO-8601",
  "market": "BTC | xyz:XYZ100",
  "side": "buy | sell",
  "size": "string-decimal",
  "order_type": "limit | market",
  "limit_px": "optional string-decimal",
  "reduce_only": false,
  "meta": { "rationale": "optional free text from AI" }
}
```

- AI may write `meta` and the intent fields only; any field that would override risk configuration
  (`max_leverage`, `policy`, …) makes the intent invalid.
- `id` must be a UUID: it is the idempotency key **and** is mapped 1:1 to the venue client order id
  (`cloid = 0x` + uuid-without-dashes), so a retried intent is a duplicate at the venue as well.
- `reduce_only` is a *claim*. The engine verifies it against the signed position: a "reduce-only"
  order that would open or flip a position gets no waivers.

## 5. Rule engine (deterministic)

Evaluation order (first failure wins; every rule leaves a `pass | fail | skip` trace step):

1. `freeze` — global freeze after a reconciliation mismatch
2. `market_data` — fail closed when mark/book are missing
3. `oracle_distance` — caller limit must sit within `max_oracle_deviation_bps` of the mark (default 500). Market orders skip; the adapter clamps those before signing
4. `allowed_market`
5. `notional` — per-order notional cap
6. `leverage` — projected leverage incl. current position (skipped for verified reduce-only)
7. `daily_loss` — breaker on **venue-sourced** realised PnL (userFills `closedPnl − fee` since 00:00 UTC)
8. `cooldown` — post-deny cool-down
9. `same_side_adds` — FOMO guard, same-side fills in the trailing hour
10. `rate_limit` — submissions per minute
11. `book_depth` — size × multiple must fit within the real resting depth around the mark
12. `margin` — coarse available-margin check

Output: `{ decision, code, message_en, message_zh, snapshot, trace }`.
Read- and write-network marks can differ; caps are evaluated at the **higher** of the two
(`snapshot.mark_px_read`, `snapshot.mark_px_write`) so a cheaper read-side mark can never leak a
larger-than-allowed order. **The LLM is never on the allow/deny path.**

## 6. Fill Truth

1. Per order: `positionBefore` → place (IOC, cloid) → ledger append (only fills with size > 0) →
   `positionAfter` → `reconcileFills` (direction, size within tolerance).
2. Session: brokerd sets a **baseline** at startup and runs a **60 s background loop**:
   whole-session reconcile against the baseline, venue PnL refresh, and an `openOrders` sweep
   (anything resting escaped the fill-or-kill path and is audited + alerted).
3. Mismatch ⇒ `frozen = true`; every new intent is denied; a late check right before signing
   catches freezes that land mid-request.
4. Unfreeze is human-only (CLI `--confirm I_AM_HUMAN`, header `x-vetoos-human`, or an EIP-191
   signature by the operator account) and re-baselines the session.

## 7. Hyperliquid integration

| Capability | MVP | Later |
|---|---|---|
| Info / Exchange API + agent wallet | ✅ | |
| HIP-3 real reads (`perpDexs`, `metaAndAssetCtxs {dex}`, `l2Book`, `clearinghouseState {dex}`) | ✅ | |
| HIP-3 real writes (builder-dex asset ids, cloid, price/lot rules) | ✅ testnet `xyz:XYZ100` (asset 750000) and main-dex BTC | mainnet with controlled size |
| Builder-code attribution | optional (`HL_BUILDER_ADDRESS`, `HL_BUILDER_FEE_TENTHS_BPS`) | commercial sustainability |
| WebSocket `userFills` / `webData2` | ❌ (polling + background loop) | real-time fill truth |
| HyperEVM CoreWriter | ❌ | contract-enforced exit |
| HIP-4 | narrative only | market-level policies |

### 7.1 Real HIP-3 data path

```
perpDexs                       → dex index (xyz = 1 on mainnet, 65 on testnet)
metaAndAssetCtxs { dex }       → real mark / funding / OI / universe (szDecimals)
l2Book { coin: "xyz:XYZ100" }  → resting depth on the hit side (±50 bps)
asset id = 100000 + dex_index * 10000 + meta_index   (main dex: plain meta index, BTC = 0)
clearinghouseState { dex } / userFills / openOrders  → Fill Truth inputs
```

- Coin format `{dex}:{coin}`; the adapter always carries the `dex` dimension.
- Prices are normalised to ≤ 5 significant figures **and** ≤ `6 − szDecimals` decimals; sizes are
  floored to the lot. Caller-supplied `limit_px` goes through the same rounding.
- Startup fails closed if the real market context cannot be pulled (with bounded retries for 429s).
- Builder dexes have their own clearinghouse: collateral must be moved into the dex (`sendAsset`)
  before an order can fill there.

## 8. Repository layout

```
vetoos/
  README.md
  docs/            PRD.md · ARCHITECTURE.md · EVIDENCE.md · TESTNET_SETUP.md · SUBMISSION.md · OPTIMIZATION.md · zh/
  packages/        intent · risk · adapter-hl · truth · audit · client
  apps/            brokerd · proposer-ai · demo-cli
  configs/         policy.demo.json · templates/{conservative,degen,fund}.json
  examples/        5-line TS / Python strategy integrations
  .github/         CI: typecheck + tests
```

## 9. Technology

- TypeScript (ESM, strict), pnpm workspaces, tsx runtime, vitest.
- `@nktkas/hyperliquid` for Info/Exchange clients, `viem` for signature verification, `zod` for the IR.
- Policy = JSON with a sha256 content hash written into every audit record.
- Logs = hash-chained JSONL + a one-line human narration.
- Tests = rule unit tests + fault injection (bad ledger, write errors, concurrent duplicates,
  mid-request freeze) + route-level tests of brokerd with a stubbed venue.

## 10. Security notes

- Master key never enters a strategy process; the demo uses an HL agent wallet (trade-only).
- `.env` is gitignored; the private key exists only inside the broker process.
- Policy changes are explicit, audited actions; AI cannot make them.
- Default `deny` / `freeze` on anomalies; write failures burn the intent id (never auto-retried).
- Exposure beyond localhost requires `VETOOS_PUBLIC_TOKEN` (constant-time compare); binding a
  non-loopback host without it is refused; `VETOOS_PROTECT_READS=1` extends the guard to GETs.
- Console output is escaped (intents are untrusted input).
- One writer per state directory: brokerd holds `brokerd.lock`; the CLI routes through HTTP while it runs.

## 11. Demo path (maps to PRD MVP)

1. `pnpm brokerd` loads the policy, pulls real HIP-3 context, baselines the session.
2. Console → **Legal small buy**: allow → real testnet fill → truth OK.
3. **Oversized** / **Smuggle override** / **FOMO ×4**: deny at notional / intent layer / FOMO guard.
4. **Tamper the ledger**: reconcile mismatch → full-screen FREEZE → human button releases it.

## 12. Locked defaults

- dex `xyz`, market `xyz:XYZ100`; fill market pinned via `VETOOS_TRADE_MARKET` where the testnet book is too thin.
- fail closed; FOMO 3/h + 30 s cool-down; reconcile 0.5 % or 1 lot.
- secrets only in the Risk Broker.

## 13. Verifiable risk engine (v2 design)

See [VERIFIABLE_RISK_ENGINE.md](./VERIFIABLE_RISK_ENGINE.md). Shipped in this round: the hash
chain (`seq / prev_hash / hash`, `GET /v1/audit/verify`). Designed, not yet shipped: receipt
signatures with an independent key, full decision-input archiving for replay, content-addressed
ruleset hash, Merkle-root anchoring on HyperEVM, commit-reveal for AI proposals, and
state-bound one-time unfreeze authorisations.
