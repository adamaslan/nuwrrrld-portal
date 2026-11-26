import Link from "next/link";
import { NWF2_MESSAGE } from "@/lib/nwf2";

// Shown in place of a surface that is not production ready yet. Uses the same
// tokens, spacing and typography as the dashboard pages (app/globals.css).
export default function Nwf2Placeholder({ title, back = "/dashboard", backLabel = "← Dashboard" }: { title: string; back?: string; backLabel?: string }) {
  return (
    <main
      style={{
        width: "100%",
        maxWidth: 960,
        margin: "0 auto",
        padding: "2.5rem 1.5rem 4rem",
        fontFamily: "var(--font-geist-sans, system-ui, sans-serif)",
      }}
    >
      <Link
        href={back}
        style={{ color: "var(--neon-blue)", fontSize: "0.85rem", textDecoration: "none", display: "inline-block", marginBottom: "0.75rem" }}
      >
        {backLabel}
      </Link>
      <h1 style={{ fontSize: "1.9rem", fontWeight: 700, color: "var(--text)", margin: "0 0 0.4rem", letterSpacing: "-0.01em" }}>{title}</h1>
      <div
        style={{
          marginTop: "1.75rem",
          textAlign: "center",
          padding: "3rem 1rem",
          border: "1px dashed var(--border)",
          background: "var(--surface)",
        }}
      >
        <span
          style={{
            display: "inline-block",
            fontSize: "0.7rem",
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: "var(--neon-blue)",
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            padding: "0.1rem 0.5rem",
            marginBottom: "0.9rem",
          }}
        >
          NWF 2.0
        </span>
        <p data-testid="nwf2-message" style={{ color: "var(--text-dim)", fontSize: "0.9rem", lineHeight: 1.6, margin: 0 }}>
          {NWF2_MESSAGE}
        </p>
      </div>
    </main>
  );
}
