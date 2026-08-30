"use client";

import { useEffect } from "react";

/**
 * Route-segment error boundary for everything under app/.
 *
 * Server Component errors arrive here with a generic message and a `digest`
 * hash — the real text stays server-side so it cannot leak to the client.
 * Surfacing the digest is what makes a support email actionable: it is the
 * only string that ties what the user saw to a server log line.
 */
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[route-error]", error.digest ?? "(no digest)", error);
  }, [error]);

  return (
    <main style={styles.wrap}>
      <div style={styles.card}>
        <p style={styles.kicker}>Something broke</p>
        <h1 style={styles.h1}>This page didn&rsquo;t load</h1>
        <p style={styles.body}>
          The error has been logged. Trying again often works — the cause is
          frequently temporary.
        </p>

        <div style={styles.row}>
          <button type="button" onClick={() => unstable_retry()} style={styles.primary}>
            Try again
          </button>
          <a href="/dashboard" style={styles.secondary}>
            Back to dashboard
          </a>
        </div>

        {error.digest ? (
          <p style={styles.digest}>
            Reference code <code style={styles.code}>{error.digest}</code>
            <br />
            Include it if you email <a href="mailto:chillcoders@gmail.com" style={styles.link}>chillcoders@gmail.com</a>.
          </p>
        ) : null}
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: "70vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "2rem 1.25rem",
  },
  card: {
    width: "100%",
    maxWidth: "34rem",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "14px",
    padding: "2rem 1.75rem",
  },
  kicker: {
    margin: 0,
    fontSize: ".75rem",
    letterSpacing: ".14em",
    textTransform: "uppercase",
    color: "var(--neon-red)",
  },
  h1: {
    margin: ".5rem 0 0",
    fontSize: "1.6rem",
    lineHeight: 1.25,
    color: "var(--text)",
  },
  body: {
    margin: ".85rem 0 0",
    color: "var(--text-dim)",
    lineHeight: 1.6,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: ".75rem",
    marginTop: "1.5rem",
  },
  primary: {
    background: "var(--neon-blue)",
    color: "#06070d",
    border: "none",
    borderRadius: "8px",
    padding: ".7rem 1.3rem",
    fontWeight: 600,
    fontSize: ".95rem",
    cursor: "pointer",
    boxShadow: "var(--glow-blue)",
  },
  secondary: {
    display: "inline-flex",
    alignItems: "center",
    background: "transparent",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    padding: ".7rem 1.3rem",
    fontWeight: 500,
    fontSize: ".95rem",
    textDecoration: "none",
  },
  digest: {
    margin: "1.5rem 0 0",
    paddingTop: "1.1rem",
    borderTop: "1px solid var(--border)",
    fontSize: ".85rem",
    color: "var(--text-dim)",
    lineHeight: 1.7,
  },
  code: {
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "5px",
    padding: ".15rem .45rem",
    fontFamily: "var(--font-geist-mono), monospace",
    color: "var(--text)",
  },
  link: { color: "var(--neon-blue)" },
};
