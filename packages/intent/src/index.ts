/**
 * @vetoos/intent — Intent IR: the ONLY way strategies/AI may talk to the Risk Broker.
 *
 * Invariants (docs/ARCHITECTURE.md §4):
 * - Proposers (strategy scripts, LLM proposers) hold no exchange keys.
 * - An intent may carry free-text rationale in `meta`, but must NEVER carry
 *   fields that override risk policy (leverage caps, cooldowns, etc.).
 */

import { z } from "zod";

export const INTENT_IR_VERSION = "0.1" as const;

/** Fields that would let a proposer tamper with the risk policy. Hard-rejected. */
export const FORBIDDEN_POLICY_FIELDS = [
  "max_leverage",
  "max_order_notional_usd",
  "max_daily_loss_usd",
  "max_orders_per_minute",
  "cooldown_seconds_after_deny",
  "max_same_side_adds_per_hour",
  "min_book_depth_multiple",
  "allowed_markets",
  "policy",
  "policy_override",
  "override",
  "bypass",
  "force",
  "skip_checks",
] as const;

export type ForbiddenPolicyField = (typeof FORBIDDEN_POLICY_FIELDS)[number];

const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal string");

export const intentMetaSchema = z
  .object({
    rationale: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .catchall(z.unknown()); // meta is free-form, but see FORBIDDEN check below

export const intentSchema = z
  .object({
    version: z.literal(INTENT_IR_VERSION),
    id: z.string().uuid(),
    source: z.string().min(1).max(64),
    ts: z.string().datetime({ offset: true }),
    market: z
      .string()
      .regex(/^([a-z0-9]+:)?[A-Z0-9]+$/i, "market like 'BTC' or 'xyz:XYZ100'"),
    side: z.enum(["buy", "sell"]),
    size: decimalString,
    order_type: z.enum(["limit", "market"]),
    limit_px: decimalString.optional(),
    reduce_only: z.boolean().default(false),
    meta: intentMetaSchema.optional(),
  })
  .strict(); // unknown top-level fields are rejected outright

export type Intent = z.infer<typeof intentSchema>;
export type IntentInput = z.input<typeof intentSchema>;

export type IntentValidation =
  | { ok: true; intent: Intent }
  | { ok: false; error: string };

/**
 * Recursively scan an unknown object for policy-override field names.
 * AI proposers sometimes "helpfully" include them; the broker must refuse.
 */
export function findForbiddenFields(
  value: unknown,
  path = "",
): { field: string; path: string }[] {
  const hits: { field: string; path: string }[] = [];
  if (value === null || typeof value !== "object") return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findForbiddenFields(v, `${path}[${i}]`)));
    return hits;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    const lower = k.toLowerCase();
    if ((FORBIDDEN_POLICY_FIELDS as readonly string[]).includes(lower)) {
      hits.push({ field: k, path: here });
    }
    hits.push(...findForbiddenFields(v, here));
  }
  return hits;
}

/**
 * Validate a raw (untrusted) payload into an Intent.
 * Order matters: forbidden-field scan runs BEFORE schema parsing so that a
 * tampering attempt is reported as tampering, not as a generic parse error.
 */
export function validateIntent(raw: unknown): IntentValidation {
  const forbidden = findForbiddenFields(raw);
  if (forbidden.length > 0) {
    const list = forbidden.map((f) => f.path).join(", ");
    return {
      ok: false,
      error: `intent carries forbidden policy-override field(s): ${list}`,
    };
  }
  const parsed = intentSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: `invalid intent: ${first ? `${first.path.join(".")}: ${first.message}` : "unknown"}`,
    };
  }
  const intent = parsed.data;
  if (intent.order_type === "limit" && intent.limit_px === undefined) {
    return { ok: false, error: "limit order requires limit_px" };
  }
  if (Number(intent.size) <= 0) {
    return { ok: false, error: "size must be > 0" };
  }
  return { ok: true, intent };
}

/** Helper for proposers: build a well-formed intent with fresh id/ts. */
export function makeIntent(
  fields: Omit<IntentInput, "version" | "id" | "ts" | "reduce_only"> &
    Partial<Pick<IntentInput, "reduce_only">>,
): IntentInput {
  return {
    version: INTENT_IR_VERSION,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    reduce_only: false,
    ...fields,
  };
}
