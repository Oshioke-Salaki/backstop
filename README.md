# Backstop

**Agent payments that refund themselves.**

When an AI agent pays for an API and the API fails, the money is usually gone. Backstop fixes that. The agent pays into an escrow contract instead of paying the provider directly. Backstop checks the response against what the provider promised. If the response is good, the provider gets paid. If it isn't, the agent gets a full refund, automatically.

Built as a plugin for [PayBox](https://paybox.sh) (MoonPay's wallet for AI agents), on USDC and Base, and compatible with any [x402](https://www.x402.org) client.

**Try it:** https://backstop-base.vercel.app (Base mainnet, real USDC)

---

## Why would you use this?

**If you run an AI agent, or you're the person whose money it spends**
- Your agent can pay for APIs without you worrying about paying for nothing.
- Failed calls are refunded in full within seconds, with no support ticket.
- If a response looks fine but is wrong, you can dispute it.
- Your money is never stuck: if Backstop disappeared, the contract still lets you take it back.

**If you sell an API**
- Agents are more willing to pay you when there's a guarantee behind the payment.
- You set the price, the rules your responses must meet, and how long buyers can dispute.
- You can test your API against your own rules for free before going live.
- You're paid automatically for every response that keeps your promise.

**For PayBox and MoonPay**
- Today, every plugin payment needs a human to approve it, because a failed call has no recourse. Backstop adds that recourse, so agents can safely be given more autonomy.
- Every service gets a public delivery record (how often it delivers, how often it refunds), which helps a marketplace show quality.
- It earns a small fee (1%) on payments that succeed, and charges nothing on refunds.

## How it works

```
 Agent ──pays 0.01 USDC──►  Backstop escrow (on Base)
                                │
                     Backstop calls the provider
                     and checks the response
                                │
          ┌─────────────────────┴─────────────────────┐
     Response kept its promise              Response broke its promise
     → agent gets the data + a receipt     → agent gets the reason
     → provider is paid after a            → full refund, immediately
       short dispute window
```

**What gets checked:** the status code, response time, size, format, data shape (JSON Schema), and field rules such as "temperature must be present". Each provider writes these rules for its own service.

**What the contract guarantees:**
- Money can only ever go back to the payer, or to the provider recorded when you paid.
- After a deadline, anyone can return unclaimed money to the payer.
- The admin can't touch money in escrow, and the fee is capped at 5%.

## Using it from PayBox

The plugin gives an agent seven tools:

| Tool | What it does |
| --- | --- |
| `find_protected_services` | Find APIs whose payments are protected |
| `get_service` | See a service's promise and its delivery record |
| `pay_protected_service` | Pay for one call. PayBox asks you to approve it |
| `my_recent_payments` | See what happened to your wallet's recent payments |
| `check_payment` | See where the money is: held, paid, refunded |
| `dispute_payment` | Contest a response that was wrong |
| `verify_receipt` | Check a delivery receipt is genuine |

Example: *"Use my Backstop plugin to get the weather in Lagos."* The agent finds the service, PayBox asks you to approve 0.01 USDC, and the agent gets the forecast. Ask *"what happened to my recent payments?"* and it shows each one as delivered, refunded or held. If the provider had failed, you'd get the cent back.

## Proof it works

Everything below happened on Base mainnet with real USDC, and the transactions are on Basescan:
- **Escrow contract:** [`0x4F094D6FAEA6488BC094C9E041d1cAF327B82E59`](https://basescan.org/address/0x4F094D6FAEA6488BC094C9E041d1cAF327B82E59)
- **A provider broke its promise, so the payer was refunded in full:** [payment page](https://backstop-base.vercel.app/p/0x588e536c995f14d142a5c1ac150b3cadf18617195a008a5d031952252ba1878c?t=1ZXwl1SIZTvDYl6l-QugrPGcHAz52USurXrKs00S6g4)
- **A payment was disputed and an arbiter split it:** [payment page](https://backstop-base.vercel.app/p/0x11d8be4c7be81670f8fefe9af958c7acdadda3de31308d5809d4997769e3c52e?t=7VOVv_0zj7C95nvMggVAvz4YZTsjqheTWR-wYVO1xwo)
- **Automated live test:** 55 checks with real payments, all passing, covering delivery, retries, refunds, disputes and the agent tools. Run it yourself with `pnpm e2e:live`.

| Test suite | Tests |
| --- | --- |
| Smart contract (unit, fuzz, invariants) | 52 |
| Core logic (payments, signatures, checks, security) | 185 |
| End to end on a local chain and database | 57 |
| Live, against the deployed app with real USDC | 55 |

## Hackathon fit (MoonPay PayBox, Chapter 1)

- **Working plugin:** in [`paybox-plugin/`](paybox-plugin). Built with the official starter and passes PayBox's checks.
- **Categories:** Merchant tools (providers get paid safely by agents) and Consumer finance (users' money is protected).
- **Uses x402 natively:** PayBox's `pay_x402` works with Backstop unchanged.

## Run it yourself

You need Node 20.9 or newer, pnpm 10, and [Foundry](https://getfoundry.sh).

```sh
pnpm install
pnpm --filter @backstop/contracts build
pnpm --filter @backstop/web local
```

That one command starts a local blockchain, deploys the contract, creates demo services and payments, and opens the app at http://localhost:3000.

## What's in this repo

| Folder | What it is |
| --- | --- |
| [`contracts/`](contracts) | The escrow smart contract and its tests |
| [`packages/core/`](packages/core) | Shared logic: payments, signature checks, response checks |
| [`apps/web/`](apps/web) | The app: payment gateway, dashboard, API, agent tools |
| [`paybox-plugin/`](paybox-plugin) | The PayBox plugin |
| [`docs/`](docs) | Deeper documentation (below) |

## More documentation

| Document | Read it for |
| --- | --- |
| [DEMO.md](docs/DEMO.md) | How to run the demo, with a script |
| [PRD.md](docs/PRD.md) | The problem, users, goals and risks |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a payment flows through the system |
| [THREAT_MODEL.md](docs/THREAT_MODEL.md) | What's protected, and the known limits |
| [RUNBOOK.md](docs/RUNBOOK.md) | Deploying and operating it |
| [PAYBOX.md](docs/PAYBOX.md) | How it plugs into PayBox |

## Honest limits

- The demo services are run by us, to show the flow. No outside provider is listed yet.
- On Vercel's free plan, payouts are processed when the site gets traffic, plus once a day. A one-minute scheduler makes payouts prompt (see the runbook).
- See [THREAT_MODEL.md](docs/THREAT_MODEL.md) for the security trade-offs.
