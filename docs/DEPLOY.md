# Deploying the shadow report service

`apps/shadowd` is read-only: it holds no key, writes nothing, and cannot place an order.
That is what makes it safe to put on the public internet, and it is also why deploying it
needs no secrets — only somewhere to run a container.

Two files are already in the repo:

- `apps/shadowd/Dockerfile` — the image (node 22, tsx, non-root user, HEALTHCHECK on `/healthz`)
- `apps/shadowd/fly.toml` and `render.yaml` — configs for two hosts that have a free tier

## Option A — Render (no CLI, free, card not required)

1. Push this repo to GitHub (already done).
2. Render dashboard → **New → Blueprint** → pick this repo. Render reads `render.yaml`.
3. Wait for the first build (~3-5 min), then copy the URL it gives you.
4. Put that URL in the submission form's **Live product link** field, and add one line of
   access instructions: "paste any Hyperliquid address; nothing to install, no key needed".

Free plan sleeps when idle, so the first visit after a quiet spell takes a few seconds to wake.

## Option B — Fly.io (CLI, free allowance, card may be required)

`@bash
fly auth login                                   # you, once
cd apps/shadowd
fly launch --no-deploy --copy-config --name <your-unique-name>
fly deploy
fly open                                         # prints the public URL
`@

The machine is configured to `suspend` when idle and wake on request, so a trickle of visitors
costs approximately nothing. Change `app` in `apps/shadowd/fly.toml` to something unique —
app names are global on Fly.

## Option C — any VPS or a machine you already have

`@bash
docker build -f apps/shadowd/Dockerfile -t vetoos-shadow .
docker run -d --name vetoos-shadow -p 4477:4477 \
  -e HOST=0.0.0.0 -e PORT=4477 --restart unless-stopped vetoos-shadow
`@

Then put a TLS reverse proxy in front of it. Two things to know:

- Set `VETOOS_TRUST_PROXY=1` **only** when a proxy you control sets `x-forwarded-for`.
  Without it the per-IP rate limit keys off the proxy's address and one visitor can exhaust
  everyone's budget; with it and no proxy, anyone can spoof their IP.
- Keep it behind TLS. The service itself does no redirect and holds no certificate.

## Option D — a 5-minute preview, not a submission link

`@bash
pnpm shadowd                                     # terminal 1
cloudflared tunnel --url http://127.0.0.1:4477   # terminal 2 -> prints a trycloudflare.com URL
`@

Useful to show someone the report right now. **Do not put this URL in the submission form**:
the tunnel dies with the process, and a dead link in a submission is worse than no link.

## Verify a deployment before you trust the link

`@bash
BASE=https://your-deployment
curl -s -o /dev/null -w '%{http_code}\n' $BASE/healthz                                  # 200
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/report?address=nonsense"                # 400
curl -s "$BASE/api/shadow?address=0xf5d81a135f756ca16544e53c20fc20643ec3ad53" | head -c 200
`@

If the last command returns a report, the deployment is doing the real thing rather than
serving a cached page.

## What must NOT be deployed on the same host

The broker (`pnpm brokerd`) holds the signing key. Never put it on a public host, never in
the same container as the shadow service, and never behind the same URL. `apps/shadowd`
imports only `@vetoos/adapter-hl/public-reads`@, which cannot sign; a grep for key material
across `apps/shadowd` returns nothing, and that is a property worth keeping.
