#!/usr/bin/env node
/**
 * seed-etf-cards — card the 54 ETFs gcp3 already computes, today, at zero AI cost.
 *
 * This is step 8 of docs/modal-vs-gcp-signal-coverage.md's build order, and the
 * reason it comes before the Modal lane: it exercises the entire
 * card → score → rank → ground path end-to-end using data that already exists,
 * with no new infrastructure. If the card model is wrong, this is where that
 * surfaces — cheaply, against live data, with nothing to unwind.
 *
 * gcp3's /signals returns all 54 ETF rows in one call, computed from a cached
 * Firestore document with no external API calls. There is nothing to batch and
 * no per-symbol fetch to rate-limit, so this whole script is one GET and one
 * POST.
 *
 * Usage:
 *   PORTAL_PUSH_SECRET=... node scripts/seed-etf-cards.mjs
 *   PORTAL_PUSH_SECRET=... PORTAL_URL=http://localhost:3000 node scripts/seed-etf-cards.mjs
 *   node scripts/seed-etf-cards.mjs --dry-run     # print rows, post nothing
 */

const MCP_URL =
  process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Map one gcp3 ETF entry onto the taxonomy's input surface.
 *
 * gcp3's ETF engine is return- and rank-based rather than indicator-based: it
 * scores 52-week range position, relative strength within the 54-ETF universe,
 * and multi-period returns. So RSI/MACD/ADX are genuinely *not computed* for
 * these rows, and this mapper must say so by omitting them rather than
 * inventing neutral values — an ETF card should be honestly partial, not
 * fraudulently complete.
 *
 * `confluence_score` and `ai_action` are the two fields gcp3 does produce that
 * the taxonomy can consume directly.
 */
function toSignalInput(entry) {
  const confluence = typeof entry.confluence_score === "number" ? entry.confluence_score : null;
  const action = typeof entry.ai_action === "string" ? entry.ai_action.toUpperCase() : "";

  let direction = "neutral";
  if (/BUY/.test(action)) direction = "bullish";
  else if (/SELL/.test(action)) direction = "bearish";

  return {
    // gcp3's confluence is signed roughly -1..+1; the taxonomy buckets on a
    // 0-100 magnitude, so scale and take the magnitude — direction is carried
    // separately and must not be double-counted into the score's sign.
    confluenceScore: confluence == null ? null : Math.min(100, Math.abs(confluence) * 100),
    direction,
    // rsi / adx / volatilityPercentile / macdCross deliberately absent — see above.
  };
}

async function main() {
  process.stdout.write(`Fetching ETF signals from ${MCP_URL}/signals …\n`);

  const res = await fetch(`${MCP_URL}/signals`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`gcp3 /signals returned HTTP ${res.status}`);
  }
  const data = await res.json();
  const symbols = data?.symbols ?? {};
  const tickers = Object.keys(symbols);

  if (tickers.length === 0) {
    throw new Error("gcp3 returned no symbols — refusing to post an empty batch");
  }

  // gcp3's payload carries its own `date`; use it rather than today's, so a
  // stale upstream cache cannot masquerade as fresh bars and overwrite newer
  // cards. The replacement rule depends on this being the real bar date.
  const barDate = typeof data.date === "string" ? data.date : new Date().toISOString().slice(0, 10);

  const rows = tickers.map((ticker) => ({
    ticker,
    status: "ok",
    ...toSignalInput(symbols[ticker]),
  }));

  process.stdout.write(`Mapped ${rows.length} ETF rows for bar date ${barDate}.\n`);

  if (DRY_RUN) {
    process.stdout.write(`${JSON.stringify(rows.slice(0, 3), null, 2)}\n`);
    process.stdout.write(`(dry run — nothing posted; ${rows.length} rows would be sent)\n`);
    return;
  }

  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    throw new Error("PORTAL_PUSH_SECRET is not set — the portal will reject this run");
  }

  const post = await fetch(`${PORTAL_URL}/api/pipeline/hydrate-universe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: `etf-seed:${barDate}:gcp3`,
      source: "gcp3",
      universe: "etf",
      barDate,
      rows,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const result = await post.json().catch(() => ({}));
  if (!post.ok) {
    throw new Error(`portal returned HTTP ${post.status}: ${JSON.stringify(result)}`);
  }

  process.stdout.write(
    `Done — written=${result.written} skipped=${result.skipped} failed=${result.failed} ` +
      `coverage=${result.coverage?.covered}/${result.coverage?.active} modelCalls=${result.modelCalls}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`seed-etf-cards failed: ${err.message}\n`);
  process.exitCode = 1;
});
