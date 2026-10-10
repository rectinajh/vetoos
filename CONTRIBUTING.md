# Contributing to VetoOS

Thanks for helping build the brake. A few ground rules keep the product honest.

## Setup

```bash
pnpm install
pnpm typecheck && pnpm test     # must be green before any PR
pnpm demo:offline               # the four acts on a canned venue — no keys needed
pnpm brokerd:offline            # the console on a canned venue → http://127.0.0.1:4399/
```

Real-venue runs need an HL testnet agent wallet — see [docs/TESTNET_SETUP.md](docs/TESTNET_SETUP.md).

## Invariants (PRs that break these are closed)

1. **Only the Risk Broker signs.** No other package may import `ExchangeClient` or hold a key.
2. **The LLM never votes.** Anything under `apps/proposer-ai` or `apps/brokerd/src/ai-risk.ts`
   may *propose* or *summarise*; it may not touch `evaluateIntent` or the allow/deny path.
3. **Rules are pure.** `packages/risk/src/engine.ts` is deterministic: same inputs → same decision,
   and every rule leaves a `pass | fail | skip` trace step. Add a test for every new rule.
4. **Fail closed.** Missing data ⇒ deny; mismatch ⇒ freeze; write error ⇒ intent burned.
   Never substitute a comforting default for an unreadable input.
5. **Unfreeze is human-only.** No endpoint, flag or environment variable may let a process release the brake.
6. **Never commit secrets.** `.env` is gitignored; `configs/policy.json` is local.

## Layout

- `packages/*` — libraries with unit tests next to the source (`*.test.ts`).
- `apps/brokerd` — `app.ts` is the testable HTTP layer, `server.ts` the process entry,
  `dashboard.ts` the server-rendered console (ES5 in a template literal: write `\\n`, not `\n`,
  and run `node --check` on the extracted `<script>` if you touch it).
- `apps/demo-cli` — `RiskBroker` and the CLI.

## Pull requests

- Small, focused, with a test. Route-level tests live in `apps/brokerd/src/app.test.ts`.
- Bilingual user-facing messages (`message_en` + `message_zh`) for every new deny reason.
- Update `docs/ARCHITECTURE.md` when you change a boundary (what may sign, what may decide).
- CI runs `pnpm typecheck` and `pnpm test` on every push and PR.

## Reporting a security issue

Please do not open a public issue for key-handling or unfreeze-bypass problems — contact the
maintainers directly (see the repository profile) and give us a few days to fix before disclosure.
