#!/usr/bin/env tsx
/**
 * `pnpm keygen` — generate a fresh agent-wallet keypair for TESTNET use.
 *
 * The recommended flow (docs/TESTNET_SETUP.md):
 *   1. your real HL account (with mainnet deposit history) claims testnet USDC
 *   2. approve THIS agent key for your testnet account (UI or approveAgent)
 *   3. HL_PRIVATE_KEY=<agent key>, HL_ACCOUNT_ADDRESS=<your account address>
 *
 * The agent key can trade but never withdraw — that is the whole point.
 */

import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

const pk = generatePrivateKey();
const addr = privateKeyToAddress(pk);

console.log(`
Agent wallet (testnet):
  address:     ${addr}
  private key: ${pk}

Next:
  1. approve this agent for your testnet account (app.hyperliquid-testnet.xyz → More → API)
  2. put in .env:
       HL_PRIVATE_KEY=${pk}
       HL_ACCOUNT_ADDRESS=<YOUR account address that claimed the faucet>
`);
