# Threat model

## Assets

1. USDC held in escrow.
2. Payers' signed authorizations (each moves money once).
3. Provider signing secrets, and the stored responses used as evidence.
4. Correctness of verdicts and receipts.

## On-chain guarantees (enforced by `BackstopEscrow.sol`, covered by tests)

| Property | How |
| --- | --- |
| Funds go only to the payer or the payee bound at deposit | No function takes an arbitrary recipient for escrowed funds |
| Payer can always exit | `reclaim` after the deadline, callable by anyone, works while paused |
| Holds are bounded | `extend` cannot pass `hardDeadline = deposit + 30 days`, or revive an expired escrow |
| Owner cannot drain | `rescue` is limited to `balance - totalHeld` for USDC |
| Accounting holds | Invariant tests: `balance >= totalHeld` and `totalHeld == Σ held` over 16k random calls |
| Fees bounded | `MAX_FEE_BPS = 500`, locked per escrow at deposit, never charged on refunds |
| No double spend | Escrow id derived from the (payer, nonce) pair; the token rejects reused nonces |
| Exactness | Balance delta must equal the authorized value |

## Attacks and responses

| Attack | Result |
| --- | --- |
| Replay a payment header for another request | 409 `payment_reused`; the contract also rejects a reused nonce |
| Send the same payment many times at once | One DB insert wins; the others replay or get 409; charged once (tested) |
| Sign for another chain, recipient or amount | Rejected before any chain call (tested) |
| High-s malleable signature | Rejected (tested) |
| Provider URL to internal network or metadata IP | Rejected at registration and at connect time, including DNS rebinding, IPv4-mapped IPv6, NAT64, 6to4 and Teredo forms (tested) |
| Provider redirects to an internal host | Redirects are never followed (tested) |
| Provider streams an endless body | Cut at the size cap (tested) |
| Provider slow-lorises | Hard timeout on headers and body (tested) |
| Provider asks for payment again (402) | Treated as a failure and refunded (tested) |
| Provider ReDoS through JSON Schema `pattern` | Regex keywords are forbidden (tested) |
| Provider schema with remote `$ref` | Forbidden (tested) |
| CSRF on cookie-authenticated writes | Origin check, SameSite=Lax (tested) |
| Forged session cookie | HMAC check (tested) |
| Guessing payment links | 256-bit HMAC capability tokens with constant-time comparison |
| Leaking payment links through Referer | `Referrer-Policy: no-referrer` |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| API key theft from the DB | Only SHA-256 hashes are stored; keys are shown once |
| Leaked API key used to rotate secrets or keys | Those actions require a wallet session |

## Residual risks (accepted for v1, with plan)

1. **Operator compromise.** A stolen depositor key can deposit pending authorizations to *any registered payee*, because the payer's EIP-3009 signature doesn't bind the payee. Exposure is limited to authorizations in flight (minutes) and capped by `maxEscrowAmount`. Payee registration needs a separate registrar key. *Plan:* keys in KMS/HSM, a per-payee deposit allowlist tied to the service, and per-block velocity limits in the contract.
2. **Settler compromise** can release disputed or pending escrows early to their bound payee. It cannot redirect funds. *Plan:* move the release delay on-chain (`releaseAfter` in the escrow struct), so early release is impossible.
3. **Rate limits are per process** (`src/server/ratelimit.ts`). Multi-node deployments need a shared store. `clientIp` trusts `X-Forwarded-For`, so the app must run behind a proxy that sets it.
4. **Verdicts are only as good as the SLA.** Wrong-but-well-formed data passes. That is what disputes are for.
5. **Stored responses** are encrypted, but readable by whoever holds `DATA_KEY`. Retention defaults to 30 days.
6. **Base reorgs.** `CONFIRMATIONS` defaults to 1. Raise it for high-value services.
