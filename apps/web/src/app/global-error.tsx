"use client";

/** Replaces the root layout when it fails, so it carries its own minimal styling. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f3f4f1", color: "#0b0d0c", margin: 0 }}>
        <title>Backstop is unavailable</title>
        <div style={{ maxWidth: 560, margin: "0 auto", padding: "96px 16px" }} role="alert">
          <h1 style={{ fontSize: 28, fontWeight: 500, margin: 0 }}>Backstop is temporarily unavailable</h1>
          <p style={{ color: "#3d433f", lineHeight: 1.55 }}>
            Payments already in escrow are safe: the contract lets payers reclaim them after their deadline, with or without this site.
          </p>
          <button onClick={() => retry()} style={{ marginTop: 16, height: 40, padding: "0 16px", borderRadius: 6, border: 0, background: "#0e6b4f", color: "#fff", fontSize: 15, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
