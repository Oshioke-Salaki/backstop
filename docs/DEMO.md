# Demo guide: Backstop on PayBox

A video of about 2 minutes for X. It shows an agent paying through PayBox, Backstop holding the money in escrow, a broken provider being refunded automatically, and the agent reporting both outcomes. Everything is real USDC on Base mainnet.

Every step below was rehearsed end to end on 2026-10-17 in Claude with the PayBox connector.

**Live:** https://backstop-base.vercel.app. Escrow [`0x4F09…2E59`](https://basescan.org/address/0x4F094D6FAEA6488BC094C9E041d1cAF327B82E59).

## Before you record (checklist)

- [ ] **Portal settings:** network host `backstop-base.vercel.app` (bare hostname, no `https://`) and variable `BACKSTOP_URL` = `https://backstop-base.vercel.app`.
- [ ] **Latest upload (7 tools) submitted:** "Submit Project" clicked after the last upload.
- [ ] **Claude connected to PayBox** (Customize → Connectors → PayBox, `https://api.paybox.sh/mcp`). Leave tools on *Needs approval*.
- [ ] **PayBox wallet funded:** USDC on **Base**. 0.50 USDC covers about 50 takes at 0.01 each. The wallet needs no ETH.
- [ ] **Signing key set up.** The very first payment from a connector asks you to connect a signing key in the PayBox card. Do one payment off camera so later payments are just **Approve**.
- [ ] **Two tabs ready:** Claude, and https://backstop-base.vercel.app (landing page, for the opening and closing shots).

## Rules for the PayBox signing card

- Each payment request expires after about **4 minutes**. Sign as soon as the card appears.
- If no card appears under the reply, send: **`Reopen the signing window.`** It reopens the same payment and never charges twice.
- If the card says *"Couldn't prepare wallet… operation has expired"*, click **Cancel** (**never Forget**: that deletes your signing key) and ask for a fresh request.
- Unsigned requests simply expire. Nothing is charged.

## The flow (what you type, what happens)

| # | You type in Claude | What happens |
| --- | --- | --- |
| 1 | `Use my Backstop plugin to find a protected weather service and tell me what it promises.` | Claude finds **City forecast** (0.01 USDC) and reads out its promise (answers within 10 s, required fields) and its delivery record. |
| 2 | `Get the current forecast for Lagos from it.` | PayBox card shows **$0.01 → backstop-base.vercel.app/x/skyline-forecast?city=Lagos**. Sign it. Card: **Payment sent**. |
| 3 | *(wait for the reply)* | Claude gives the forecast and says the money is **held in escrow** until the dispute window closes. It may also flag that the temperature looks wrong (the demo provider's numbers are made up), which is a perfect segue. |
| 4 | *(optional)* `Yes, dispute it. That temperature is wrong.` | Claude files a dispute; the money stays in escrow for review. |
| 5 | `Now get the market headlines from the Backstop headlines service.` | Claude reads the terms, sees the service is a demo that fails on purpose, and **asks before paying**. |
| 6 | `Yes, run it. I want to see the refund in action.` | Sign the card. The response fails Backstop's checks, nothing broken reaches the agent, and the 0.01 USDC is **refunded in full**. |
| 7 | `Show my recent Backstop payments from my PayBox wallet.` | Claude shows a table: headlines **refunded in full** (with the reason) and forecast **delivered, held in escrow** (with its release time). |

Proof on Basescan (optional final shot): open the escrow contract page above and show the latest transactions.

## Script (voice-over, about 2 minutes)

> **[Landing page; toggle the trace to "Provider fails"]**
> Agents can pay for APIs now. But an x402 payment is a one-way push: if the API fails or returns junk, the money's gone. That's why every agent payment still needs a human watching.
> This is Backstop: escrow with automatic refunds for agent payments, built as a PayBox plugin, running on Base with real USDC.
>
> **[Claude: prompt 1]**
> I ask my agent for a weather service through the Backstop plugin. Every Backstop service publishes a promise the system can check: how fast it answers, what the data must contain. And its delivery record is public.
>
> **[Prompt 2; sign the PayBox card]**
> It costs one cent. PayBox asks me to approve, same as any payment. The difference is where the money goes: into Backstop's escrow contract, not to the provider.
>
> **[Claude's reply with the forecast]**
> Backstop called the provider only after the money was locked, checked the response against its promise, and it passed. My agent has the forecast, and the cent is held until the dispute window closes.
> And look: my agent thinks 34 degrees in Lagos at night is wrong. The checks passed, but I can still dispute it, and the money stays in escrow until it's resolved.
>
> **[Prompt 5; Claude asks first]**
> Now a provider that breaks its promise. My agent checks the terms first. Let's pay anyway and watch the refund happen.
>
> **[Prompt 6; sign]**
> The provider returned junk. Backstop caught it, never passed it to my agent, and refunded the full amount automatically. No ticket, no human.
>
> **[Prompt 7; the table]**
> My agent can see every outcome: one delivered and held, one refunded in full, with the reason.
>
> **[Landing page]**
> Pay only for what you receive. Backstop: a PayBox plugin, an escrow contract anyone can audit on Base, and open source code.

## Post for X (under 280 characters)

> AI agents can pay for APIs. When the API fails, the money's gone.
> Backstop fixes that: a @MoonPay PayBox plugin that pays into escrow on Base and refunds automatically when a provider breaks its promise. Real USDC, live.
> github.com/Oshioke-Salaki/backstop

Attach the video, and reply to your own post with https://backstop-base.vercel.app.

## Recording tips

- Record the whole screen at 1080p or higher, and zoom Claude to about 125% so text is readable.
- Do one full take off camera first; each take costs about 0.01 USDC net (the refund comes back).
- Speed up the waiting moments in editing, but leave the PayBox card and "Payment sent" visible.
- If a card doesn't appear on camera, just say "let's reopen the signing window": that's honest and fine.

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| No PayBox card under the reply | Send `Reopen the signing window.` |
| "Couldn't prepare wallet… operation has expired" | Click **Cancel** (not Forget); ask for a fresh request and sign within 4 minutes |
| Agent says the deployment "settles on base-sepolia" | `BACKSTOP_URL` still points at testnet; fix it in the portal |
| Backstop "did not answer" | Add `backstop-base.vercel.app` under Network access |
| Search finds no weather service | Ask it to list every Backstop service, or check the portal settings |
| Payment declined | The PayBox wallet has no USDC on Base |
