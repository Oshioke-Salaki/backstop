# Architecture

```
backstop/
  contracts/        Solidity escrow (Foundry): BackstopEscrow.sol, mocks, tests, deploy script
  packages/core/    Pure TypeScript domain: x402 codec, EIP-3009 checks, SLA engine, SSRF-safe fetch,
                    receipts, request signing, escrow state machine, money math. No I/O besides fetch.
  apps/web/         Next.js 16 app: gateway, REST API, MCP server, settlement worker, UI
    src/server/     Server modules (DB, chain, gateway, worker, disputes, providers, services, auth)
    src/app/        Routes and pages
    drizzle/        SQL migrations
    scripts/        local.ts (one-command local stack), worker.ts (standalone worker)
    test/           End-to-end tests against a real chain (anvil) and embedded Postgres
```

## Request path (the gateway)

`GET|POST /x/:slug/*` in `src/server/gateway.ts`:

1. **Resolve.** Look up the service. Reject drafts (404), paused services (503), providers whose payout is not approved yet (503), wrong methods (405), path traversal or control characters (400), oversized bodies (413), GET bodies (400).
2. **Pre-validate input** against the service's input schema. Failures return 400 with no payment taken.
3. **No payment header:** return 402 with a v1 JSON body and a v2 `PAYMENT-REQUIRED` header. `payTo` is the escrow.
4. **Decode** the payment, accepting v2 `PAYMENT-SIGNATURE` or v1 `X-PAYMENT`, with an 8 KB cap, strict base64 and strict schemas.
5. **Idempotency.** `escrowId = keccak256(abi.encode(payer, nonce))`, identical to the contract. If a row exists: same request hash replays the stored outcome; a different hash returns 409 `payment_reused`; in flight returns 409 `payment_in_progress`.
6. **Verify the authorization** offline: scheme, network, recipient == escrow, exact amount, not self-payment, validity window (`validAfter < now`, `validBefore >= now + MIN_AUTHORIZATION_SECONDS`), low-s signature, recovered signer == `from`.
7. **Claim.** Insert the escrow row in `funding` state. The primary key makes concurrent duplicates lose here, before any chain call.
8. **Deposit on-chain** with the depositor key. Simulate first, so reverts become typed 402s at no gas cost. Then send and wait for confirmation.
   - Revert: `funding_failed`, and the agent gets 402 with the reason.
   - Ambiguous send or confirmation timeout: stays `funding`, and the agent gets 503 `payment_unconfirmed` with a status link. The reconciler settles it from chain state.
9. **Call the provider**, signed with HMAC (`x-backstop-signature`), through the SSRF-guarded client, with timeout = SLA latency and a streamed size cap.
10. **Evaluate** the response against the SLA. The function is pure and deterministic, and it stops at the first failed check.
11. **Sign a receipt** (EIP-712) over the verdict, request hash, response hash and latency.
12. **Record** in one DB transaction:
    - Pass: `release_pending`, store the encrypted response for replay and evidence, queue a `release` job at `releaseAt`.
    - Fail: `refund_pending`, queue a `refund` job now.
13. **Respond.** Pass returns the provider's status, body and safe headers plus Backstop headers. Fail returns 502 `delivery_failed` with the checks, and the failing body is never forwarded.

## State machine (`packages/core/src/state.ts`)

```
funding ──► held ──► release_pending ──► released
   │          │            │   └──────► disputed ──► released | refunded | split
   ▼          ▼            ▼
funding_failed  refund_pending ──► refunded
any held state ──► reclaimed   (payer used the on-chain safety valve)
```

Every transition goes through `transition()`, which validates it against the table and applies it as a conditional `UPDATE … WHERE status IN (from)`. Concurrent actors therefore cannot both win. Each transition appends to `events`, which is the timeline shown in the UI.

## Settlement worker (`src/server/worker.ts`)

Each tick runs these steps in order. Every step is isolated, so one failing step (for example, the RPC is down) doesn't block the others:

1. **expireDisputes:** open disputes past `respondBy` with no provider answer are resolved as refunds.
2. **reconcileFunding:** `funding` rows older than 2 minutes. On-chain Held means the provider was never called, so refund. On-chain None with the authorization expired means `funding_failed`.
3. **reconcileHeld:** `held` rows older than 5 minutes are interrupted deliveries, so refund.
4. **reconcileExpired:** held statuses past their deadline. Sync from the chain (this picks up payer reclaims); otherwise refund.
5. **runJobs:** claim due jobs with `FOR UPDATE SKIP LOCKED` (safe across many workers). Executors check chain state first, store the tx hash before waiting, and on retry check the stored tx before resending. Backoff is exponential up to 30 minutes; after 8 attempts the job is marked `failed` and a `settlement_stuck` event is recorded.
6. **purge:** delete stored responses past retention.

Run modes: `WORKER_INLINE=true` (inside the Next server via `instrumentation.ts`), `pnpm worker` (standalone), or `POST /api/cron/tick` with `CRON_SECRET` (serverless).

## Data

Postgres via Drizzle, or embedded Postgres (PGlite) when `DATABASE_URL` is unset or starts with `file://`. Both run the same migrations. Tables:
- `users`, `providers` (signing secret encrypted), `api_keys` (SHA-256 hashed)
- `services`, `escrows`, `responses` (AES-256-GCM, AAD = escrow id)
- `disputes`, `jobs` (unique dedupe key), `events`

## Chain

- `BackstopEscrow` holds USDC and pulls funds with EIP-3009 `transferWithAuthorization`. The payer signs a transfer to the escrow only.
- The contract checks the balance delta, so fee-on-transfer tokens revert.
- Separate keys:
  - depositor (gateway)
  - settler (worker)
  - registrar (approves payout addresses)
  - receipt signer (off-chain)
  - owner (multisig, two-step transfer)
- Depositor and settler must differ, so their nonces never collide. Sends are serialized per key in-process.

## Frontend

Next.js 16 with Cache Components and partial prefetching:
- Static shells prerender, and data streams in through `<Suspense>` with skeleton fallbacks.
- Server components read the DB directly. Mutations go through the same REST API agents use, via `lib/api.ts`, which turns every failure into a readable message plus field errors.
- Client components handle pending, error and success states with `useAction`.
- Live payments refresh themselves while the tab is visible.
