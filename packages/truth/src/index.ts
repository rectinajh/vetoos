/**
 * @vetoos/truth — Fill Truth: the venue is the only source of truth.
 *
 * The local ledger records what the exchange *reported*; reconciliation
 * compares it against the *actual* account positions pulled from the
 * venue. Any disagreement beyond tolerance freezes the broker — better
 * stopped than sorry (docs/ARCHITECTURE.md §6).
 */

export interface FillRecord {
  intentId: string;
  market: string;
  side: "buy" | "sell";
  /** Filled size in base units, always positive; sign comes from `side`. */
  size: number;
  avgPx: number;
  oid: number | string;
  ts: number;
  szDecimals: number;
}

export interface Mismatch {
  intentId: string;
  market: string;
  expectedDelta: number;
  actualDelta: number;
  absDiff: number;
  tolerance: number;
}

export interface ReconcileResult {
  ok: boolean;
  mismatches: Mismatch[];
  shouldFreeze: boolean;
  reason_en?: string;
  reason_zh?: string;
}

export interface ReconcileOptions {
  /** Relative tolerance, e.g. 0.005 = 0.5%. */
  tolerancePct: number;
  freezeOnMismatch: boolean;
}

export * from "./ledger.js";

export function signedDelta(side: "buy" | "sell", size: number): number {
  return side === "buy" ? size : -size;
}

export function lotSize(szDecimals: number): number {
  return Math.pow(10, -szDecimals);
}

/**
 * Compare locally recorded fills against real position deltas.
 *
 * @param fills        local ledger entries since the last reconciliation
 * @param positionBefore  signed position size in the market before the fills
 * @param positionAfter   signed position size in the market after the fills
 * @param szDecimals   lot precision of the market
 */
export function reconcileFills(
  fills: FillRecord[],
  positionBefore: number,
  positionAfter: number,
  szDecimals: number,
  opts: ReconcileOptions,
): ReconcileResult {
  const actualDelta = positionAfter - positionBefore;
  const mismatches: Mismatch[] = [];
  const toleranceFloor = lotSize(szDecimals);

  // 1. Ledger entries that never showed up in the real position.
  const expectedTotal = fills.reduce((acc, f) => acc + signedDelta(f.side, f.size), 0);
  const diff = Math.abs(expectedTotal - actualDelta);
  const tolerance = Math.max(Math.abs(expectedTotal) * opts.tolerancePct, toleranceFloor);

  if (fills.length === 0 && Math.abs(actualDelta) > toleranceFloor) {
    // Position moved with zero local fills — something traded outside the broker.
    mismatches.push({
      intentId: "(none)",
      market: "(position)",
      expectedDelta: 0,
      actualDelta,
      absDiff: Math.abs(actualDelta),
      tolerance,
    });
  } else if (diff > tolerance) {
    mismatches.push({
      intentId: fills.map((f) => f.intentId).join(","),
      market: fills[0]?.market ?? "(unknown)",
      expectedDelta: expectedTotal,
      actualDelta,
      absDiff: diff,
      tolerance,
    });
  }

  const ok = mismatches.length === 0;
  const shouldFreeze = !ok && opts.freezeOnMismatch;
  return {
    ok,
    mismatches,
    shouldFreeze,
    reason_en: ok
      ? undefined
      : `Ledger/venue mismatch: expected Δ${expectedTotal.toFixed(6)}, actual Δ${actualDelta.toFixed(6)} (tolerance ${tolerance.toFixed(6)}). Freezing.`,
    reason_zh: ok
      ? undefined
      : `账实不符：本地预期变动 ${expectedTotal.toFixed(6)}，链上实际变动 ${actualDelta.toFixed(6)}（容差 ${tolerance.toFixed(6)}）。冻结。`,
  };
}
