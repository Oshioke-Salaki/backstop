# Backstop

**Agent payments that refund themselves.** Backstop holds x402 payments in escrow until the provider's response passes the checks it promised, then pays the provider, or refunds the agent in full. Built for the PayBox marketplace and compatible with any x402 client.

**Live on Base Sepolia:** https://backstop-six-nu.vercel.app. Escrow [`0x435A…166a`](https://sepolia.basescan.org/address/0x435AbD2527A0Ff45c0C5A373bf6F02D703a9166a).

## Run it locally (one command)

Requirements: Node 20.9+, pnpm 10, Foundry (`anvil`, `forge`).

```sh
pnpm install
pnpm --filter @backstop/contracts build
pnpm --filter @backstop/web local
```

That command:
1. starts a local chain
2. deploys the contracts
3. seeds two providers, four services and ten real payments in every state
4. starts a mock provider API
5. serves the app at http://localhost:3000

It prints wallet keys you can import to sign in as the provider, the arbiter or the payer. Ctrl+C stops everything.

## Test

```sh
pnpm --filter @backstop/contracts test   # 52 tests: unit, fuzz, invariants
pnpm --filter @backstop/core test        # 185 tests: x402, signatures, SLA engine, SSRF guard, receipts
pnpm --filter @backstop/web test         # 57 end-to-end tests on a real chain + Postgres
pnpm --filter @backstop/web typecheck && pnpm --filter @backstop/web lint && pnpm --filter @backstop/web build
BASE_URL=https://… pnpm --filter @backstop/web e2e:live   # 55 checks against a deployment, real payments (see RUNBOOK)
```

## Docs

| | |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | Problem, product, users, metrics, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Request path, state machine, worker, data |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Guarantees, attacks covered, accepted risks |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Deploy, configure, monitor, respond to incidents |
| [docs/PAYBOX.md](docs/PAYBOX.md) | PayBox plugin surfaces, submission checklist, demo script |

User-facing guides for agents, providers, disputes and the API are served by the app at `/docs`.
