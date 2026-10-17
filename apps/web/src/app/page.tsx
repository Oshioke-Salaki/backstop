import Link from "next/link";
import { PaymentTrace } from "@/components/payment-trace";
import { ButtonLink } from "@/components/ui";

const GUARANTEES: Array<[string, string]> = [
  ["Only two destinations", "The contract can pay the provider bound at deposit, or the payer. No one else, including Backstop."],
  ["Payer reclaim", "If a payment is still held after its deadline, anyone can send it back to the payer. Backstop being offline changes nothing."],
  ["Owner cannot touch escrow", "The admin key configures fees and operators. It has no path to funds that are held."],
  ["Pausing never traps money", "A pause stops new deposits only. Refunds and reclaims keep working."],
  ["Capped fees", "Fees are fixed at deposit and can never exceed 5%. Refunds carry no fee at all."],
];

const CHECKS = [
  "HTTP status the provider promised",
  "Response time under its stated limit",
  "Size cap, enforced while streaming",
  "Content type",
  "JSON Schema of the response",
  "Field rules: present, non-empty, in range, one of",
];

export default function Home() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-6 sm:pt-24">
        <div className="max-w-3xl">
          <h1 className="text-[40px] leading-[1.05] font-medium tracking-tight text-ink sm:text-[64px]">Agent payments that refund themselves.</h1>
          <p className="mt-6 max-w-2xl text-lg text-ink-2 sm:text-xl">
            Backstop holds every x402 payment in escrow until the provider&apos;s response passes the checks it promised. Anything less is refunded in full,
            automatically, with no ticket to file.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/services" size="lg">
              Find protected services
            </ButtonLink>
            <ButtonLink href="/dashboard" size="lg" variant="secondary">
              List your API
            </ButtonLink>
          </div>
        </div>
        <div className="mt-14">
          <PaymentTrace />
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-20 sm:px-6 md:grid-cols-2 md:gap-16">
        <div>
          <h2 className="text-[28px] leading-tight font-medium tracking-tight sm:text-[36px]">Money reaches the provider only after the work does.</h2>
          <p className="mt-5 text-[17px] text-ink-2">
            The agent pays the escrow contract, not the provider. Backstop calls the provider only once the deposit is confirmed, then judges the response against
            the provider&apos;s own published promise. The verdict is signed, so either side can prove it later.
          </p>
          <p className="mt-4 text-[17px] text-ink-2">
            Passing deliveries wait out a short dispute window, set by the provider, before release. Failing ones never reach the agent and are refunded on the spot.
          </p>
        </div>
        <div className="rounded-lg bg-sunken p-6 sm:p-8">
          <p className="text-[15px] font-medium text-ink">Every response is checked for</p>
          <ul className="mt-4 flex flex-col gap-3">
            {CHECKS.map((c) => (
              <li key={c} className="flex gap-3 text-[15px] text-ink-2">
                <span className="mt-2 inline-block size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="bg-surface py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="max-w-3xl text-[28px] leading-tight font-medium tracking-tight sm:text-[36px]">If Backstop disappeared tomorrow, payers would still get their money back.</h2>
          <p className="mt-5 max-w-2xl text-[17px] text-ink-2">
            The guarantees live in the escrow contract, not in our servers. Read them in{" "}
            <Link href="/docs/security" className="text-ink underline underline-offset-2">
              how funds are protected
            </Link>
            .
          </p>
          <dl className="mt-12 grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {GUARANTEES.map(([title, text]) => (
              <div key={title}>
                <dt className="font-medium text-ink">{title}</dt>
                <dd className="mt-1.5 text-[15px] text-ink-2">{text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <h2 className="text-[28px] leading-tight font-medium tracking-tight sm:text-[36px]">Works with the PayBox tools your agent already has.</h2>
          <p className="mt-5 text-[17px] text-ink-2">
            A Backstop endpoint is a normal x402 resource whose <span className="font-mono text-[15px]">payTo</span> is the escrow. PayBox&apos;s{" "}
            <span className="font-mono text-[15px]">pay_x402</span> signs it like any other, with your wallet&apos;s spending policy applied. Add the Backstop MCP
            server and the agent can also check payments and file disputes itself.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/docs/agents" variant="secondary">
              Agent guide
            </ButtonLink>
            <ButtonLink href="/docs/providers" variant="ghost">
              Provider guide
            </ButtonLink>
          </div>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-ink p-5 font-mono text-[13px] leading-relaxed text-ground">
          <code>{`# 1. Ask: Backstop answers 402 with escrow terms
curl -i https://backstop.example/x/skyline-forecast?city=Lagos

# 2. Pay through PayBox, then retry with the header
paybox pay-x402 --url https://backstop.example/x/skyline-forecast?city=Lagos

# 3. The response carries proof and a status link
x-backstop-escrow-id:   0x8a50…a86e
x-backstop-status:      release_pending
x-backstop-receipt:     eyJyZWNlaXB0Ijp7…
x-backstop-payment-url: https://backstop.example/p/0x8a50…?t=…`}</code>
        </pre>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="flex flex-col gap-8 rounded-lg border border-line p-6 sm:p-10 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl">
            <h2 className="text-[24px] leading-tight font-medium tracking-tight sm:text-[30px]">1% of what you are paid. Refunds cost nothing.</h2>
            <p className="mt-3 text-[16px] text-ink-2">
              Providers set their own price, checks and dispute window, and test them against their live API before going public. No payment, no fee.
            </p>
          </div>
          <ButtonLink href="/dashboard" size="lg">
            Start as a provider
          </ButtonLink>
        </div>
      </section>
    </>
  );
}
