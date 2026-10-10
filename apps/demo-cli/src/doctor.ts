/**
 * `pnpm doctor` — pre-flight check that every real-data dependency is alive
 * before the demo. Fails closed: any red item means the broker would too.
 */

import { HlAdapter } from "@vetoos/adapter-hl";
import { loadPolicy } from "@vetoos/risk";
import { assertPolicyExists, loadConfig, type CliConfig } from "./config.js";
import { checkKeySeparation } from "./keys.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(flags: Record<string, string | boolean>): Promise<number> {
  const checks: Check[] = [];
  const config: CliConfig = loadConfig(flags);

  // 1. Policy file
  let policyHash = "(none)";
  try {
    assertPolicyExists(config.policyPath);
    const loaded = loadPolicy(config.policyPath);
    policyHash = loaded.contentHash.slice(0, 12);
    checks.push({
      name: "policy file",
      ok: true,
      detail: `${config.policyPath} (sha256 ${policyHash}…, markets: ${loaded.policy.allowed_markets.join(", ")})`,
    });
  } catch (err) {
    checks.push({ name: "policy file", ok: false, detail: String(err) });
  }

  // 2. Keys present (format only — never printed)
  const keyOk = !!config.privateKey && /^0x[0-9a-fA-F]{64}$/.test(config.privateKey);
  checks.push({
    name: "HL_PRIVATE_KEY",
    ok: keyOk,
    detail: keyOk ? "present, well-formed (hidden)" : "missing or malformed — see docs/TESTNET_SETUP.md",
  });
  checks.push({
    name: "HL_ACCOUNT_ADDRESS",
    ok: !!config.accountAddress,
    detail: config.accountAddress ?? "missing — set to your testnet account address",
  });

  // 2b. Key ROLES — the human-in-the-loop guarantee is a key-separation
  // property, so it is checked here and enforced again at broker startup.
  for (const role of checkKeySeparation(config)) {
    checks.push({ name: role.name, ok: role.status !== "fail", detail: role.detail });
  }

  const adapter = new HlAdapter(config);

  // 3. Mainnet read path: real HIP-3 dex + market context
  let defaultMarket = "xyz:XYZ100";
  try {
    const loaded = loadPolicy(config.policyPath);
    defaultMarket = loaded.policy.default_market;
  } catch {
    /* already reported above */
  }
  try {
    const dexName = defaultMarket.split(":")[0] ?? null;
    const names = await adapter.listPerpDexNames("mainnet");
    const found = dexName === null || names.includes(dexName);
    if (!found) throw new Error(`dex "${dexName}" not in mainnet perpDexs: ${names.filter(Boolean).join(", ")}`);
    const ctx = await adapter.getMarketContext(defaultMarket, "mainnet");
    checks.push({
      name: "mainnet HIP-3 read",
      ok: true,
      detail: `${defaultMarket} → asset ${ctx.assetId}, mark ${ctx.markPx}, funding ${ctx.funding}, OI ${ctx.openInterest}`,
    });
  } catch (err) {
    checks.push({ name: "mainnet HIP-3 read", ok: false, detail: String(err) });
  }

  // 4. Testnet write path: account equity + trade-market availability
  if (keyOk && config.accountAddress) {
    try {
      const account = await adapter.getAccountState("testnet");
      const ok = account.equityUsd > 0;
      checks.push({
        name: "testnet account",
        ok,
        detail: ok
          ? `equity $${account.equityUsd.toFixed(2)}, available $${account.availableMarginUsd.toFixed(2)}`
          : "equity is 0 — claim testnet USDC from the faucet (docs/TESTNET_SETUP.md)",
      });
    } catch (err) {
      checks.push({ name: "testnet account", ok: false, detail: String(err) });
    }
    const pinned = config.tradeMarket;
    const fillMarket = pinned ?? defaultMarket;
    try {
      await adapter.getMarketContext(fillMarket, "testnet");
      checks.push({
        name: "testnet trade market",
        ok: true,
        detail: pinned
          ? `${fillMarket} (pinned by VETOOS_TRADE_MARKET — testnet xyz is deployer-gated; vetoes still read mainnet HIP-3)`
          : `${fillMarket} exists on testnet — fills will be real HIP-3 testnet fills`,
      });
    } catch (err) {
      checks.push({
        name: "testnet trade market",
        ok: pinned ? false : true,
        detail: pinned
          ? `pinned market ${fillMarket} unusable on testnet: ${String(err)}`
          : `${defaultMarket} NOT usable on testnet → demo fill path falls back to testnet BTC perp (vetoes still read mainnet HIP-3)`,
      });
    }
  }

  let allOk = true;
  for (const c of checks) {
    // The testnet-fallback note is informational, not a failure.
    console.log(`${c.ok ? "OK  " : "FAIL"}  ${c.name}: ${c.detail}`);
    if (!c.ok) allOk = false;
  }
  console.log(allOk ? "\nDoctor: all green. Broker may start." : "\nDoctor: RED items — fix before demo (fail closed).");
  return allOk ? 0 : 1;
}
