/**
 * @vetoos/audit — every allow/deny/freeze leaves a bilingual, structured
 * trail. JSONL for machines, one-line human summary for judges and demos.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type AuditEventType =
  | "startup"
  | "intent_received"
  | "decision"
  | "order_placed"
  | "reconcile"
  | "freeze"
  | "unfreeze"
  | "shutdown"
  | "error";

export interface AuditEvent {
  ts: string;
  type: AuditEventType;
  policyHash: string;
  data: Record<string, unknown>;
}

export class AuditLog {
  private readonly filePath: string;
  private readonly policyHash: string;

  constructor(dir: string, policyHash: string) {
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.filePath = join(dir, `audit-${day}.jsonl`);
    this.policyHash = policyHash;
  }

  get path(): string {
    return this.filePath;
  }

  record(type: AuditEventType, data: Record<string, unknown>): AuditEvent {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      type,
      policyHash: this.policyHash,
      data,
    };
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    return event;
  }

  /** One-line, plain-language console summary — the demo's narration track. */
  say(line: string): void {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  recordAndSay(type: AuditEventType, data: Record<string, unknown>, line: string): AuditEvent {
    const event = this.record(type, data);
    this.say(line);
    return event;
  }
}
