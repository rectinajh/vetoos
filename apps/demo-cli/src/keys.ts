/**
 * Key roles and the separation between them (docs/VERIFIABLE_RISK_ENGINE.md §7).
 *
 * "Only a human can release the brake" is a claim about KEYS, not about
 * process. If the hot trading key and the human/operator account are the same
 * address, the broker process can mint its own unfreeze authorisation and the
 * human-in-the-loop guarantee collapses into a promise. So we check it at
 * startup and refuse to run when the roles overlap.
 *
 *   HL_PRIVATE_KEY        agent wallet      may TRADE        never withdraws
 *   HL_ACCOUNT_ADDRESS    operator account  may UNFREEZE     its key never touches the server
 *   VETOOS_RECEIPT_KEY    ed25519 receipt   may ATTEST       nothing else
 */

import { privateKeyToAddress } from "viem/accounts";
import { receiptSignerFromSeed, type ReceiptSigner } from "@vetoos/audit";
import type { CliConfig } from "./config.js";

export type KeyRoleStatus = "ok" | "warn" | "fail";

export interface KeyRoleCheck {
  name: string;
  status: KeyRoleStatus;
  detail: string;
}

/** Address the hot key signs for (undefined when no key is configured). */
export function agentAddressOf(config: CliConfig): string | undefined {
  if (!config.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) return undefined;
  try {
    return privateKeyToAddress(config.privateKey as `0x${string}`);
  } catch {
    return undefined;
  }
}

/** Receipt signer from config, or undefined when receipts are unsigned. */
export function receiptSignerFor(config: CliConfig): ReceiptSigner | undefined {
  if (!config.receiptKey) return undefined;
  try {
    return receiptSignerFromSeed(config.receiptKey);
  } catch (err) {
    throw new Error("VETOOS_RECEIPT_KEY invalid: " + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * The structural guarantee, expressed as a check.
 * Returns a failing entry when the hot key IS the operator account.
 */
export function checkKeySeparation(config: CliConfig): KeyRoleCheck[] {
  const checks: KeyRoleCheck[] = [];
  const agent = agentAddressOf(config);
  const account = config.accountAddress?.toLowerCase();

  if (!config.privateKey) {
    checks.push({
      name: "key separation",
      status: "warn",
      detail: "no HL_PRIVATE_KEY configured — read-only mode",
    });
  } else if (!agent) {
    checks.push({ name: "key separation", status: "fail", detail: "HL_PRIVATE_KEY is malformed" });
  } else if (!account) {
    checks.push({
      name: "key separation",
      status: "warn",
      detail: "agent " + agent.slice(0, 10) + "… (no HL_ACCOUNT_ADDRESS to compare against)",
    });
  } else if (agent.toLowerCase() === account) {
    checks.push({
      name: "key separation",
      status: "fail",
      detail:
        "HL_PRIVATE_KEY is the OPERATOR account itself — this process could sign its own unfreeze " +
        "authorisation, so 'human-only unfreeze' would be nominal. Use an approved agent wallet key.",
    });
  } else {
    checks.push({
      name: "key separation",
      status: "ok",
      detail:
        "agent " + agent.slice(0, 10) + "… ≠ operator " + config.accountAddress!.slice(0, 10) +
        "… (the server cannot release its own brake)",
    });
  }

  if (!config.receiptKey) {
    checks.push({
      name: "receipt key",
      status: "warn",
      detail: "VETOOS_RECEIPT_KEY not set — receipts are hash-chained but unsigned (L2 signature check skipped)",
    });
  } else {
    try {
      const signer = receiptSignerFromSeed(config.receiptKey);
      checks.push({
        name: "receipt key",
        status: "ok",
        detail: "ed25519 signer " + signer.signer.slice(0, 16) + "… (attestation only, cannot trade or unfreeze)",
      });
    } catch (err) {
      checks.push({
        name: "receipt key",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return checks;
}
