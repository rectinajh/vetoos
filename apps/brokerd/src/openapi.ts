/** Minimal OpenAPI doc for the brokerd API — served at /openapi.json. */

export function renderOpenApi(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "VetoOS Risk Broker API",
      version: "0.1.0",
      description:
        "The single signing exit between strategies/AI and Hyperliquid. " +
        "Proposers submit Intent IR; the deterministic engine decides; the venue is the truth. " +
        "When VETOOS_PUBLIC_TOKEN is set, POST requests (and GET /v1/* if VETOOS_PROTECT_READS=1) " +
        "require header x-vetoos-token.",
    },
    components: {
      securitySchemes: {
        writeToken: { type: "apiKey", in: "header", name: "x-vetoos-token" },
      },
    },
    paths: {
      "/v1/status": {
        get: {
          summary: "Broker state snapshot (frozen flag, policy hash, audit chain, last reconcile)",
          responses: { "200": { description: "Status object" } },
        },
      },
      "/v1/audit/verify": {
        get: {
          summary: "Verify today's hash-chained audit log (seq + prev_hash + sha256)",
          responses: { "200": { description: "{ ok, length, brokenAt?, reason? }" } },
        },
      },
      "/v1/market": {
        get: { summary: "Live HIP-3 read-network context + trade-market mark", responses: { "200": { description: "Market object" } } },
      },
      "/v1/risk": {
        get: { summary: "Gauge utilization + active alerts", responses: { "200": { description: "Risk object" } } },
      },
      "/v1/execution": {
        get: { summary: "Every open position, resting order, and recent fill on the write network (30s cache)", responses: { "200": { description: "Execution object" } } },
      },
      "/v1/stats": {
        get: { summary: "Decision counters from today's audit log", responses: { "200": { description: "Stats object" } } },
      },
      "/v1/counterfactual": {
        get: { summary: "Denied intents marked to market — loss the gate blocked", responses: { "200": { description: "Counterfactual object" } } },
      },
      "/v1/ai-risk": {
        get: { summary: "Advisory AI/heuristic risk score over deterministic counters (never decides)", responses: { "200": { description: "Report" } } },
      },
      "/v1/account": {
        get: {
          summary: "Live venue account state (equity, margin, positions)",
          responses: { "200": { description: "Account object" } },
        },
      },
      "/v1/policy": {
        get: {
          summary: "Active policy + sha256 content hash",
          responses: { "200": { description: "Policy object" } },
        },
      },
      "/v1/feed": {
        get: {
          summary: "Recent audit events (intents, decisions, fills, freezes)",
          parameters: [
            { name: "n", in: "query", schema: { type: "integer", default: 50, maximum: 500 } },
          ],
          responses: { "200": { description: "Event list, oldest first" } },
        },
      },
      "/v1/intents": {
        post: {
          summary: "Submit an Intent IR for evaluation (idempotent by intent.id)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["version", "id", "source", "ts", "market", "side", "size", "order_type"],
                  properties: {
                    version: { const: "0.1" },
                    id: { type: "string", format: "uuid" },
                    source: { type: "string" },
                    ts: { type: "string", format: "date-time" },
                    market: { type: "string", example: "xyz:XYZ100 or BTC" },
                    side: { enum: ["buy", "sell"] },
                    size: { type: "string", example: "0.0005" },
                    order_type: { enum: ["limit", "market"] },
                    limit_px: { type: "string" },
                    reduce_only: { type: "boolean", default: false },
                    meta: { type: "object" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Allowed and executed (result includes fill + reconciliation)" },
            "400": { description: "Invalid intent (schema or forbidden policy-override fields) or malformed JSON" },
            "401": { description: "Missing/invalid x-vetoos-token (write-guard enabled)" },
            "413": { description: "Body larger than 64 KiB" },
            "422": { description: "Denied by a deterministic rule (see code + bilingual message)" },
            "502": { description: "Allowed but the venue write failed — intent id is burned, never retried" },
          },
        },
      },
      "/v1/unfreeze": {
        post: {
          summary: "Human-only unfreeze after a reconciliation freeze (header or operator wallet signature)",
          parameters: [
            {
              name: "x-vetoos-human",
              in: "header",
              required: false,
              schema: { type: "string", const: "I_AM_HUMAN" },
            },
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "EIP-191 personal_sign proof by the operator account (alternative to the header)",
                  properties: {
                    address: { type: "string" },
                    message: {
                      type: "string",
                      description:
                        "Structured authorisation from GET /v1/freeze-binding. Free-form messages are rejected.",
                      example:
                        "VetoOS human unfreeze\naction=UNFREEZE\nfrozenAtSeq=412\nchainHead=9f3c...\nnonce=...\nexpiresAt=2026-10-10T12:10:00.000Z",
                    },
                    signature: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Broker unfrozen; session baseline reset" },
            "403": { description: "Missing/invalid human proof" },
          },
        },
      },
      "/v1/freeze-binding": {
        get: {
          summary: "The exact message a human must sign to release the current freeze",
          description:
            "Names the frozen state (frozenAtSeq + chain head) and carries a one-time nonce and an expiry, " +
            "so an authorisation for one freeze can never release another.",
          responses: {
            "200": { description: "frozen / binding / message / expiresAt; binding is null when not frozen" },
          },
        },
      },
      "/v1/ai/commit": {
        post: {
          summary: "AI commit phase: lock in the advice digest BEFORE the verdict exists",
          description:
            "adviceHash is commitmentHash(nonce, advice). The next verdict binds that digest, so advice " +
            "cannot be back-dated or quietly dropped once the outcome is known.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["adviceHash"],
                  properties: {
                    adviceHash: { type: "string", description: "64-char sha256 hex of commitmentHash(nonce, advice)" },
                    modelId: { type: "string" },
                    promptHash: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Committed; returns the receipt seq and hash" },
            "400": { description: "adviceHash missing or not a sha256 digest" },
          },
        },
      },
      "/v1/ai/reveal": {
        post: {
          summary: "AI reveal phase: publish the advice that opens an earlier commitment",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["nonce"],
                  properties: { nonce: { type: "string" }, advice: {} },
                },
              },
            },
          },
          responses: {
            "200": { description: "Revealed and recorded" },
            "409": { description: "Does not open any commitment bound to a verdict (wrong nonce, or never committed)" },
          },
        },
      },
    },
  };
}
