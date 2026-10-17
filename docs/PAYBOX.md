# Backstop as a PayBox marketplace plugin

PayBox Chapter 1 asks for a live marketplace plugin that works end to end, plus a demo video posted to X. Backstop reaches PayBox agents through three surfaces, and all of them are built.

## 1. x402 services (the fast lane)

Every Backstop service is a standard x402 resource. PayBox agents use it with tools they already have:

```
discover_services  →  finds it (once listed in the x402 Bazaar, or via /.well-known/x402)
pay_x402           →  signs EIP-3009 to the escrow named in payTo
use_service        →  (gateway mode) fetches the paid resource
```

The CLI works the same way:

```sh
paybox discover "forecast"
paybox pay-x402 --url "https://<host>/x/skyline-forecast?city=Lagos"
```

Notes:
- PayBox's `pay_x402` requires a plain EOA payer. Backstop verifies EOA signatures, which matches.
- Backstop accepts both x402 v1 and v2 headers. If a PayBox deployment uses a v2 field Backstop doesn't expect, the 402 body's `error` explains the problem, and nothing is charged.

## 2. MCP plugin tools

Register `https://<host>/api/mcp` as the plugin endpoint. Tools: `search_services`, `get_service`, `get_payment`, `open_dispute`, `withdraw_dispute`, `verify_receipt`.

`open_dispute` and `withdraw_dispute` are marked non-read-only, so PayBox hosts that gate side-effecting tools will ask the user first.

## 3. Payment links for humans

Every paid response carries `x-backstop-payment-url`. The agent hands it to the user, who can see where the money is and file a dispute without signing in.

## Submission checklist

- [ ] Deploy the escrow to Base Sepolia (RUNBOOK.md) and the app to a public https host.
- [ ] Register at developer.paybox.sh and finish PayBox account setup (required by the terms).
- [ ] List one or two real services (or the demo ones from `pnpm local`) with a public upstream.
- [ ] Connect PayBox to an agent (Claude MCP connector or `@paybox-sh/sdk`) with a wallet funded with Base Sepolia USDC.
- [ ] Record the demo below and post it to X.
- [ ] Submit the plugin through the PayBox marketplace process. **Ask MoonPay how third-party plugins are listed: the public docs do not cover it.**

## 90-second demo script

1. **(0:00)** "Agents can pay for APIs now. When the API fails, the money is gone. Backstop fixes that."
2. **(0:10)** In Claude with PayBox, ask: *"Get the weather in Lagos from a protected service."* The agent finds `skyline-forecast`, pays 0.05 USDC through PayBox, and returns the forecast.
3. **(0:30)** Open the payment link: **Held for review**, every check ticked, money in escrow, a release countdown.
4. **(0:45)** Ask for *"Market headlines"* (the deliberately broken service). The agent reports: *"The provider failed its checks; your 0.05 is being refunded."* Open its link: **Refunded**, with the deposit and refund transactions on Basescan.
5. **(1:05)** Dispute the forecast from the link ("temperature was wrong"). Status turns **In dispute**, and the provider's dashboard shows it with a deadline.
6. **(1:20)** Close: "Pay only for what you receive. Built on PayBox, x402 and an escrow contract anyone can audit."
