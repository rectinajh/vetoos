# Evidence — real Hyperliquid integration (collected 2026-10-10)

Everything below is reproducible against the public Hyperliquid APIs. The operator account is
`0x2467cCc560323C3aF7CC91a17ee9CFF6500dcdA7` (testnet); the signing key is a trade-only HL agent
wallet that lives exclusively inside the broker process.

Explorer: <https://app.hyperliquid-testnet.xyz/explorer/address/0x2467cCc560323C3aF7CC91a17ee9CFF6500dcdA7>

## 1. Real HIP-3 data drives the vetoes (mainnet reads)

| Item | Value |
|---|---|
| Builder dex | `xyz` — mainnet perp dex index 1 |
| Market | `xyz:XYZ100` — HIP-3 asset id **110000** (`100000 + 1·10000 + 0`) |
| Startup record | `[startup] policy 70230633b296… loaded; real xyz:XYZ100 context OK (mark 30932, OI 7520.70)` |
| Data path | `perpDexs` → `metaAndAssetCtxs {dex:"xyz"}` → `l2Book {coin:"xyz:XYZ100"}` |

The broker refuses to start if this context cannot be pulled (fail closed, bounded retries on 429).

Denials recorded in today's audit log (`logs/audit-2026-10-10.jsonl`, 20 decisions):

| Code | Count | Trigger |
|---|---|---|
| `NOTIONAL_EXCEEDED` | 6 | 5 × `xyz:XYZ100` ≈ $155,000 notional at the live mainnet mark vs the $1,000 cap |
| `FOMO_SAME_SIDE_ADDS` | 3 | 3rd same-side add within an hour |
| `FOMO_COOLDOWN` | 1 | retry inside the 30 s post-deny cool-down |
| `FROZEN` | 1 | intent submitted while the broker was frozen after a ledger tamper |

## 2. Real fills on testnet (writes)

### 2.1 Main-dex BTC fills (asset id 0)

Venue `userFills`, newest first (UTC):

| Time | Coin | Side | Size | Px | oid | tx hash |
|---|---|---|---|---|---|---|
| 15:54:30 | BTC | B | 0.0005 | 82524.0 | 62352700077 | `0x286c8aafbd903e1b…` |
| 10:08:17 | BTC | B | 0.0005 | 82504.0 | 62333624494 | `0xf3e85f22f8d3aa6b…` |
| 10:08:14 | BTC | B | 0.0005 | 82504.0 | 62333621581 | `0x5aeb13b35b98a376…` |
| 10:07:47 | BTC | A | 0.0005 | 82503.0 | 62333596917 | `0x1452031ef0e83865…` |
| 10:03:57 | BTC | B | 0.0005 (2 fills) | 82545.0 | 62333378675 | `0xc424648357daea1a…` |
| 10:02:05 | BTC | A | 0.0015 | 82538.0 | 62333269059 | `0xdabb6d5b6968b12d…` |
| 09:57:10–16 | BTC | B | 3 × 0.0005 | 82589–82590 | 62332988851 / 62332992117 / 62332994950 | — |

### 2.2 Real HIP-3 builder-dex fill — `xyz:XYZ100` on testnet

| Item | Value |
|---|---|
| Testnet perp dex index | 65 (`perpDexs`) → asset id **750000** (`100000 + 65·10000 + 0`) |
| Pre-condition | builder dexes have their own clearinghouse; 100 USDC moved in via `sendAsset { sourceDex:"", destinationDex:"xyz" }` |
| Intent | `03039657-8a58-43f4-be07-6b6da6678e16` — sell 0.0004 `xyz:XYZ100`, limit 30600 (IOC), source `hip3-experiment` |
| Decision | `ALLOW` (all 11 rules pass on mainnet data + testnet account) |
| Venue response | `filled { totalSz 0.0004, avgPx 30667.0, oid 62353082432, cloid 0x030396578a5843f4be076b6da6678e16 }` |
| Fill (userFills) | 16:01:05 UTC, `xyz:XYZ100` A 0.0004 @ 30667.0, fee 0.001104, tx `0xa30803ecb2387883…` |
| Reconcile | `ok: true`, position after = −0.0004 (`clearinghouseState {dex:"xyz"}`) |

A first attempt at limit 33000 (the only resting ask) was signed and sent with the correct asset id
but rejected by the venue — `Price too far from oracle asset=750000`. The broker's write-error path
recorded it, burned the intent id (`4396649a-5100-4a59-8bef-6b6ff7738b81`) and returned HTTP 502;
a retry of the same id returns the recorded error instead of re-sending.

> The testnet `xyz:XYZ100` book is a few lots deep, so the dashboard keeps BTC as the fill market
> (`VETOOS_TRADE_MARKET=BTC`). The veto side always uses mainnet `xyz:XYZ100`.

## 3. Concurrency: one intent id → one order, venue-side too

Two simultaneous `POST /v1/intents` with the same id `0c5b74b6-3b15-46f9-86d0-eaa2cc80e983`:

```
r1 200  duplicate=true   ALLOW  placed oid 62352700077  0.0005 @ 82524  reconcile ok
r2 200  duplicate=—      ALLOW  placed oid 62352700077  0.0005 @ 82524  reconcile ok
```

Venue `orderStatus` by cloid `0x0c5b74b63b1546f986d0eaa2cc80e983`:
`{ coin BTC, side B, origSz 0.0005, limitPx 86649.0, oid 62352700077, status filled }` — exactly one order.

## 4. Fill truth and the audit chain

- Tamper drill: `POST /v1/demo/tamper` injects a 0.001 BTC fill that never happened → whole-session
  reconcile against the venue position → `BROKER FROZEN` → every new intent denied with `FROZEN` →
  released only by a human (`x-vetoos-human: I_AM_HUMAN` or an operator-wallet EIP-191 signature) →
  session re-baselined.
- Background loop (60 s): session reconcile + venue PnL refresh + `openOrders` sweep. A position
  change made outside VetoOS (e.g. through the venue UI) trips the reconcile and freezes.
- Daily-loss breaker input is the venue's own number: `userFills.closedPnl − fee` since 00:00 UTC
  (today: −$0.60, all fees).
- Audit log is hash-chained (`seq`, `prev_hash`, `hash`); `GET /v1/audit/verify` →
  `{ ok: true, length: 7x, legacyPrefix: 58 }` (lines written before chaining are tolerated and counted).

## 5. Reproduce

```bash
pnpm preflight                               # real mainnet + testnet paths
pnpm brokerd                                 # console at http://127.0.0.1:4399/
curl -s localhost:4399/v1/market | jq .hip3  # live xyz:XYZ100 mainnet context
curl -s localhost:4399/v1/audit/verify       # hash-chain verification
pnpm test                                    # unit + route tests, no network
```
