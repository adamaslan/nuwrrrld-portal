"use client";

import { useEffect } from "react";

/**
 * Fires one first-party attribution capture per page load
 * (docs/todo-auth-cookies-tracking.md Phase 4.1).
 *
 * Renders nothing. Posts only what the browser already gave us — the current
 * query string, the referrer, and the landing path — to /api/attribution, which
 * is itself consent-gated: it returns 204 and stores nothing unless
 * `nu_consent.analytics` is true (GPC/DNT already forces that off). The gate
 * lives on the server deliberately; a client-side-only check would be
 * bypassable and unauditable.
 *
 * Deliberately does NOT read or send: cookies, localStorage, user identifiers,
 * or anything about the page's content. The route associates the touch with a
 * Clerk user itself when a session is present.
 */
export default function AttributionCapture() {
  useEffect(() => {
    // Nothing to attribute on a bare direct visit with no referrer — skip the
    // request entirely rather than posting an empty body.
    const hasQuery = window.location.search.length > 1;
    const hasReferrer = document.referrer.length > 0;
    if (!hasQuery && !hasReferrer) return;

    const controller = new AbortController();

    void fetch("/api/attribution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: window.location.search,
        referrer: document.referrer,
        landing_path: window.location.pathname,
      }),
      signal: controller.signal,
      // Attribution must never block or retry into a navigation.
      keepalive: true,
    }).catch(() => {
      // Best-effort: a failed capture is a lost data point, never a user-facing
      // error. Matches the fail-open posture of lib/attribution-db.ts.
    });

    return () => controller.abort();
  }, []);

  return null;
}
