# @vetoos/shadowd — the public shadow report

A single read-only web service: paste a public Hyperliquid address, get the VetoOS
shadow report as a page or as JSON. It is the hosted twin of
\`pnpm shadow <address>\` and calls the exact same
\`buildShadowReport\` from \`apps/demo-cli/src/shadow.ts\`, so the CLI and the
page can never disagree about a report.

## What it is NOT

- **No keys.** It never reads a private key, a receipt key, or a .env file, and it
  imports nothing from the signing side of the repository. See \`scrubKeyEnv\` in
  \`src/server.ts\`: key-shaped environment variables are deleted from the process
  before it starts listening, so the running process cannot hold one. The one
  caveat is transitive — the reused demo-cli module imports the CLI's config module,
  which calls dotenv at import time when a \`.env\` happens to sit in the working
  directory. The values are never read or used here, and the container has no .env
  at all; running from a directory without one removes the read entirely.
- **Cannot trade.** There is no wallet, no signer and no exchange endpoint. The only
  outbound calls are public Hyperliquid info reads for the address you typed.
- **Not advice, not a prediction.** The report is a counterfactual: it re-judges
  trades that already happened against a rulebook that was never in force for that
  account.
- **Not stateful.** Nothing is written to disk. Reports live in a 120-second
  in-memory cache and disappear on restart.

## Routes

| Route | Response |
| --- | --- |
| \`GET /\` | Self-contained HTML form (inline CSS, no external assets, no scripts). |
| \`GET /report?address=0x…\` | The report as HTML: headline numbers, profile, refusals by rule, first ten refused orders, caveats. Every value is escaped. |
| \`GET /api/shadow?address=0x…\` | The full \`ShadowReport\` JSON with \`policy\`, \`scaled\` and \`venueCalls\` added at the top level. |
| \`GET /healthz\` | \`{ "ok": true }\`. |
| anything else | 404, or 405 for a non-GET method. |

Status codes: 400 for a malformed address, 422 when the address has no fills,
429 when the per-IP limit is hit, 502 when the venue read fails, 503 when the queue
is full, 504 when a build exceeds its time budget.

## Run it locally

\`\`\`sh
pnpm install                                  # once, to link @vetoos/demo-cli and @vetoos/replay
PORT=4477 pnpm tsx apps/shadowd/src/server.ts
# then
curl -s localhost:4477/healthz
curl -s 'localhost:4477/api/shadow?address=0xf5d81a135f756ca16544e53c20fc20643ec3ad53' | head -c 400
curl -s 'localhost:4477/report?address=0xf5d81a135f756ca16544e53c20fc20643ec3ad53' | head -c 400
\`\`\`

Binds \`127.0.0.1\` by default, so a local run is not reachable from the network.

## Deploy it

VPS with Docker, one line:

\`\`\`sh
docker build -f apps/shadowd/Dockerfile -t vetoos-shadowd . && docker run -d --name shadowd -p 4477:4477 --restart unless-stopped vetoos-shadowd
\`\`\`

Behind a reverse proxy, add \`-e VETOOS_TRUST_PROXY=1\` so the rate limit keys on
the real client address instead of the proxy's.

Fly.io: \`fly launch --dockerfile apps/shadowd/Dockerfile\` from the repository root,
keep \`internal_port = 4477\` in \`fly.toml\`, and set \`VETOOS_TRUST_PROXY=1\` —
Fly terminates TLS in front of the app and the container already binds \`0.0.0.0\`.
Railway: point the service at the repository, set the Dockerfile path to
\`apps/shadowd/Dockerfile\`, and set \`VETOOS_TRUST_PROXY=1\`; Railway injects
\`PORT\`, which the server honours.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| \`PORT\` | \`4477\` | Listen port. |
| \`HOST\` | \`127.0.0.1\` | Bind address. The image sets \`0.0.0.0\` because a container's loopback is not reachable from outside. |
| \`VETOOS_TRUST_PROXY\` | off | \`1\` makes the rate limiter believe the first \`x-forwarded-for\` hop. Never set it without a proxy in front: the header is caller-controlled, so the limit would be trivially bypassed. |
| \`VETOOS_SHADOW_TIMEOUT_MS\` | \`25000\` | Budget for one upstream build before the request answers 504. The abandoned read may still finish in the background. |

## Load behaviour

- **Rate limit.** Five report builds per IP per ten minutes, in memory. Only a
  cache miss spends a token, so refreshing a report is free. Past the limit the
  service answers 429 with a \`retry-after\` header and the remaining wait.
- **Cache.** A successful report is reused for 120 seconds per address, which is
  what keeps refresh-spam off Hyperliquid's public API. Failures are not cached.
- **Concurrency.** At most two builds run at once; up to sixteen more wait in a
  queue, and beyond that the service answers 503 with \`retry-after\` rather than
  piling onto the venue.
- **Nothing else.** No disk writes, no database, no external assets, no scripts on
  the pages, and a content security policy of \`default-src 'none'\`.

## Packaging note

The committed \`pnpm-lock.yaml\` has no importer for this package until someone runs
\`pnpm install\` once in the repository. Until then the Dockerfile installs with
\`--no-frozen-lockfile\`; after that, a frozen install works.
