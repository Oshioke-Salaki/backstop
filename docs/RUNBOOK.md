# Runbook

How to take Backstop from this repo to a live deployment on Base Sepolia (testnet), and how to run it once it is live. The mainnet differences are at the end.

## Live deployments

**Base mainnet (real USDC, used by the PayBox plugin)**

| | |
| --- | --- |
| App | https://backstop-base.vercel.app (Vercel project `backstop-base`, Neon `backstop-base-db`) |
| Escrow contract | [`0x4F094D6FAEA6488BC094C9E041d1cAF327B82E59`](https://basescan.org/address/0x4F094D6FAEA6488BC094C9E041d1cAF327B82E59) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) (EIP-712 name `USD Coin`) |
| Keys | `.secrets/base.env` (new keys; testnet keys are never reused) |

Deploy cost measured on 2026-10-17: about 0.000012 ETH for the contract and about 0.0000015 ETH per payment. `NET=base ./script/bootstrap.sh` deploys from one funded key.

**Base Sepolia (testnet)**

| | |
| --- | --- |
| App | https://backstop-six-nu.vercel.app (Vercel project `backstop`, Neon `backstop-db`) |
| Escrow contract | [`0x435AbD2527A0Ff45c0C5A373bf6F02D703a9166a`](https://sepolia.basescan.org/address/0x435AbD2527A0Ff45c0C5A373bf6F02D703a9166a) |
| Keys | `.secrets/base-sepolia.env` |

Both deploy on every push to `main`. Verify either end to end with real payments (55 checks):

```sh
cd apps/web
# mainnet: about 0.03 USDC net per run
set -a; . ../../.secrets/base.env; . ../../.secrets/base.app.env; set +a
E2E_PRICE=0.01 BASE_URL=https://backstop-base.vercel.app pnpm e2e:live
# testnet
set -a; . ../../.secrets/base-sepolia.env; . ../../.secrets/base-sepolia.app.env; set +a
BASE_URL=https://backstop-six-nu.vercel.app pnpm e2e:live
```

The demo walkthrough and script are in [DEMO.md](DEMO.md).

## Who does what

| Step | What | Who | Time |
| --- | --- | --- | --- |
| 1 | Create the wallet keys and app secrets | Done | — |
| 2 | Fund **one** address with test ETH | Done (you) | — |
| 3 | Get test USDC for the demo payer | Done (you, 7 USDC) | — |
| 4 | Deploy and wire the escrow contract | Done | — |
| 5 | Create a Postgres database | Done (Neon via Vercel) | — |
| 6 | Deploy the app to Vercel | Done | — |
| 7 | Seed a demo provider and services | Done, verified by `pnpm e2e:live` (55 checks) | — |
| 8 | Connect PayBox and record the demo | **You** | 15 min |

## 1. Keys and secrets (done)

The keys were generated locally with Foundry's [`cast wallet new`](https://getfoundry.sh/cast/reference/cast-wallet-new). They're in `backstop/.secrets/base-sepolia.env`, which is gitignored and readable only by you (`chmod 600`). **They are testnet keys: never put real money on them and never reuse them on mainnet.**

| Role | Address | Why it is separate |
| --- | --- | --- |
| Deployer / owner | `0x4278902cAED74a5a6C2312235AFa55cfde044dEB` | Deploys and configures the contract. On mainnet this becomes a Safe multisig. |
| Depositor | `0x3730b5e137A5E2610f68A0a0D0dc876C774252e0` | Pulls signed payments into escrow (gateway). |
| Settler | `0xAbc8922B897A8Ad9F07574aAC40FcEae73D02a47` | Releases, refunds, splits (worker). |
| Registrar | `0xb1eDfFB0e169d4E1c15Ad1E83fe581445A9f098e` | Approves provider payout addresses. |
| Receipt signer | `0xb49656Fb16583e53c881A77FAa837317f1c5954B` | Signs delivery receipts. Off-chain only, needs no funds. |
| Arbiter | `0xF0dbe207B2Adf0EC908dbDd55fAde2f2cDf8187f` | Signs in to resolve disputes. Import into a browser wallet. |
| Demo payer | `0x1bB1c41A90caa4b7E5F7387AE9Ef2cA080112139` | A wallet to pay services with in demos. |

To make more keys yourself:

```sh
cast wallet new            # prints an address and private key
openssl rand -base64 48    # SESSION_SECRET / CAPABILITY_SECRET
openssl rand -base64 32    # DATA_KEY (must be exactly 32 bytes)
```

To view a private key: `grep DEPLOYER_PRIVATE_KEY backstop/.secrets/base-sepolia.env`.

To import a key into a browser wallet:
- [MetaMask](https://support.metamask.io/start/use-an-existing-wallet/#import-using-a-private-key): Account menu → Add account → Import account.
- [Rabby](https://rabby.io): Add address → Import private key.

## 2. Fund the deployer with test ETH (you)

Only the deployer needs funding. The bootstrap script forwards gas to the depositor, settler and registrar. Get **at least 0.012 Base Sepolia ETH** sent to:

```
0x4278902cAED74a5a6C2312235AFa55cfde044dEB
```

Any one of these faucets works:

- **Coinbase Developer Platform faucet**: https://portal.cdp.coinbase.com/products/faucet. Sign in with a Coinbase account, pick *Base Sepolia* and *ETH*, and paste the address. The same page also gives USDC.
- **Alchemy**: https://www.alchemy.com/faucets/base-sepolia (free Alchemy account).
- **QuickNode**: https://faucet.quicknode.com/base/sepolia
- Base's full list: https://docs.base.org/base-chain/tools/network-faucets

Check it arrived: https://sepolia.basescan.org/address/0x4278902cAED74a5a6C2312235AFa55cfde044dEB

## 3. Get test USDC for the demo payer (you)

Agents pay in USDC. Send test USDC to the demo payer (and to your PayBox wallet if you demo through PayBox):

- **Circle faucet**: https://faucet.circle.com. Choose *USDC* and *Base Sepolia*. It gives 10 USDC per claim (about 200 calls at $0.05).
- Or the CDP faucet above, with *USDC* selected.

Demo payer: `0x1bB1c41A90caa4b7E5F7387AE9Ef2cA080112139`. Base Sepolia USDC is `0x036CbD53842c5426634e7929541eC2318f3dCF7e` ([Circle's address list](https://developers.circle.com/stablecoins/usdc-contract-addresses)).

## 4. Deploy the escrow contract

```sh
cd backstop/contracts
./script/bootstrap.sh
```

The script:
- checks the RPC really is Base Sepolia (chain id 84532)
- refuses to continue until the deployer has gas
- tops up each operator with 0.003 ETH
- deploys `BackstopEscrow` with a 1% fee and a 10,000 USDC per-payment cap
- verifies the wiring on-chain
- writes `backstop/.secrets/base-sepolia.app.env`, the complete app config

It's safe to re-run, and it won't redeploy over an existing deployment. The contract appears at `https://sepolia.basescan.org/address/<escrow>`.

On testnet the deployer stays owner. For mainnet, see the last section.

## 5. Database (you sign up, Claude configures)

Vercel functions have no persistent disk, so production needs Postgres. Neon's free tier is enough:

1. Sign up at https://neon.tech and create a project (any region close to your Vercel region, e.g. `us-east-1`).
2. Copy the **pooled** connection string from *Dashboard → Connect* (it contains `-pooler`). It looks like `postgres://user:pass@ep-xxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`.
3. Give it to Claude, or add it yourself as `DATABASE_URL`.

Migrations run once per deploy as part of `pnpm build` (`scripts/migrate.ts`, using the unpooled URL), never on serverless cold starts. Alternatives: [Vercel Postgres via the Neon integration](https://vercel.com/marketplace/neon) or [Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres).

## 6. Deploy the app to Vercel

You're logged in to the Vercel CLI as `oshioke-salaki`. From `backstop/apps/web`:

```sh
vercel link                                   # create/link the project (root: backstop/apps/web)
# load every line of .secrets/base-sepolia.app.env plus DATABASE_URL:
vercel env add <NAME> production              # repeat per variable, or paste them in the dashboard
vercel deploy --prod
```

Then set `PUBLIC_BASE_URL` to the final `https://…vercel.app` (or your domain) and redeploy. SIWE sign-in and payment links depend on it.

Docs: [Vercel CLI](https://vercel.com/docs/cli), [environment variables](https://vercel.com/docs/environment-variables), [cron jobs](https://vercel.com/docs/cron-jobs).

**How settlement runs on Vercel.** There's no always-on worker, so:
- Every gateway call, dispute action and API request triggers a settlement pass after its response is sent (`settleSoon()`, using Next's [`after()`](https://nextjs.org/docs/app/api-reference/functions/after)), throttled to once every 20 seconds per instance.
- A database lease (`leases` table) allows only one pass at a time across all instances, since every pass sends from the same settler key. Concurrent deposits that clash on a nonce retry with a fresh one.
- A deposit can be briefly invisible to a load-balanced RPC. Settlement waits and retries; it never treats "not visible yet" as missing.
- `vercel.json` adds a daily cron as a backstop. The free plan allows only daily crons.
- For timely releases with no traffic, add a free per-minute pinger. For example, [cron-job.org](https://cron-job.org) calling `POST https://<host>/api/cron/tick` with header `Authorization: Bearer <CRON_SECRET>`.

On a host with long-running processes ([Railway](https://railway.com), [Render](https://render.com), [Fly](https://fly.io)), run `pnpm worker` as a second process instead.

## 7. Seed a demo provider

Providers' upstream APIs must be public https URLs: private and localhost addresses are blocked in production. For the demo, Claude can add tiny public demo endpoints to the app itself (forecast, FX, a deliberately broken one), then:
- sign in as a provider and create the services, or
- do it via the API with a provider key.

## 8. Connect PayBox (you)

1. Register at https://developer.paybox.sh and complete account setup (the hackathon terms require it).
2. Connect an agent:
   - **Claude.ai**: add the PayBox MCP connector and approve a grant for a wallet with test USDC. Docs: https://docs.paybox.sh/connect/mcp
   - **CLI**: `npx @paybox-sh/sdk login`. Docs: https://docs.paybox.sh/sdk-cli
3. Optionally add Backstop's MCP server `https://<host>/api/mcp` as a second connector.
4. Follow the demo script in [PAYBOX.md](PAYBOX.md) and post the video to X.

## Operating it

**Health.** `GET /api/health` returns 200 when both the DB and the RPC are reachable, and 503 otherwise.

**Watch for:**
- `events.type = 'settlement_stuck'`: a job failed 8 times.
- `jobs.status = 'failed'`.
- Held escrows with `deadline < now() + interval '1 hour'`: settlement is lagging.
- `events.type = 'chain_override'`: the DB disagreed with the chain. Investigate.
- Depositor or settler balance below 0.001 ETH. Top up from the deployer: `cast send <addr> --value 0.003ether --private-key $DEPLOYER_PRIVATE_KEY --rpc-url https://sepolia.base.org`.

**Incidents**

| Situation | What happens | What to do |
| --- | --- | --- |
| RPC down | New payments fail with 402/503; nobody is charged; settlements retry | Check `/api/health`; switch `RPC_URL` (e.g. [Alchemy](https://www.alchemy.com/), [QuickNode](https://www.quicknode.com/)) |
| No settlement passes for hours | Releases wait; past the grace period payers may reclaim on-chain | Hit `/api/cron/tick`; add a per-minute pinger |
| Key compromise | — | Owner calls `pause()`, then `setOperator(bad, false)`, sets the new key, calls `setOperator(new, true)`, reviews `Deposited` events, and calls `unpause()` |
| Receipt key rotated | Old receipts stay valid against the old signer | Publish the old signer address |

Owner actions from the command line, for example: `cast send $ESCROW 'pause()' --private-key $DEPLOYER_PRIVATE_KEY --rpc-url https://sepolia.base.org`.

## Mainnet differences

- Owner: a [Safe](https://app.safe.global) multisig. Pass `OWNER=<safe>` to `Deploy.s.sol` and accept ownership from the Safe.
- `NETWORK=base`, `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `USDC_NAME="USD Coin"`.
- Keys in a KMS or HSM, not in env files. Raise `CONFIRMATIONS` for high-value services. Shared rate-limit store and one depositor key per instance (see THREAT_MODEL.md).
- Verify the contract on [Basescan](https://basescan.org) (`forge verify-contract`).
