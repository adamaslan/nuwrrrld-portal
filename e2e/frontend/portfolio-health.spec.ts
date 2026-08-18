import { test, expect } from "@playwright/test";

/**
 * Diagnostic suite for the Portfolio Health / Track Record failures tracked
 * in docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md.
 *
 * The incident's core finding: THREE independent backend gaps render the
 * SAME user-facing strings ("Health score unavailable", "Health check
 * returned empty", "Historical hit-rate data unavailable"), which is what
 * made this so slow to diagnose originally. Each test below intercepts at a
 * different layer specifically so a failure here tells you *which* layer
 * broke instead of reproducing the same ambiguous symptom.
 *
 * Layers, by env var:
 *   MCP_BACKEND_URL      -> gcp3 /api/portfolio/health (numeric score)
 *   OPENROUTER_API_KEY   -> health-ai narrative (T2 council)
 *   SIGNALS_ENGINE_URL   -> separate signals-app backtest engine (track record)
 * These are three DIFFERENT backends. A green run on one tells you nothing
 * about the other two — see docs/e2e.md §4 "blocked is not fail".
 */

test.describe("Portfolio Health Score (/api/portfolio/health)", () => {
  test("DIAGNOSE: gcp3 returning non-ok (incl. the incident's actual 404-route-never-registered case) collapses to one generic 502", async ({ page }) => {
    // app/api/portfolio/health/route.ts: any !res.ok from gcp3 — a 404
    // because the route was never registered (the incident's real cause), a
    // 500 because the backend crashed, anything — becomes a flat
    // `{ error: "upstream error" }`, 502. This test reproduces that
    // collapsed state; it does NOT distinguish 404 from 5xx, because the
    // portal code doesn't either. If you're debugging a live "Health score
    // unavailable" report, this ambiguity means you must check gcp3's own
    // logs for the real status — the portal's response won't tell you.
    await page.route("**/api/portfolio/health", (route) =>
      route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "upstream error" }) }),
    );

    await page.goto("/dashboard/portfolio");
    await page.getByRole("button", { name: /run health score/i }).click();

    const errorNode = page.locator(".port-health-error");
    await expect(errorNode).toBeVisible();
    const text = await errorNode.textContent();

    // The incident's own complaint: this string does not distinguish
    // "route missing" from "GCP3 backend down" from "MCP_BACKEND_URL unset".
    // If this assertion is what's failing, that ambiguity is still live —
    // check server logs for the actual upstream status, this UI can't tell you.
    expect(text, "generic error string gives no root-cause signal — see incident doc").toMatch(
      /unavailable|not configured/i,
    );
  });

  test("DIAGNOSE: contract drift — gcp3 emits ai_grade/ai_insights, portal expects score/factors/summary", async ({ page }) => {
    // Mirrors the incident's documented field-name mismatch table. If gcp3
    // is ever wired up WITHOUT the to_health_contract() adapter, this is
    // exactly the payload shape it would send — and the portal's defensive
    // parsing (`typeof raw.score === 'number' ? ... : 0`) silently turns it
    // into "score 0, Grade F for every user" rather than an error.
    await page.route("**/api/portfolio/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ai_grade: "B",
          ai_concentration: 0.42,
          ai_avg_change_pct: 1.8,
          ai_insights: ["Diversification is reasonable."],
          // deliberately no `score` field — this is what an unadapted
          // gcp3 response looks like.
        }),
      }),
    );

    await page.goto("/dashboard/portfolio");
    await page.getByRole("button", { name: /run health score/i }).click();

    // EXPECTED TO FAIL if the adapter regresses: this proves the silent
    // "score 0 / Grade F" failure mode the incident calls out as WORSE than
    // an error, because it renders as a real result.
    const scoreText = await page.locator(".port-health-result").textContent();
    expect(
      scoreText,
      'contract-drift payload rendered as a real score instead of being rejected — see incident "Contract drift" section',
    ).not.toMatch(/Grade F/);
  });

  test("EXPOSE: empty watchlist (204) must never render as an error", async ({ page }) => {
    await page.route("**/api/portfolio/health", (route) => route.fulfill({ status: 204 }));
    await page.goto("/dashboard/portfolio");
    await page.getByRole("button", { name: /run health score/i }).click();

    // scoreStatus must land on "empty" (port-watch-empty copy), not "error".
    await expect(page.locator(".port-health-error")).not.toBeVisible();
    await expect(page.locator(".port-watch-empty")).toBeVisible();
  });
});

