# Testnet Setup Guide / 测试网配置手册

VetoOS evaluates vetoes against **real mainnet HIP-3 data** and places **real
orders on testnet**. This guide gets the write path ready in ~10 minutes.

VetoOS 用**主网真实 HIP-3 数据**做否决，在**测试网**真实下单。按本手册约 10 分钟配好。

---

## 0. Read this first / 先说重点

The official testnet faucet has one hard rule
([Hyperliquid docs](https://hyperliquid.gitbook.io/Hyperliquid-docs/onboarding/testnet-faucet)):

> **Only addresses that have deposited on mainnet can claim the 1,000 mock USDC.**

So the flow is: **your real HL account** claims testnet funds, and the broker
trades through an **agent (API) wallet** you approve for that account.
The agent key can trade but **cannot withdraw** — exactly the security model
VetoOS is built on. Your main account key never touches this repo.

官方水龙头硬性要求：**只有在主网入金过的地址**才能领 1000 测试 USDC。
所以正确姿势是：用你自己的 HL 账户领水，再授权一个 **agent wallet（API 钱包）**给
Broker 用——agent key 只能交易、不能提现，主密钥永远不进本仓库。

## 1. Claim testnet USDC / 领测试 USDC

1. Open https://app.hyperliquid-testnet.xyz/drip with your normal HL wallet
   (the one that has deposited on mainnet) connected.
2. Claim — 1,000 mock USDC lands on your **testnet** account.
3. Confirm the balance shows on the testnet portfolio page.

## 2. Create + approve an agent wallet / 生成并授权 agent wallet

Option A — in the UI (simplest):
1. https://app.hyperliquid-testnet.xyz → **More → API** (a.k.a. "API wallet").
2. Generate an agent wallet; the site shows its private key **once** — copy it.

Option B — locally:

```bash
pnpm keygen   # prints a fresh agent address + private key
# then approve that address under More → API → "Authorize an existing agent"
```

## 3. Configure .env / 配置环境变量

```bash
cp .env.example .env
# then edit .env:
#   HL_PRIVATE_KEY=0x<AGENT wallet private key from step 2>
#   HL_ACCOUNT_ADDRESS=0x<YOUR account address from step 1>
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
| drip page refuses the claim | address has no mainnet deposit history | use your regular HL account (§0); a fresh throwaway address **cannot** claim |
| `policy file not found` | wrong cwd or missing file | run from repo root; `ls configs/` |
| `equity is 0` | faucet not claimed, or checking the agent instead of the account | `HL_ACCOUNT_ADDRESS` must be the **account** address; the agent key is only for signing |
| venue rejects `agent not approved` | agent wallet not authorized on testnet | repeat step 2 on **testnet** (approvals are per-network) |
| venue rejects `insufficient margin` | size too big for balance | sizes are auto-computed at ~$40 notional; check `configs/policy.demo.json` caps |
| UI shows `enable trading from the deployer` on xyz:XYZ100 | the testnet xyz mirror is **deployer-gated** — users can't trade it, UI or API | expected — keep `VETOOS_TRADE_MARKET=BTC` in `.env`; fills use the testnet main perp book while vetoes still read mainnet HIP-3. Remove the override to retry xyz once the deployer opens it |
