/**
 * State as a projection of the receipt chain (docs/VERIFIABLE_RISK_ENGINE.md §4.2).
 *
 * The engine's guard windows depend on three pieces of state: \`history\`,
 * \`frozen\` and the freeze reason. If those live in a separate state file there
 * are two truths that can drift — and the drift is invisible until a guard
 * fires (or fails to).
 *
 * Here they are DERIVED from the receipts:
 *
 *     history = projectHistory(receipts, window)
 *     frozen  = last(freeze) > last(unfreeze)
 *
 * That is what makes replay possible from the log alone, and it removes a whole
 * class of "the state file disagreed with the daemon" bugs by construction.
 *
 * The projected shape is structurally identical to the risk engine's
 * HistoryEvent; it is declared locally so this package keeps zero dependencies.
 */

import type { AuditEvent } from "./index.js";

export interface ProjectedHistoryEvent {
  ts: number;
  market: string;
  side: "buy" | "sell";
  kind: "intent" | "fill" | "deny";
}

export interface ProjectionOptions {
  /** Only keep events at or after \`now - retentionMs\` (default 24h, matching the broker). */
  retentionMs?: number;
  now?: number;
}

/** Timestamp of a receipt in broker-clock terms (falls back to the ISO field). */
function receiptTs(event: AuditEvent, data: Record<string, unknown>): number {
  const at = data["at"];
  if (typeof at === "number" && Number.isFinite(at)) return at;
  const snapshot = data["snapshot"];
  if (snapshot && typeof snapshot === "object") {
    const iso = (snapshot as Record<string, unknown>)["now"];
    if (typeof iso === "string") {
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Rebuild the guard window from receipts. Anything that is not one of the
 * three history-bearing receipt types is ignored, so the projection is exact
 * rather than approximate.
 */
export function projectHistory(
  events: AuditEvent[],
  opts: ProjectionOptions = {},
): ProjectedHistoryEvent[] {
  const out: ProjectedHistoryEvent[] = [];
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "intent_received") {
      const intent = data["intent"];
      if (!intent || typeof intent !== "object") continue;
      const market = (intent as Record<string, unknown>)["market"];
      const side = (intent as Record<string, unknown>)["side"];
      if (typeof market !== "string" || (side !== "buy" && side !== "sell")) continue;
      out.push({ ts: receiptTs(event, data), market, side, kind: "intent" });
      continue;
    }
    if (event.type === "decision") {
      // Only denials enter the window; an allow is recorded as a fill instead.
      if (data["decision"] !== "deny") continue;
      const snapshot = (data["snapshot"] ?? {}) as Record<string, unknown>;
      const market = snapshot["market"];
      const side = snapshot["side"];
      if (typeof market !== "string" || (side !== "buy" && side !== "sell")) continue;
      // receiptTs reads data.snapshot.now — pass the receipt data, not the snapshot.
      out.push({ ts: receiptTs(event, data), market, side, kind: "deny" });
      continue;
    }
    if (event.type === "order_placed") {
      // Resting orders never feed the FOMO counter — only real fills do.
      const filled = data["filledSize"];
      if (typeof filled !== "number" || filled <= 0) continue;
      const market = data["market"];
      const side = data["side"];
      if (typeof market !== "string" || (side !== "buy" && side !== "sell")) continue;
      out.push({ ts: receiptTs(event, data), market, side, kind: "fill" });
    }
  }
  const now = opts.now ?? Date.now();
  const retention = opts.retentionMs ?? 24 * 3_600_000;
  const cutoff = now - retention;
  return out.filter((e) => e.ts >= cutoff);
}

export interface ProjectedFreeze {
  frozen: boolean;
  freezeReason?: string;
  /** seq of the receipt that froze the broker — what an unfreeze must name. */
  freezeSeq?: number;
}

/** Frozen state is simply "the last freeze/unfreeze receipt says so". */
export function projectFrozen(events: AuditEvent[]): ProjectedFreeze {
  let state: ProjectedFreeze = { frozen: false };
  for (const event of events) {
    if (event.type === "freeze") {
      const reason = (event.data ?? {})["reason"];
      state = {
        frozen: true,
        ...(typeof reason === "string" ? { freezeReason: reason } : {}),
        freezeSeq: event.seq,
      };
    } else if (event.type === "unfreeze") {
      state = { frozen: false };
    }
  }
  return state;
}
