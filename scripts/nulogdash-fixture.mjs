#!/usr/bin/env node
/**
 * nulogdash-fixture — put the sweep's test user into the minimum state the
 * sweep needs, and nothing more.
 *
 *   node --env-file=.env.local scripts/nulogdash-fixture.mjs [--check]
 *
 * Why this exists: several features are only meaningfully exercised against a
 * user who *has* something. The watchlist is the clearest case — it doubles as
 * the portfolio (docs/wiki-portal/decision-local-portfolio-scoring-over-upstream-wait.md),
 * so an empty watchlist makes GET /api/portfolio/health answer a perfectly
 * correct `503 no signals computed for this watchlist yet`. That is the route
 * working, but it is not the route being tested, and a sweep that reports it as
 * a pass would be asserting nothing while a sweep that reports it as a fail
 * would be wrong. Seeding real, card-covered tickers is what makes the result
 * mean something.
 *
 * Scope discipline: this touches ONE user — the dedicated Clerk test user named
 * by E2E_CLERK_TEST_EMAIL, the same account the Playwright suite signs in as —
 * and only adds watchlist rows. It never deletes a row it did not add, never
 * touches another user, and is idempotent.
 *
 * Tickers are verified to have a `ticker_cards` row before being inserted: a
 * seeded ticker with no computed card would leave portfolio health in exactly
 * the uncovered state this script exists to avoid.
 */
import { createClerkClient } from "@clerk/backend";
import { neon } from "@neondatabase/serverless";

/** Large, liquid, and reliably present in the hydrated universe. Three, not
 *  one, so the diversification factor in the health score has something to
 *  measure instead of scoring a single-position portfolio. */
const FIXTURE_TICKERS = ["AAPL", "MSFT", "NVDA"];

const CHECK_ONLY = process.argv.includes("--check");

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`${name} is not set — see docs/nulogdash-dashboard-plan.md`);
    process.exit(1);
  }
  return v;
}

async function resolveTestUserId() {
  const clerk = createClerkClient({ secretKey: requireEnv("CLERK_SECRET_KEY") });
  const email = requireEnv("E2E_CLERK_TEST_EMAIL");
  const { data } = await clerk.users.getUserList({ emailAddress: [email] });
  if (data.length === 0) {
    console.error(`No Clerk user matches E2E_CLERK_TEST_EMAIL on this instance.`);
    process.exit(1);
  }
  return data[0].id;
}

async function main() {
  const sql = neon(requireEnv("DATABASE_URL"));
  const userId = await resolveTestUserId();

  const covered = await sql`
    SELECT DISTINCT ticker FROM ticker_cards WHERE ticker = ANY(${FIXTURE_TICKERS})
  `;
  const coveredSet = new Set(covered.map((r) => r.ticker));
  const usable = FIXTURE_TICKERS.filter((t) => coveredSet.has(t));
  const uncovered = FIXTURE_TICKERS.filter((t) => !coveredSet.has(t));

  if (uncovered.length > 0) {
    console.log(
      `Skipping ${uncovered.join(", ")} — no ticker_cards row, so seeding them would not ` +
        `give portfolio health anything to score. Check the hydration pipeline.`,
    );
  }
  if (usable.length === 0) {
    console.error(
      "None of the fixture tickers have a computed card. The universe-hydration pipeline " +
        "has probably not run — see docs/wiki-portal/incident-2026-09-03-nightly-hydration-dead-15-days.md",
    );
    process.exit(1);
  }

  const existing = await sql`SELECT ticker FROM watchlist_items WHERE user_id = ${userId}`;
  const have = new Set(existing.map((r) => r.ticker));
  const missing = usable.filter((t) => !have.has(t));

  console.log(`test user watchlist: ${[...have].sort().join(", ") || "(empty)"}`);
  console.log(`fixture tickers with cards: ${usable.join(", ")}`);

  if (CHECK_ONLY) {
    console.log(missing.length === 0 ? "fixture satisfied" : `fixture MISSING: ${missing.join(", ")}`);
    process.exitCode = missing.length === 0 ? 0 : 1;
    return;
  }

  for (const ticker of missing) {
    await sql`
      INSERT INTO watchlist_items (user_id, ticker)
      VALUES (${userId}, ${ticker})
      ON CONFLICT DO NOTHING
    `;
    console.log(`  + ${ticker}`);
  }
  console.log(missing.length === 0 ? "nothing to do — fixture already satisfied" : `seeded ${missing.length} ticker(s)`);
}

main();
