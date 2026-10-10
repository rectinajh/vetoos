# Agent tool card

Any agent — a script, an LLM, another process — may talk to VetoOS through one
tool. The tool submits a proposal. It does not decide, sign, or release the brake.

## Tool: `submit_intent`

`POST /v1/intents`

```json
{
  "version": "0.1",
  "id": "uuid",
  "source": "my-agent",
  "ts": "2026-10-11T00:00:00Z",
  "market": "BTC",
  "side": "buy",
  "size": "0.0005",
  "order_type": "market"
}
```

Response `decision.code` is `ALLOW` or a bilingual deny (`message_en`, `message_zh`).
The same `id` is idempotent: a retry, including a concurrent one, never creates a
second venue order.

Do not send policy fields (`max_leverage`, notional caps, and the rest). The
intent layer refuses them before the engine runs.

## Tools that do not exist

| Asked for | Answer |
|---|---|
| `allow_order` / `override_policy` | There is no such route. The model does not vote. |
| `unfreeze` | Human only: CLI `--confirm I_AM_HUMAN`, or header `x-vetoos-human: I_AM_HUMAN` from the operator. A wallet signature from anyone else is rejected. |
| A key, an agent wallet, or a nonce | They live inside the broker process. The agent never sees them. |

## Auth

On localhost, writes are open so a local strategy can call the broker. If
`brokerd` is reachable beyond loopback it requires `VETOOS_PUBLIC_TOKEN` on
header `x-vetoos-token`. Reads can be guarded with `VETOOS_PROTECT_READS=1`.

Full schema: `GET /openapi.json` while `brokerd` is running.
