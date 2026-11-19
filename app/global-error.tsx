"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary: catches errors thrown by the root layout itself,
 * which app/error.tsx cannot see (error.js does not wrap the layout above it
 * in the same segment). This replaces the root layout when active, so it has
 * to supply its own <html>/<body> and cannot rely on globals.css being
 * applied — every colour here is therefore a literal, not a var().
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[global-error]", error.digest ?? "(no digest)", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          color: "#111111",
          fontFamily: "Arial, Helvetica, sans-serif",
          padding: "2rem 1.25rem",
        }}
      >
        <title>Something went wrong · NuWrrrld Financial</title>
        <div
          style={{
            width: "100%",
            maxWidth: "34rem",
            background: "#ffffff",
            border: "2px solid #111111",
            borderRadius: "0",
            padding: "2rem 1.75rem",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: ".75rem",
              letterSpacing: ".14em",
              textTransform: "uppercase",
              color: "#111111",
            }}
          >
            Application error
          </p>
          <h1 style={{ margin: ".5rem 0 0", fontSize: "1.6rem", lineHeight: 1.25 }}>
            NuWrrrld Financial couldn&rsquo;t start
          </h1>
          <p style={{ margin: ".85rem 0 0", color: "#555555", lineHeight: 1.6 }}>
            This is an error in the application shell itself. It has been logged.
          </p>

          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              marginTop: "1.5rem",
              background: "#111111",
              color: "#ffffff",
              border: "2px solid #111111",
              borderRadius: "0",
              padding: ".7rem 1.3rem",
              fontWeight: 600,
              fontSize: ".95rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>

          {error.digest ? (
            <p
              style={{
                margin: "1.5rem 0 0",
                paddingTop: "1.1rem",
                borderTop: "1px solid #111111",
                fontSize: ".85rem",
                color: "#555555",
                lineHeight: 1.7,
              }}
            >
              Reference code <code style={{ color: "#111111", fontWeight: 700 }}>{error.digest}</code>
              <br />
              Include it if you email{" "}
              <a href="mailto:chillcoders@gmail.com" style={{ color: "#111111", textDecoration: "underline" }}>
                chillcoders@gmail.com
              </a>
              .
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
