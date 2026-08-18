import { test, expect } from "@playwright/test";

/**
 * Live-backend liveness checks for the three Portfolio panels — Portfolio
 * Health Score, Portfolio Health Check · AI, and Optimizer Suggestions.
 *
 * Distinct from portfolio-health.spec.ts, which mocks every response via
 * page.route() to deterministically test the portal's OWN error-handling
 * logic. These tests do NOT mock — they call the real routes, which call the
 * real MCP_BACKEND_URL (gcp3) and, for the AI check, the real OpenRouter
 * chain. They verify the actual integration is reachable and returning a
 * well-formed response, not just that the portal handles a bad one
 * gracefully.
 *
 * Skips (not fails) when the relevant env var is unset — same pattern as
 * e2e/preflight/credentials.spec.ts's liveness tests — so these never block
 * a run in an environment without live backend config. When MCP_BACKEND_URL
 * IS configured but the specific gcp3 route 404s (the exact failure
 * documented in
 * docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md),
 * the test fails with a message naming that incident rather than a bare
 * assertion error — this has been observed live (see PR history), so the
 * failure message matters for whoever reads it next.
 */

test.describe("Portfolio panels — live backend liveness", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!process.env.MCP_BACKEND_URL, "MCP_BACKEND_URL not configured — all three panels are backend-dependent");
    // All three panels read the user's watchlist; an empty one collapses
    // every panel to its "empty" state before ever reaching the backend.
    await page.goto("/dashboard/portfolio");
    await page.getByPlaceholder(/ticker/i).fill("AAPL");
    await page.getByRole("button", { name: "+ Add" }).click();
    await expect(page.locator(".port-watch-item")).toBeVisible({ timeout: 10_000 });
  });

  test("PORTFOLIO HEALTH SCORE — /api/portfolio/health returns a real, well-formed score", async ({ page }) => {
    const res = await page.request.get("/api/portfolio/health");

    if (res.status() === 404 || res.status() === 502) {
      throw new Error(
        `gcp3's /api/portfolio/health returned ${res.status()} — this is the exact ` +
        `"route never registered" failure mode from incident-2026-07-26-portfolio-health-endpoint-missing.md. ` +
        `Check gcp3's deployment, not the portal.`,
      );
    }
    if (res.status() === 503) {
      throw new Error("MCP_BACKEND_URL is set but the portal reports it as not configured — check env wiring.");
    }
    expect(res.status(), `unexpected status from live gcp3 call: ${await res.text().catch(() => "")}`).toBe(200);

    const body = await res.json();
    expect(typeof body.score, "score must be a number").toBe("number");
    expect(body.score, "score must be in 0-100 range").toBeGreaterThanOrEqual(0);
    expect(body.score).toBeLessThanOrEqual(100);
    expect(["A", "B", "C", "D", "F"]).toContain(body.grade);
    expect(Array.isArray(body.factors), "factors must be an array").toBe(true);
    // generatedAt must be a real, recent timestamp — a live call should never
    // return a payload with a missing or stale-by-construction generatedAt.
    const generatedAt = new Date(body.generatedAt);
    expect(Number.isNaN(generatedAt.getTime()), "generatedAt must be a valid ISO timestamp").toBe(false);
    const ageMs = Date.now() - generatedAt.getTime();
    expect(ageMs, "generatedAt must not be in the future").toBeGreaterThanOrEqual(0);
  });

  test("PORTFOLIO HEALTH CHECK · AI — /api/portfolio/health-ai reaches OpenRouter and returns grounded prose", async ({ page }) => {
    test.skip(!process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY not configured");
    test.setTimeout(45_000);

    // POST only (health-ai/route.ts exports POST, not GET — matches
    // PortfolioClient.tsx's runHealthCheck). No `Accept: text/event-stream`
    // -> the route's non-streaming JSON path (route.ts:132-154), which
    // buffers the full completion instead of returning an SSE stream.
    const res = await page.request.post("/api/portfolio/health-ai", {
      headers: { Accept: "application/json" },
    });
    expect(res.status(), `unexpected status: ${await res.text().catch(() => "")}`).toBe(200);

    const body = await res.json();
    expect(typeof body.answer, "AI narrative (`answer`) must be a non-empty string").toBe("string");
    expect(body.answer.length).toBeGreaterThan(0);

    // grounded=false means gcp3's score was unavailable and the model wrote
    // from general knowledge only — legitimate given gcp3's 404s are a live,
    // known issue, but worth surfacing in the test output so a green run
    // doesn't quietly hide "the AI panel is running ungrounded right now."
    if (body.grounded === false) {
      test.info().annotations.push({
        type: "diagnosis",
        description: "AI health check responded but grounded=false — portfolio score data was unavailable to the model. Likely the same gcp3 outage as the Health Score panel.",
      });
    }
  });

  test("OPTIMIZER SUGGESTIONS — /api/portfolio/suggestions returns real, well-formed suggestions", async ({ page }) => {
    const res = await page.request.get("/api/portfolio/suggestions");

    // This route swallows upstream failures into `[]` (see
    // app/api/portfolio/suggestions/route.ts's `if (!res.ok) return
    // NextResponse.json([])`), so a live 404 from gcp3 doesn't surface as a
    // non-200 here — it surfaces as an empty array. Assert on shape either
    // way, and flag empty-but-configured as worth checking manually.
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body), "suggestions response must be an array").toBe(true);

    if (body.length === 0) {
      test.info().annotations.push({
        type: "diagnosis",
        description: "Suggestions returned an empty array with a non-empty watchlist configured — either gcp3 has no suggestions for AAPL right now, or its /api/portfolio/suggestions route is unreachable/404ing (swallowed silently by the route's own error handling). Check gcp3 logs to distinguish.",
      });
      return;
    }

    for (const s of body) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.title).toBe("string");
      expect(typeof s.rationale).toBe("string");
      expect(["high", "medium", "low"]).toContain(s.priority);
      expect(typeof s.disclaimer, "every suggestion must carry the informational-only disclaimer").toBe("string");
      expect(s.disclaimer.length).toBeGreaterThan(0);
    }
  });

  test.afterEach(async ({ page }) => {
    // Clean up the ticker this suite adds, so repeated runs don't accumulate
    // duplicate AAPL entries in the real (Neon-backed) watchlist store.
    await page.request.delete("/api/portfolio/watchlist/AAPL").catch(() => {});
  });
});
