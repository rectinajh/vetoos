/** Minimal OpenAPI doc for the brokerd API — served at /openapi.json. */

export function renderOpenApi(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "VetoOS Risk Broker API",
      version: "0.1.0",
      description:
        "The single signing exit between strategies/AI and Hyperliquid. " +
        "Proposers submit Intent IR; the deterministic engine decides; the venue is the truth.",
    },
    paths: {
      "/v1/status": {
        get: {
          summary: "Broker state snapshot (frozen flag, policy hash, counters)",
          responses: { "200": { description: "Status object" } },
        },
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
            "400": { description: "Invalid intent (schema or forbidden policy-override fields)" },
            "422": { description: "Denied by a deterministic rule (see code + bilingual message)" },
          },
        },
      },
      "/v1/unfreeze": {
        post: {
          summary: "Human-only unfreeze after a reconciliation freeze",
          parameters: [
            {
              name: "x-vetoos-human",
              in: "header",
              required: true,
              schema: { type: "string", const: "I_AM_HUMAN" },
            },
          ],
          responses: {
            "200": { description: "Broker unfrozen" },
            "403": { description: "Missing/invalid human token" },
          },
        },
      },
    },
  };
}
