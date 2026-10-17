"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";

type Scenario = "delivers" | "fails";

interface Step {
  actor: "Agent" | "Backstop" | "Provider" | "Chain";
  text: string;
  detail?: string;
  /** Where the $0.05 sits after this step. */
  funds: "payer" | "escrow" | "provider";
  tone?: "ok" | "bad";
}

const STEPS: Record<Scenario, Step[]> = {
  delivers: [
    { actor: "Agent", text: "GET /x/skyline-forecast?city=Lagos", funds: "payer" },
    { actor: "Backstop", text: "402 Payment Required", detail: "payTo: escrow · 0.05 USDC · refund on failed checks", funds: "payer" },
    { actor: "Agent", text: "Retries with a signed USDC authorization", detail: "PayBox pay_x402 · no gas, no key exposure", funds: "payer" },
    { actor: "Chain", text: "0.05 USDC locked in escrow", detail: "deposit() confirmed", funds: "escrow" },
    { actor: "Provider", text: "200 OK in 182 ms", detail: '{ "city": "Lagos", "temperature": 29.5 }', funds: "escrow" },
    { actor: "Backstop", text: "Checks pass: status, latency, schema, fields", detail: "Signed receipt returned with the response", funds: "escrow", tone: "ok" },
    { actor: "Chain", text: "Released to provider after the dispute window", detail: "0.0495 to provider · 0.0005 fee", funds: "provider", tone: "ok" },
  ],
  fails: [
    { actor: "Agent", text: "GET /x/skyline-forecast?city=Lagos", funds: "payer" },
    { actor: "Backstop", text: "402 Payment Required", detail: "payTo: escrow · 0.05 USDC · refund on failed checks", funds: "payer" },
    { actor: "Agent", text: "Retries with a signed USDC authorization", detail: "PayBox pay_x402 · no gas, no key exposure", funds: "payer" },
    { actor: "Chain", text: "0.05 USDC locked in escrow", detail: "deposit() confirmed", funds: "escrow" },
    { actor: "Provider", text: "200 OK in 3,410 ms", detail: '{ "error": "upstream unavailable" }', funds: "escrow" },
    { actor: "Backstop", text: "Check failed: response did not match its promised shape", detail: "Agent gets 502 with the reason. The bad body is withheld.", funds: "escrow", tone: "bad" },
    { actor: "Chain", text: "Refunded in full to the payer", detail: "0.05 back · no fee · no ticket", funds: "payer", tone: "ok" },
  ],
};

const STEP_MS = 900;

export function PaymentTrace() {
  const [scenario, setScenario] = useState<Scenario>("delivers");
  const [shown, setShown] = useState(1);
  const [run, setRun] = useState(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  useEffect(() => {
    const total = STEPS[scenario].length;
    if (reduced.current) {
      setShown(total);
      return;
    }
    setShown(1);
    let n = 1;
    const t = setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= total) clearInterval(t);
    }, STEP_MS);
    return () => clearInterval(t);
  }, [scenario, run]);

  const steps = STEPS[scenario];
  const current = steps[Math.min(shown, steps.length) - 1]!;
  const finished = shown >= steps.length;

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div role="radiogroup" aria-label="What the provider does" className="inline-flex rounded-md bg-sunken p-1">
          {(["delivers", "fails"] as const).map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={scenario === s}
              onClick={() => setScenario(s)}
              className={cx(
                "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                scenario === s ? "bg-surface text-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              {s === "delivers" ? "Provider delivers" : "Provider fails"}
            </button>
          ))}
        </div>
        <button onClick={() => setRun((r) => r + 1)} className="text-sm text-ink-3 hover:text-ink">
          Replay
        </button>
      </div>

      <div className="grid grid-cols-1 gap-0 md:grid-cols-[1fr_15rem]">
        <ol className="flex min-h-[27rem] flex-col gap-0 px-4 py-4 sm:min-h-[23rem] sm:px-5" aria-live="polite">
          {steps.slice(0, shown).map((step, i) => (
            <li key={`${scenario}-${i}`} className="animate-rise grid grid-cols-[5.5rem_1fr] gap-3 py-2">
              <span className="pt-0.5 text-sm text-ink-3">{step.actor}</span>
              <div className="min-w-0">
                <p className={cx("text-[15px] text-ink", step.tone === "bad" && "text-failed", step.tone === "ok" && i === steps.length - 1 && "text-released")}>{step.text}</p>
                {step.detail && <p className="mt-0.5 font-mono text-[13px] break-words text-ink-3">{step.detail}</p>}
              </div>
            </li>
          ))}
          {!finished && (
            <li className="grid grid-cols-[5.5rem_1fr] gap-3 py-2" aria-hidden="true">
              <span />
              <span className="inline-block size-2 rounded-full bg-ink-3 animate-pulse-dot" />
            </li>
          )}
        </ol>

        <div className="flex flex-col justify-center gap-3 border-t border-line px-4 py-5 sm:px-5 md:border-t-0 md:border-l">
          <p className="text-sm text-ink-3">Where the 0.05 USDC is</p>
          {(["payer", "escrow", "provider"] as const).map((place) => {
            const here = current.funds === place;
            return (
              <div
                key={place}
                className={cx(
                  "flex items-center justify-between rounded-md px-3 py-2.5 transition-colors duration-300",
                  here ? (place === "escrow" ? "bg-held-soft" : "bg-released-soft") : "bg-sunken",
                )}
              >
                <span className={cx("text-[15px]", here ? "font-medium text-ink" : "text-ink-3")}>
                  {place === "payer" ? "Agent's wallet" : place === "escrow" ? "Escrow contract" : "Provider"}
                </span>
                <span className={cx("tabular font-mono text-sm", here ? "text-ink" : "text-ink-3")}>
                  {here ? (place === "provider" ? "0.0495" : "0.05") : "0.00"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
