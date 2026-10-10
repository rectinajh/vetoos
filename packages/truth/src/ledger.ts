/**
 * File-backed local ledger. Append-only by design; the ONLY sanctioned way
 * to change history is `injectTamperedFill`, which exists purely so the
 * demo can prove that reconciliation catches a lying ledger.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FillRecord } from "./index.js";

export class LedgerStore {
  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  append(fill: FillRecord): void {
    appendFileSync(this.filePath, JSON.stringify(fill) + "\n", "utf8");
  }

  list(): FillRecord[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FillRecord);
  }

  /** Fills recorded since the given timestamp (used per reconciliation window). */
  since(ts: number): FillRecord[] {
    return this.list().filter((f) => f.ts >= ts);
  }

  /** Archive the current ledger (append-only history is kept) and start empty. */
  clear(): void {
    if (existsSync(this.filePath)) {
      appendFileSync(this.filePath + ".archive", readFileSync(this.filePath));
      writeFileSync(this.filePath, "", "utf8");
    }
  }

  /**
   * DEMO ONLY — fault injection. Writes a fill that never happened on the
   * venue into the ledger. Reconciliation must catch the lie and freeze.
   * The record is visibly marked so the audit trail stays honest about
   * the fact that this was a drill.
   */
  injectTamperedFill(fill: FillRecord): void {
    this.append({ ...fill, oid: `TAMPERED-${fill.oid}` });
  }
}
