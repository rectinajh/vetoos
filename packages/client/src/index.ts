/**
 * @vetoos/client — typed client for the brokerd HTTP API.
 *
 * Five lines to a guarded trade:
 * ```ts
 * import { createClient, makeIntent } from "@vetoos/client";
 * const vetoos = createClient("http://127.0.0.1:4399");
 * const res = await vetoos.submitIntent(makeIntent({
 *   source: "my-strategy", market: "BTC", side: "buy", size: "0.0005", order_type: "market",
 * }));
 * console.log(res.decision?.code); // ALLOW or a bilingual deny reason
 * ```
 */

import { makeIntent, type IntentInput } from "@vetoos/intent";

export { makeIntent, INTENT_IR_VERSION } from "@vetoos/intent";
export type { Intent, IntentInput } from "@vetoos/intent";

export interface DecisionView {
  decision: "allow" | "deny";
  code: string;
  message_en: string;
  message_zh: string;
  snapshot: Record<string, unknown>;
}

export interface SubmitResultView {
  validationError?: string;
  decision?: DecisionView;
  placed?: {
    status: "filled" | "resting";
    oid: number;
    filledSize: number;
    avgPx: number;
    assetId: number;
  };
  reconcile?: { ok: boolean; shouldFreeze: boolean; reason_en?: string; reason_zh?: string };
  duplicate?: boolean;
}

export interface BrokerStatus {
  frozen: boolean;
  freezeReason?: string;
  policyHash: string;
  ledgerFills: number;
  historyEvents: number;
  tradeMarket: string;
  readNetwork: string;
  writeNetwork: string;
  startedAt: string;
}

export interface AccountView {
  network: string;
  tradeMarket: string;
  equityUsd: number;
  availableMarginUsd: number;
  positionSize: number;
  positions: Record<string, number>;
}

export interface AuditEventView {
  ts: string;
  type: string;
  policyHash: string;
  data: Record<string, unknown>;
}

export class VetoosError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VetoosError";
  }
}

export interface VetoosClient {
  submitIntent(intent: IntentInput): Promise<SubmitResultView>;
  getStatus(): Promise<BrokerStatus>;
  getAccount(): Promise<AccountView>;
  getFeed(n?: number): Promise<AuditEventView[]>;
  getPolicy(): Promise<{ policy: Record<string, unknown>; contentHash: string; path: string }>;
  /** Humans only — models are expected NOT to call this. */
  unfreeze(humanToken: string): Promise<{ frozen: boolean }>;
}

export function createClient(baseUrl: string): VetoosClient {
  const base = baseUrl.replace(/\/$/, "");

  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok && res.status >= 500) {
      throw new VetoosError(res.status, data.error ?? `broker error ${res.status}`);
    }
    return data;
  }

  return {
    submitIntent: (intent) => call("POST", "/v1/intents", intent),
    getStatus: () => call("GET", "/v1/status"),
    getAccount: () => call("GET", "/v1/account"),
    getFeed: async (n = 50) => {
      const r = await call<{ events: AuditEventView[] }>("GET", `/v1/feed?n=${n}`);
      return r.events;
    },
    getPolicy: () => call("GET", "/v1/policy"),
    unfreeze: (humanToken) => call("POST", "/v1/unfreeze", {}, { "x-vetoos-human": humanToken }),
  };
}
