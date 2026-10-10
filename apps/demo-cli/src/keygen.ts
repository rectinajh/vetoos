#!/usr/bin/env tsx
/**
 * \`pnpm keygen\` — mint the keys this system separates on purpose.
 *
 *   (default)    secp256k1 AGENT wallet for testnet: it can trade, it can
 *                never withdraw. Approve it for your account, then put the
 *                key in HL_PRIVATE_KEY and YOUR address in HL_ACCOUNT_ADDRESS.
 *
 *   --receipt    ed25519 RECEIPT key: signs Veto Receipts. It cannot trade
 *                and cannot unfreeze anything. Put the seed in
 *                VETOOS_RECEIPT_KEY.
 *
 * Three keys, three powers (docs/VERIFIABLE_RISK_ENGINE.md §5.3). The operator
 * account's key is the fourth and must never appear in .env: it is the only
 * thing that can release the brake, and that separation is the product.
 */

import { generateReceiptKey } from "@vetoos/audit";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

if (process.argv.includes("--receipt")) {
  const { seed, signer } = generateReceiptKey();
  console.log(
    [
      "",
      "Receipt key (ed25519) — signs Veto Receipts, cannot trade, cannot unfreeze:",
      "  signer (public id): " + signer,
      "  seed:               " + seed,
      "",
      "Next:",
      "  put in .env:  VETOOS_RECEIPT_KEY=" + seed,
      "  The signer id is recorded on every signed receipt, so a verifier can",
      "  attribute it without ever seeing this seed.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const pk = generatePrivateKey();
const addr = privateKeyToAddress(pk);

console.log(
  [
    "",
    "Agent wallet (testnet):",
    "  address:     " + addr,
    "  private key: " + pk,
    "",
    "Next:",
    "  1. approve this agent for your testnet account (app.hyperliquid-testnet.xyz -> More -> API)",
    "  2. put in .env:",
    "       HL_PRIVATE_KEY=" + pk,
    "       HL_ACCOUNT_ADDRESS=<YOUR account address that claimed the faucet>",
    "  3. keep YOUR key out of .env — that separation is what makes",
    "     \"only a human can unfreeze\" true rather than aspirational.",
    "",
  ].join("\n"),
);
