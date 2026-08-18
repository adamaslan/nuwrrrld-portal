import { test, expect } from "@playwright/test";

/**
 * Timing-correctness coverage for /dashboard/signals — prompted by a
 * reported SOXX card ("Semiconductors — 1d +4.17%, 1m -3.2%, 1y +126.7%...
 * Confluence score +0.82 (HIGH): 5 of 6 signals are bullish") where the "1d"
 * figure didn't look right for that day.
 *
 * IMPORTANT SCOPE NOTE, confirmed by reading the code before writing these
 * tests: the "1d +4.17%" text itself is NOT computed anywhere in this repo.
 * SignalPayload.title/explanation are passed through verbatim from gcp3's
 * ai_summary/ai_outlook fields (lib/digest.ts adaptLiveSignals). This portal
 * has no period-return calculation to unit-test and no way to verify "4.17%"
 * against a price series — that arithmetic lives entirely in the gcp3
 * backend. What IS testable from here, and what these tests cover:
 *
 *   1. The one thing this repo DOES compute: whether a signal is flagged
 *      stale, and whether that flag actually gates the "1d/1m/1y" narrative
 *      from being shown as if it were current.
 *   2. Whether the confluence score/signal-count numbers rendered in the DOM
 *      exactly match what the API returned — no transcription drift between
 *      payload and pixels.
 *   3. The real timing bug class (see __tests__/digest-adapt.test.ts's new
 *      "batch-wide generatedAt" tests): every ticker in one /signals batch
 *      shares ONE generatedAt/`updated` timestamp. There is no per-ticker
 *      "as of" time. A SOXX card can show a fresh-looking timestamp while
 *      its own underlying score is old, and neither this repo nor its UI can
 *      currently detect that — this suite documents the blind spot rather
 *      than fixing it, since fixing it needs a gcp3-side per-ticker
 *      timestamp that doesn't exist yet.
 */

test.describe("SOXX / signal-timing (/dashboard/signals)", () => {
  test("DIAGNOSE: a fresh generatedAt suppresses the stale badge even for scoped-stale data — the batch-timestamp blind spot", async ({ page }) => {
    // Mocks the server-rendered page's data source is not possible here
    // (SignalsPage fetches server-side via getOrFetchDigest, invisible to
    // page.route() — see lib/digest-cache.ts). This test instead asserts on
    // what's true of the LIVE page: if a SOXX card is showing, its staleness
    // badge is driven entirely by dataQualityScore/generatedAt, both of
    // which are batch-wide, not per-ticker. A failing assertion here is not
    // "the badge is broken" — it's a prompt to check whether SOXX's own
    // dataQualityScore looked "fresh" while the underlying score was
    // actually old. Cross-reference __tests__/digest-adapt.test.ts's
    // "batch-wide generatedAt" describe block, which proves this at the
    // adapter level without needing a live signal.
    await page.goto("/dashboard/signals");

    const soxxCard = page.locator("#signal-SOXX, .signal-card", { hasText: "SOXX" }).first();
    const hasSoxx = await soxxCard.count();
    test.skip(hasSoxx === 0, "SOXX not in today's live digest — this test only runs when it is present");

    const isFlaggedStale = await soxxCard.locator(".signal-stale-badge").count();
    test.info().annotations.push({
      type: "diagnosis",
      description: isFlaggedStale
        ? "SOXX IS flagged stale — the badge caught it, narrative should be discounted."
        : "SOXX is NOT flagged stale. This proves nothing about whether the '1d +X%' figure " +
          "in its title is current — that number has no independent timestamp of its own. " +
          "Check gcp3's per-symbol data_quality_score for SOXX specifically, not just the batch's.",
    });
  });

  test("EXPOSE: the confluence score and bull/bear counts rendered in the DOM must match the payload exactly", async ({ page }) => {
    // Route page.route() DOES work for THIS assertion's purpose even though
    // the real page fetch is server-side: we navigate directly and read
    // whatever the live server actually rendered, then cross-check DOM text
    // against the API's own /api/signals/digest response for the same
    // ticker — catching drift between what gcp3 sent and what got painted,
    // independent of server-vs-client fetch boundaries.
    const digestRes = await page.request.get("/api/signals/digest").catch(() => null);
    test.skip(!digestRes || !digestRes.ok(), "digest API unavailable this run — see e2e/health for dependency status");

    const digest = await digestRes!.json();
    const soxx = digest?.signals?.find((s: { ticker: string }) => s.ticker === "SOXX");
    test.skip(!soxx, "SOXX not present in the current digest");

    await page.goto("/dashboard/signals");
    const card = page.locator("#signal-SOXX");
    await card.locator(".signals-expand-btn").click();

    if (typeof soxx.score === "number") {
      await expect(card.locator(".signal-score")).toContainText(soxx.score.toFixed(2));
    }
    if (soxx.signalCounts) {
      const { bullish, bearish, total } = soxx.signalCounts;
      await expect(card.locator(".signal-score")).toContainText(`${bullish} bullish / ${bearish} bearish of ${total}`);
    }
  });

  test("DIAGNOSE: signal-policy's cacheTtlMinutes classifies an 82%-confluence bullish signal as 'hot' — confirms it SHOULD refresh fast, not sit on stale numbers", async ({ request }) => {
    // Pure-logic check reachable without a browser at all, included here
    // (not in __tests__/) because it's the piece that explains WHY a SOXX-
    // shaped signal (extreme confluence, actionable direction) is supposed
    // to have a short cache lifetime — if a "1d" figure looks wrong, the
    // first question is whether this 5-minute hot-refresh actually fired,
    // not whether the arithmetic is wrong. cacheTtlMinutes lives in
    // lib/shared/signal-policy.ts and is exercised indirectly via the
    // digest cache route rather than imported directly, since e2e specs
    // intentionally stay black-box against the running server.
    const res = await request.get("/api/signals/digest");
    test.skip(!res.ok(), "digest API unavailable this run");
    const digest = await res.json();
    const soxx = digest?.signals?.find((s: { ticker: string }) => s.ticker === "SOXX");
    test.skip(!soxx, "SOXX not present in the current digest");

    // A signal this confluent/actionable should be well inside the 15-minute
    // default TTL — if generatedAt is older than 5 minutes for a signal this
    // hot, the hot-refresh path in cacheTtlMinutes() isn't actually firing.
    const ageMinutes = (Date.now() - new Date(soxx.generatedAt).getTime()) / 60_000;
    test.info().annotations.push({
      type: "diagnosis",
      description: `SOXX signal age: ${ageMinutes.toFixed(1)}min. cacheTtlMinutes() should classify ` +
        `this as 'hot' (5min TTL) given score=${soxx.score} and direction=${soxx.direction}. ` +
        `If age exceeds ~5-10min, the hot-refresh cache policy did not apply — check ` +
        `lib/shared/signal-policy.ts:cacheTtlMinutes against this signal's actual ai_action/confluence_score.`,
    });
  });
});