test.describe("Portfolio Health Check · AI (/api/portfolio/health-ai)", () => {
  test("DIAGNOSE: AI narrative renders ungrounded prose without the warning banner", async ({ page }) => {
    // fetchHealth() in health-ai/route.ts catches everything and returns
    // null when gcp3 is unreachable, so the prompt silently degrades to
    // "Portfolio health data: unavailable (no GCP3 backend connection)" and
    // the model still produces confident-sounding prose. The ONLY signal
    // the client has that this happened is X-Portfolio-Health-Grounded.
    await page.route("**/api/portfolio/health-ai", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "X-Portfolio-Health-Grounded": "false" },
        body: JSON.stringify({
          answer: "1) Overall Assessment: D. Health metrics are unavailable (GCP3 disconnected).",
          grounded: false,
        }),
      }),
    );

    await page.goto("/dashboard/portfolio");
    await page.getByRole("button", { name: /run ai health check/i }).click();

    // If this fails, the grounded=false signal is present in the response
    // but the UI isn't surfacing it — check healthGrounded wiring in
    // PortfolioClient.tsx around the X-Portfolio-Health-Grounded read.
    const result = page.locator(".port-health-result");
    await expect(result, "ungrounded AI response rendered with no warning to the user").toContainText(
      /ungrounded|no.*data|GCP3 disconnected|unavailable/i,
    );
  });

  test("DIAGNOSE: HTTP-200-but-empty completion from every fallback model", async ({ page }) => {
    // fetchWithModelFallbackChecked exists specifically to catch a 200 with
    // an empty body advancing through every model in the chain and still
    // coming back empty — this reproduces exactly that terminal state.
    await page.route("**/api/portfolio/health-ai", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer: "" }) }),
    );

    await page.goto("/dashboard/portfolio");
    await page.getByRole("button", { name: /run ai health check/i }).click();

    // If ALL free-tier OpenRouter models are exhausted/empty, PortfolioClient
    // sets "Health check returned empty — try again." This is the terminal
    // failure state, not a bug on its own — but if this test is red while
    // OPENROUTER_API_KEY is valid (see e2e/preflight), the fallback chain
    // itself is broken, not just rate-limited. Cross-reference against
    // e2e/preflight/credentials.spec.ts's OpenRouter liveness check.
    await expect(page.locator(".port-health-error")).toContainText(/returned empty/i);
  });

  test("EXPOSE: PortfolioClient sends no Accept header on the AI health request", async ({ page }) => {
    // The incident doc flags this as an independently-discovered defect:
    // adding Accept-based negotiation to /api/nuai surfaced that
    // PortfolioClient.tsx never sent an Accept header for health-ai at all.
    // If this route.fulfill() intercepts and the request DID carry an
    // Accept header for SSE, the code has since been fixed — update the
    // incident doc's "Open items" section rather than deleting this test.
    let capturedAccept: string | null = null;
    await page.route("**/api/portfolio/health-ai", async (route) => {
      capturedAccept = route.request().headers()["accept"] ?? null;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer: "ok", grounded: true }) });
    });

    await page.goto("/dashboard/portfolio");
    await page.getByRole("button", { name: /run ai health check/i }).click();
    await page.waitForTimeout(500);

    expect(
      capturedAccept,
      "no Accept header sent — legacy mobile builds expecting JSON would get an unparseable SSE stream if the server defaults to it",
    ).toContain("text/event-stream");
  });
});

