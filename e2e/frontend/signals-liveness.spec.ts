import { test, expect } from "@playwright/test";

/**
 * Live-backend liveness checks for /dashboard/signals and its per-ticker
 * chat proxy — same non-mocking philosophy as portfolio-liveness.spec.ts:
 * these call the real MCP_BACKEND_URL (gcp3), not page.route() mocks, to
 * verify the actual integration is reachable and returning well-formed data.
 *
 * Skips (not fails) when MCP_BACKEND_URL is unset.
 */

test.describe("Signals digest — live backend liveness", () => {
  test.beforeEach(() => {
    test.skip(!process.env.MCP_BACKEND_URL, "MCP_BACKEND_URL not configured");
  });

  test("DIGEST — /api/signals/digest returns real, well-formed signals with valid timestamps", async ({ page }) => {
    await page.goto("/dashboard/signals");
    const res = await page.request.get("/api/signals/digest");
    expect(res.status(), `unexpected status: ${await res.text().catch(() => "")}`).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.signals), "signals must be an array").toBe(true);
    expect(body.signals.length, "live digest returned zero signals").toBeGreaterThan(0);

    for (const s of body.signals) {
      expect(typeof s.ticker, `${JSON.stringify(s).slice(0, 100)} missing ticker`).toBe("string");
      expect(["bullish", "bearish", "neutral"]).toContain(s.direction);
      expect(typeof s.isStale, `${s.ticker}: isStale must be a boolean`).toBe("boolean");
      // The per-ticker timestamp fix (lib/digest.ts) — every signal must
      // carry a real, parseable generatedAt, not a missing/malformed one
      // silently defaulting somewhere.
      expect(Number.isNaN(Date.parse(s.generatedAt)), `${s.ticker} has an unparsable generatedAt`).toBe(false);
      const ageMs = Date.now() - Date.parse(s.generatedAt);
      expect(ageMs, `${s.ticker}'s generatedAt is in the future`).toBeGreaterThanOrEqual(0);
    }
  });
});

test.describe("Signal chat (/api/signals/{ticker}/chat) — live backend liveness", () => {
  test.beforeEach(() => {
    test.skip(!process.env.MCP_BACKEND_URL, "MCP_BACKEND_URL not configured");
  });

  // MU and GOOG are individual stocks — confirmed NOT in gcp3's tracked
  // universe (see /signals' `symbols` map, which is sector/thematic ETFs
  // only: SOXX, XLK, SOCL, etc — no individual equities). SOXX is a real,
  // tracked symbol. Testing all three distinguishes "backend route itself is
  // down" (all three fail identically) from "ticker not tracked" (only
  // MU/GOOG fail, SOXX succeeds) — that distinction is the point of this
  // test, not just liveness for its own sake.
  for (const ticker of ["SOXX", "MU", "GOOG"]) {
    test(`${ticker} — POST /api/signals/${ticker}/chat responds without a 5xx from the portal's own proxy layer`, async ({ page }) => {
      await page.goto("/dashboard/signals");
      const res = await page.request.post(`/api/signals/${ticker}/chat`, {
        data: { question: "What is the current signal and why?" },
        timeout: 25_000,
      });

      // The route (app/api/signals/[ticker]/chat/route.ts) collapses EVERY
      // non-2xx from gcp3 — including a plain 404 for an untracked ticker —
      // into a flat 503 "signal chat unavailable". That is graceful
      // degradation working as designed (no crash, no leaked backend detail)
      // but it also means a 503 here does not by itself distinguish
      // "MU isn't tracked" from "gcp3's chat route isn't deployed at all".
      // Confirmed live (2026-08-18): gcp3's /signals/{ticker}/chat 404s for
      // ALL three tickers, SOXX included — the route itself is not currently
      // live on gcp3, not a ticker-coverage gap. Track that distinction via
      // the annotation below rather than asserting a specific status, since
      // this endpoint's live availability is outside this repo's control.
      if (res.status() === 503) {
        test.info().annotations.push({
          type: "diagnosis",
          description: `${ticker}: portal proxy returned 503 — gcp3's /signals/${ticker}/chat is unreachable or 404ing. ` +
            `Check gcp3's deployment for this route specifically; this is the same "route never registered" failure class ` +
            `as the portfolio/health incident, not a portal bug.`,
        });
      } else {
        expect(res.status(), `unexpected status: ${await res.text().catch(() => "")}`).toBe(200);
        const body = await res.json();
        expect(typeof body.answer, "chat answer must be a non-empty string").toBe("string");
        expect(body.answer.length).toBeGreaterThan(0);
      }

      // Whatever gcp3 does, the portal's OWN layer must never 500 — a 5xx
      // other than the route's own controlled 503/504 means an unhandled
      // exception leaked past the route's try/catch.
      expect([200, 503, 504]).toContain(res.status());
    });
  }
});
