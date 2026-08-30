import Link from "next/link";

/**
 * 404 page. Reachable by typo on any dynamic segment — app/verdict/[ticker]
 * and app/dashboard/holdfold/[ticker] both accept arbitrary strings — so this
 * points back at real entry points rather than dead-ending.
 */
export const metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "70vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem 1.25rem",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "34rem",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "14px",
          padding: "2rem 1.75rem",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: ".75rem",
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: "var(--neon-yellow)",
          }}
        >
          404
        </p>
        <h1 style={{ margin: ".5rem 0 0", fontSize: "1.6rem", lineHeight: 1.25, color: "var(--text)" }}>
          We couldn&rsquo;t find that page
        </h1>
        <p style={{ margin: ".85rem 0 0", color: "var(--text-dim)", lineHeight: 1.6 }}>
          The link may be out of date, or a ticker symbol may be misspelled.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: ".75rem", marginTop: "1.5rem" }}>
          <Link
            href="/dashboard"
            style={{
              display: "inline-flex",
              alignItems: "center",
              background: "var(--neon-blue)",
              color: "#06070d",
              borderRadius: "8px",
              padding: ".7rem 1.3rem",
              fontWeight: 600,
              fontSize: ".95rem",
              textDecoration: "none",
            }}
          >
            Go to dashboard
          </Link>
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              padding: ".7rem 1.3rem",
              fontWeight: 500,
              fontSize: ".95rem",
              textDecoration: "none",
            }}
          >
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
