# Backstop: product requirements

Status: v1 built and tested (contracts, gateway, settlement, disputes, dashboard, MCP).
Owner: Oshioke Salaki. Last updated: 2026-10-17.

## 1. Problem

AI agents can now pay for things. PayBox gives an agent scoped, revocable authority over a user's wallet, and x402 lets any HTTP endpoint charge per request. But an x402 payment is a one-way push. If the provider times out, returns garbage, or charges and returns an error, the money is gone and nobody is accountable.

PayBox's own design shows the cost of this. Plugin money tools require a passkey approval for every call, even under an autonomous grant. Users won't let agents spend unsupervised when there is no recourse, and an agent that needs a human tap for every $0.05 call isn't autonomous.

The missing piece is the one card networks built decades ago: a way to get money back when the merchant doesn't deliver.

## 2. Product

Backstop is an escrow and automatic-refund layer for agent payments.

1. A provider lists an API with a price and a machine-checkable promise (SLA): status, latency, size, content type, JSON Schema, field rules, and a dispute window.
2. An agent pays the Backstop escrow contract instead of the provider, using a standard x402 flow (PayBox `pay_x402` works unchanged).
3. Backstop calls the provider only after the deposit is confirmed on-chain, then judges the response against the provider's own promise.
4. Pass: the agent gets the response plus a signed receipt, and funds release when the dispute window closes.
5. Fail: the agent gets a 502 with the reason, the bad body is withheld, and a full refund is sent immediately.
6. For responses that pass but are still wrong, the payer can dispute inside the window. The provider answers, and an arbiter decides: release, refund or split.

Even if Backstop goes offline, the contract lets any payer reclaim held funds after the deadline.

## 3. Users

| User | Job | What they get |
| --- | --- | --- |
| Agent (PayBox, any x402 client) | Buy data and actions safely | Refund on failure, idempotent retries, receipts, MCP tools for status and disputes |
| Agent's human | Trust the agent with money | A payment link per call, dispute rights, wallet-wide history |
| Provider (API seller) | Sell to agents without onboarding friction | Higher conversion (buyers take less risk), clear rules, free dry-runs, fast payouts |
| MoonPay / PayBox | Grow autonomous spend and the marketplace | Risk controls that justify autonomous grants, transaction volume, delivery data |

## 4. Why this matters to MoonPay

- **It unlocks autonomy.** Guaranteed refunds on failed delivery are what let a wallet relax per-call passkey approvals for protected services. More autonomous spend means more PayBox volume.
- **It is marketplace infrastructure.** A provider with a public delivery record and an SLA is worth listing. Backstop's scorecards are a quality signal the marketplace currently lacks.
- **It produces the data for credit.** Every call yields a signed verdict, latency and refund outcome. That is the input for Standing (reputation and credit), the third product in this repo.
- **The business model is proven.** A small fee on protected volume (1% default, capped at 5% on-chain, zero on refunds) is the card-network model applied to machine payments.

## 5. Requirements

### Must (v1, done)

- Escrow contract with exactly two destinations (payer or bound payee), a payer reclaim after the deadline, fee caps, pause that never traps funds, and no owner access to held funds.
- x402 v1 and v2 compatible 402 responses. Both payment header generations are accepted.
- EIP-3009 signature verification before any chain call. This includes rejecting low-s malleability and checking network, recipient, amount and validity window.
- Request input validation before payment, so nobody pays for a request the provider would reject.
- SSRF-safe upstream calls: public IPs only, re-checked at connect time, no redirects, streamed size caps, hard timeouts.
- An SLA verification engine with safe JSON Schema (no regex, no remote refs, size and depth limits).
- Idempotency. The same payment for the same request returns the original outcome. The same payment for a different request returns 409. Concurrent duplicates are charged once.
- Signed EIP-712 receipts, verifiable offline.
- A settlement worker with retries and backoff, plus reconciliation against the chain (interrupted deposits, interrupted deliveries, missed deadlines, payer reclaims).
- Disputes: open within the window, provider response with an auto-refund on silence, arbiter split, payer withdraw, provider voluntary refund.
- Provider dashboard: onboarding, service editor, live dry-run, status, payments, disputes, API keys and secret rotation.
- Payer access without an account, through capability links. Optional SIWE sign-in.
- MCP server for agents (search, status, disputes, receipts).
- Public service directory with 30-day delivery scorecards. `/.well-known/x402` discovery.

### Should (next)

- Optimistic mode for latency-critical services: forward first and deposit after, with the risk borne by the provider.
- Streaming and long-running jobs, which need a different verification model.
- Shared rate-limit store and a depositor key pool for horizontal scaling.
- Webhooks to providers for payment and dispute events.
- Automatic PayBox approval-policy integration: let protected services skip per-call passkeys within a grant.
- Arbiter tooling: evidence viewer for stored responses, assignment, SLAs on decisions.

### Won't (v1)

- Non-USDC assets or non-EVM chains.
- Subjective quality scoring by AI. Verdicts are deterministic and auditable on purpose.

## 6. Success metrics

| Metric | Target at 90 days |
| --- | --- |
| Protected volume | $250k monthly |
| Providers live | 50, with 10 above 1,000 calls/month |
| Refund rate (failed checks) | Visible per provider; marketplace median under 2% |
| Dispute rate | Under 0.5% of calls; median resolution under 48h |
| Settlement correctness | 0 escrows past deadline without settlement or reclaim (reconciler alarm) |

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Operator key compromise routes new deposits to a wrong registered payee | Separate depositor, settler and registrar keys; owner multisig; per-escrow cap; pause. See THREAT_MODEL.md |
| Payers abuse disputes | Disputes only for checks-passed deliveries; open-dispute cap per wallet; provider statements; arbiter judgment |
| Providers game SLAs with trivial promises | Public scorecards and promises; disputes catch "valid but wrong" |
| Latency from on-chain deposit | Base block times (~2s); optimistic mode planned for latency-critical services |
| Gas costs on tiny payments | Minimum price $0.001; batching settlements is a planned optimisation |