test.describe("Optimizer Suggestions (/api/portfolio/suggestions)", () => {
  test("DIAGNOSE: suggestions silently fail with a generic message, masking the actual HTTP status", async ({ page }) => {
    await page.route("**/api/portfolio/suggestions", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }),
    );

    await page.goto("/dashboard/portfolio");

    // PortfolioClient's .catch(() => setSuggestionsStatus("error")) discards
    // the actual status code entirely — 401 (session expired), 503 (backend
    // down), and a malformed JSON response ALL render identically. If this
    // is the thing you're debugging, the fix is capturing res.status in
    // suggestionsStatus, not just "error" | "ok".
    await expect(page.locator(".port-health-error")).toContainText(/suggestions unavailable/i);
  });
});

test.describe("Track Record / backtest (/api/backtest/{symbol})", () => {
  // TrackRecordBadge (components/TrackRecordBadge.tsx) is idle by default —
  // it renders a "Show track record" button and only fetches on click, so
  // it never adds a request per signal card on page load. Mounted on
  // /dashboard/signals and /dashboard/holdfold/{ticker}, NOT /verdict/{ticker}
  // (that route renders no backtest data at all — confirmed by grep before
  // writing this test, don't reintroduce a /verdict assertion without
  // re-checking that).
  test("DIAGNOSE: SIGNALS_ENGINE_URL unset vs. engine unreachable vs. malformed response — all collapse to 204", async ({ request }) => {
    // fetchBacktest() in lib/backtest.ts returns null (-> route returns 204)
    // for FOUR distinct causes: SIGNALS_ENGINE_URL unset, fetch throws,
    // non-2xx, or a response that fails isBacktestResult(). A 204 in prod
    // is therefore uninformative about which one you're facing — this test
    // documents that ambiguity exists rather than resolving it, since only
    // server-side env inspection can distinguish "unset" from "unreachable".
    const res = await request.get("/api/backtest/JETS");
    if (res.status() === 204) {
      test.info().annotations.push({
        type: "diagnosis",
        description:
          "204 from /api/backtest/JETS — cannot distinguish SIGNALS_ENGINE_URL unset from engine down/malformed from this response alone. Check server env directly.",
      });
    }
    expect([200, 204]).toContain(res.status());
  });

  test("EXPOSE: the exact 'unavailable' string does not distinguish unset config from a broken engine", async ({ page }) => {
    await page.route("**/api/backtest/**", (route) => route.fulfill({ status: 204 }));
    await page.goto("/dashboard/signals");

    // TrackRecordBadge is idle until clicked — this reproduces the reported
    // "Historical hit-rate data unavailable for JETS" state deterministically
    // instead of depending on live SIGNALS_ENGINE_URL config.
    const showButton = page.getByRole("button", { name: /show track record/i }).first();
    await showButton.click();

    await expect(page.getByText(/historical hit-rate data unavailable/i)).toBeVisible();
  });

  test("DIAGNOSE: backtest engine returns a shape that fails isBacktestResult() silently", async ({ page }) => {
    // If SIGNALS_ENGINE_URL IS configured and the engine responds 200 but
    // with a shape that doesn't match BacktestResult (e.g. it renamed fields
    // the way gcp3 did for portfolio/health), fetchBacktest() treats that
    // identically to "engine unreachable" — a 204-equivalent "error" status
    // in TrackRecordBadge. This proves that specific failure mode by mocking
    // a plausible-but-wrong shape rather than the clean 204 case above.
    await page.route("**/api/backtest/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        // Missing by_category/by_strength as documented BacktestBucket[] —
        // e.g. a flat hit_rate number instead, a plausible API evolution on
        // the signals-app side.
        body: JSON.stringify({ symbol: "JETS", hit_rate: 0.61 }),
      }),
    );

    await page.goto("/dashboard/signals");
    const showButton = page.getByRole("button", { name: /show track record/i }).first();
    await showButton.click();

    // EXPECTED TO FAIL (renders the generic "Couldn't load" error state) if
    // the engine's response shape has drifted from BacktestResult — same
    // contract-drift failure class as the gcp3 portfolio/health incident,
    // just on a different pair of services.
    await expect(page.getByText(/couldn.?t load track record/i)).toBeVisible();
  });
});
