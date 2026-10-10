/**
 * Risk policy: the deterministic rulebook. Loaded once at broker startup;
 * its content hash is written into the audit log so anyone can verify
 * which rules were in force for a given decision.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

export const policySchema = z.object({
  version: z.string(),
  allowed_markets: z.array(z.string()).min(1),
  max_leverage: z.number().positive(),
  max_order_notional_usd: z.number().positive(),
  max_daily_loss_usd: z.number().positive(),
  max_orders_per_minute: z.number().int().positive(),
  cooldown_seconds_after_deny: z.number().int().nonnegative(),
  max_same_side_adds_per_hour: z.number().int().positive(),
  min_book_depth_multiple: z.number().positive(),
  freeze_on_reconcile_mismatch: z.boolean(),
  default_dex: z.string(),
  default_market: z.string(),
  network_mode: z.string(),
});

export type Policy = z.infer<typeof policySchema>;

export interface LoadedPolicy {
  policy: Policy;
  /** sha256 of the exact file bytes — goes into every audit record. */
  contentHash: string;
  path: string;
}

export function hashPolicyBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadPolicy(path: string): LoadedPolicy {
  const raw = readFileSync(path);
  const json: unknown = JSON.parse(raw.toString("utf8"));
  const parsed = policySchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `invalid policy at ${path}: ${first ? `${first.path.join(".")}: ${first.message}` : "unknown"}`,
    );
  }
  return { policy: parsed.data, contentHash: hashPolicyBytes(raw), path };
}
