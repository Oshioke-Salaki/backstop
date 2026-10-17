# Demo guide: Backstop on PayBox

Goal: a 90–120 second video for X that shows an agent paying through PayBox, Backstop holding the money, and a failed provider being refunded automatically, all with real USDC on Base.

**Live (Base mainnet):** https://backstop-base.vercel.app. Escrow [`0x4F09…2E59`](https://basescan.org/address/0x4F094D6FAEA6488BC094C9E041d1cAF327B82E59).

## Part A: Set up (about 15 minutes, before recording)

### A1. Point the plugin at mainnet (developer portal)
1. Open your project at https://developer.paybox.sh.
2. **Network access → Add host:** `backstop-base.vercel.app`. Keep `backstop-six-nu.vercel.app` too; it does no harm.
3. **Variables & Secrets:** remove `BACKSTOP_URL`, then **New variable**: Environment variable, name `BACKSTOP_URL`, value `https://backstop-base.vercel.app`.
4. **Test tools → Load tools**, choose `pay_protected_service`, input:
   ```json
   {"slug":"skyline-forecast","query":{"city":"Lagos"}}
   ```
   Then **Run test**. You should get an x402 proposal for `10000` (0.01 USDC). Optionally choose a wallet and **Validate transaction**; that previews the payment without paying.

No new upload is needed: the submitted code reads `BACKSTOP_URL`.

### A2. Find your PayBox wallet's Base address and fund it
Any one of these shows the address:
- **Ask your agent** (Claude with the PayBox connector): *"List my PayBox credentials and show my wallet's Base address."* It calls `list_credentials`.
- **PayBox app** (https://paybox.sh): open your wallet; copy its EVM/Base address.
- **CLI:** `npx @paybox-sh/sdk login`, then `npx @paybox-sh/sdk credentials --json`.

Send **0.50 USDC on Base** (network: *Base*, not Ethereum) to that address. Payments are signed EIP-3009 authorizations, so the wallet needs no ETH.

### A3. Enable the plugin in your PayBox account
After **Submit Project**, the plugin appears in your PayBox account under **Unofficial plugins**. Turn it on there. It's private to you until reviewed.

### A4. Connect your agent to PayBox
In Claude (claude.ai), add the PayBox MCP connector (https://docs.paybox.sh/connect/mcp) and approve a grant for the funded wallet. Leave approvals on *human approval*: approving on camera is part of the demo.

### A5. Prepare the browser tabs
1. Import the mainnet **provider** key into a browser wallet (MetaMask or Rabby, Base network). The key is `PROVIDER_PRIVATE_KEY` in `backstop/.secrets/base.env`. Open https://backstop-base.vercel.app/signin and sign in. The dashboard lists every payment to the demo services, including the ones PayBox makes, with links to each payment page.
2. Keep tabs open on:
   - Claude, with PayBox connected
   - https://backstop-base.vercel.app (landing page with the live trace)
   - https://backstop-base.vercel.app/dashboard (signed in)
   - https://basescan.org/address/0x4F094D6FAEA6488BC094C9E041d1cAF327B82E59

### A6. Dry run once
Do the whole of Part B once without recording, so approvals and passkey prompts are familiar. Each paid call costs 0.01 USDC, and the broken one is refunded.

## Part B: Record (about 2 minutes)

| Time | On screen | Do |
| --- | --- | --- |
| 0:00 | Backstop landing page | Toggle the trace to **Provider fails** |
| 0:12 | Claude | Ask the agent to find a protected weather service |
| 0:25 | Claude + PayBox approval | Ask it to get the Lagos forecast; approve the 0.01 USDC payment |
| 0:45 | Backstop dashboard → payment page | Open the new payment: *Held for review*, every check ticked |
| 1:00 | Claude + approval | Ask for market headlines; approve 0.01 USDC |
| 1:15 | Dashboard → payment page | *Refunded*; click the settlement tx on Basescan |
| 1:25 | Claude | Prompt 4: the agent confirms "held" and "refunded" itself |
| 1:35 | Payment page (forecast) | Point at the dispute window: the human can still contest it |
| 1:45 | Landing page | Close |

Prompts to type in Claude:
1. `Use my Backstop plugin to find a protected weather service and tell me what it promises.`
2. `Get the current forecast for Lagos from it.`
3. `Now get the market headlines from the Backstop headlines service.`
4. `Show my recent Backstop payments from my PayBox wallet.` The agent calls `my_recent_payments` and reports the forecast as held and the headlines as refunded, with the reason.

## Part C: Script (voice-over)

> **[Landing page, trace on "Provider fails"]**
> Agents can pay for APIs now. But an x402 payment is a one-way push. When the API fails or returns junk, the money's gone. That's why every agent payment still needs a human to tap approve.
>
> This is Backstop: escrow with automatic refunds for agent payments, built as a PayBox plugin.
>
> **[Claude, prompt 1]**
> My agent asks the Backstop plugin for a protected weather service. Every Backstop service publishes a machine-checkable promise: how fast it answers, what shape the data has, which fields must be filled. And its delivery record is public.
>
> **[Prompt 2, approve in PayBox]**
> It pays one cent of USDC through PayBox. Same pay_x402 flow as anywhere else. The difference is where the money goes: into the Backstop escrow contract on Base, not to the provider.
>
> **[Payment page: Held for review]**
> Backstop called the provider only after the money was locked, checked the response against its promise, and every check passed. The agent got its forecast and a signed receipt. The money waits out a short dispute window, then pays the provider.
>
> **[Prompt 3, approve]**
> Now a provider that breaks its promise. This headlines service returns an error dressed up as a 200.
>
> **[Payment page: Refunded, then Basescan]**
> Backstop caught it, never passed the junk to my agent, and refunded the full amount automatically. No ticket, no human. Here's the refund on Basescan.
>
> **[Forecast payment page]**
> And if a response passes the checks but is still wrong, my agent or I can dispute it from this link. The provider answers, an arbiter decides, and the contract enforces it. Even if Backstop went offline, I could reclaim my funds from the contract myself.
>
> **[Landing page]**
> Pay only for what you receive. Backstop: a PayBox plugin, an audited-by-anyone escrow contract on Base, and open source code. Link below.

Post text for X (under 280 characters):

> Agents can pay for APIs. When the API fails, the money's gone.
> Backstop fixes that: a PayBox plugin that pays into escrow on Base and refunds automatically when a provider breaks its promise.
> Built for @MoonPay's PayBox hackathon. github.com/Oshioke-Salaki/backstop

## If something goes wrong on camera

| Symptom | Cause | Fix |
| --- | --- | --- |
| Agent can't find the plugin | Not enabled, or the tool list is stale | Enable it under Unofficial plugins; ask the agent to run `discover_plugins` again |
| "settles on base-sepolia" message | `BACKSTOP_URL` still points at testnet | Redo A1 |
| Backstop "did not answer" | Host not allowed | Add `backstop-base.vercel.app` under Network access |
| Payment declined | Wallet has no USDC on Base | Redo A2 |
| Payment still "Held" or "Refunding" after a minute | Settlement runs after site traffic | Refresh the payment page; any request triggers a settlement pass |
