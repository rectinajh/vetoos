# Testnet Setup Guide / 测试网配置手册

VetoOS evaluates vetoes against **real mainnet HIP-3 data** and places **real
orders on testnet**. This guide gets the write path ready in ~10 minutes.

VetoOS 用**主网真实 HIP-3 数据**做否决，在**测试网**真实下单。按本手册约 10 分钟配好。

---

## 1. Create a dedicated testnet wallet / 建一个专用测试网钱包

Use a **throwaway key** — never a wallet that holds real funds.

```bash
# any way you like to generate a fresh EVM key, e.g. with node:
node -e "const c=require('crypto');const k='0x'+c.randomBytes(32).toString('hex');console.log(k)"
```

> Why not an agent (API) wallet? On testnet a dedicated throwaway account key
> is the shortest safe path. On mainnet you would instead run
> `approveAgent` from your real account and put the **agent** key here —
> same env vars, same broker, better hygiene.

## 2. Fund it on testnet / 领测试网 USDC

1. Open https://app.hyperliquid-testnet.xyz with the throwaway wallet connected.
2. The testnet faucet credits USDC automatically on first deposit action
   (otherwise use the faucet link in the Hyperliquid Discord).
3. Confirm a non-zero balance on the portfolio page.

## 3. Configure .env / 配置环境变量

```bash
cp .env.example .env
# then edit .env:
#   HL_PRIVATE_KEY=0x<throwaway key from step 1>
#   HL_ACCOUNT_ADDRESS=0x<its address>
```

`.env` is gitignored. The key is read only by the Risk Broker process —
strategies and AI proposers never see it.

## 4. Verify / 校验

```bash
pnpm preflight
```

Expected output when everything is ready:

```
OK    policy file: configs/policy.demo.json (sha256 …)
OK    HL_PRIVATE_KEY: present, well-formed (hidden)
OK    HL_ACCOUNT_ADDRESS: 0x…
OK    mainnet HIP-3 read: xyz:XYZ100 → asset 110000, mark …, funding …, OI …
OK    testnet account: equity $…, available $…
OK    testnet trade market: …
Doctor: all green. Broker may start.
```

Any `FAIL` line stops the broker by design (**fail closed**) — fix and re-run.

## 5. Run the demo / 跑演示

```bash
pnpm demo --auto        # all four acts, cooldown waits included
pnpm demo --step 1      # single act — use this when recording the video
```

Afterwards:

```bash
pnpm broker status                          # frozen? ledger? policy hash?
pnpm broker close --confirm I_AM_HUMAN      # reduce-only unwind of the demo position
pnpm broker unfreeze --confirm I_AM_HUMAN   # human-only reset after a freeze
```

## Troubleshooting / 排错

| Symptom | Cause | Fix |
|---|---|---|
| `policy file not found` | wrong cwd or missing file | run from repo root; `ls configs/` |
| `equity is 0` | faucet not claimed | repeat step 2 |
| `perp dex "xyz" not found on testnet` | HIP-3 dexes aren't mirrored on testnet | expected — demo falls back to testnet BTC perp for fills; vetoes still read mainnet HIP-3 |
| venue rejects order `insufficient margin` | size too big for balance | sizes are auto-computed at ~$40 notional; check `configs/policy.demo.json` caps |
