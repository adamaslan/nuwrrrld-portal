/**
 * POST /api/pipeline/hydrate-universe
 *
 * The zero-AI-cost coverage lane. A scheduled compute job (Modal, or gcp3's
 * existing /signals payload for the ETF universe) posts per-symbol indicator
 * rows here; this route discretizes them with `toStateKey()`, scores them in
 * code, and upserts `ticker_cards`.
 *
 * **This endpoint never calls a model.** That is its whole reason for existing:
 * coverage becomes free, so it stops competing with the interactive AI budget
 * (docs/max-coverage-simplest-path.md). The model is spent separately, on the
 * top of the ranking only, by /api/pipeline/precompute-ai.
 *
 * Auth: Bearer PORTAL_PUSH_SECRET — server-to-server, same contract as
 * /api/pipeline/precompute-ai and /api/signals/drain. Never user-facing.
 *
 * The batch contract is deliberately per-symbol rather than all-or-nothing: a
 * delisted ticker or a vendor miss arrives as `status: "error"` and is counted,
 * while every other symbol in the batch still lands. Full-universe hydration is
 * only robust if one bad symbol cannot poison 4,300 good ones.
 *
 * Why the compute host does not write Neon directly: keeping the database
 * contract, validation, idempotency and CONFIG_ERROR behavior in one place
 * means the scheduler holds a push secret and a vendor key, never a database
 * URL or a model key.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildCard, type CardUniverse } from "@/lib/shared/card-policy";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import {
  coverageForDate,
  listActiveTickers,
  upsertCards,
  upsertUniverse,
  type StoredCard,
} from "@/lib/ticker-cards-db";
import type { Horizon, SignalStateInput, VerdictDirection } from "@/lib/grounding/taxonomy";

export const maxDuration = 300;

/** Both horizons are computed for every row: the taxonomy produces a distinct
 *  state per horizon, and neither costs anything, so storing one would be an
 *  arbitrary loss of coverage. */
const HORIZONS: Horizon[] = ["t1", "t2"];

/** Upper bound per request, independent of what the caller sends. A hydration
 *  job is expected to chunk; a single unbounded batch is a timeout waiting to
 *  happen and gives no partial progress when it fails. */
const MAX_ROWS_PER_BATCH = 500;

interface HydrateRow {
  ticker: string;
  status?: "ok" | "error";
  rsi?: number | null;
  macdCross?: "bullish" | "bearish" | null;
  adx?: number | null;
  volatilityPercentile?: number | null;
  confluenceScore?: number | null;
  direction?: VerdictDirection | null;
  error?: string;
}

interface HydrateBody {
  runId?: string;
  source?: string;
  universe?: CardUniverse;
  barDate?: string;
  rows?: HydrateRow[];
}

/**
 * GET — the active ticker list the hydration job walks.
 *
 * Exists so the compute host can read the universe without a database URL:
 * the same reason writes go through this route. Same bearer contract as POST.
 */
export async function GET(req: NextRequest) {
  const auth = requirePushSecret(req);
  if (auth) return auth;

  const universeParam = new URL(req.url).searchParams.get("universe");
  const universe: CardUniverse | undefined =
    universeParam === "etf" || universeParam === "stock" ? universeParam : undefined;

  const tickers = await listActiveTickers(universe);
  return NextResponse.json({ ok: true, universe: universe ?? "all", count: tickers.length, tickers });
}

/** Cap on one PUT so a malformed script can't wedge an unbounded write; the
 *  caller (scripts/seed-universe.mjs) already chunks well under this. */
const MAX_UNIVERSE_ENTRIES_PER_CALL = 1000;

/**
 * PUT — register ticker membership with no card implied.
 *
 * Deliberately separate from POST: registering that AAPL is now part of the
 * tracked universe is not the same fact as "AAPL was just measured", and a
 * membership-only write must never appear to be a bar of real signal data.
 * This is what scripts/seed-universe.mjs (S&P 500 / Nasdaq-100 constituents)
 * calls, and what a future index-rebalance job would call too.
 */
export async function PUT(req: NextRequest) {
  const auth = requirePushSecret(req);
  if (auth) return auth;

  const body = (await req.json().catch(() => ({}))) as {
    entries?: { ticker: string; universe?: CardUniverse; name?: string }[];
  };
  const entries = Array.isArray(body.entries) ? body.entries : [];

  if (entries.length === 0) {
    return NextResponse.json({ ok: true, registered: 0, rejected: [] });
  }
  if (entries.length > MAX_UNIVERSE_ENTRIES_PER_CALL) {
    return NextResponse.json(
      { error: `too many entries: ${entries.length}, max ${MAX_UNIVERSE_ENTRIES_PER_CALL}` },
      { status: 413 },
    );
  }

  const clean: { ticker: string; universe: CardUniverse; name?: string }[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    const ticker = normalizeTicker(entry?.ticker);
    if (!ticker) {
      rejected.push(String(entry?.ticker ?? ""));
      continue;
    }
    clean.push({ ticker, universe: entry.universe === "etf" ? "etf" : "stock", name: entry.name });
  }

  const registered = await upsertUniverse(clean);
  console.log(`[hydrate-universe] PUT registered=${registered} rejected=${rejected.length}`);

  return NextResponse.json({ ok: true, registered, rejected: rejected.slice(0, 25) });
}

/**
 * Server-to-server bearer guard. Returns a response to send, or null to
 * continue. A missing secret is a 503 CONFIG_ERROR rather than a 401: the
 * caller is not unauthorized, the deployment is unconfigured, and conflating
 * the two sends whoever is debugging it looking for the wrong problem.
 */
function requirePushSecret(req: NextRequest): NextResponse | null {
  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    console.error(
      "[hydrate-universe] CONFIG_ERROR: PORTAL_PUSH_SECRET is not set — this endpoint " +
        "rejects all requests until it is configured (Vercel project env vars).",
    );
    return NextResponse.json({ error: "PORTAL_PUSH_SECRET not configured" }, { status: 503 });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const auth = requirePushSecret(req);
  if (auth) return auth;

  const body = (await req.json().catch(() => ({}))) as HydrateBody;

  const source = typeof body.source === "string" && body.source ? body.source : null;
  const universe: CardUniverse = body.universe === "etf" ? "etf" : "stock";
  const barDate = normalizeBarDate(body.barDate);
  const rows = Array.isArray(body.rows) ? body.rows : [];

  // Provenance is required, not optional: without `source` and `barDate` a card
  // cannot be selectively replaced when one vendor turns out to have been wrong.
  if (!source) {
    return NextResponse.json({ error: "source is required" }, { status: 400 });
  }
  if (!barDate) {
    return NextResponse.json({ error: "barDate must be YYYY-MM-DD" }, { status: 400 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, written: 0, skipped: 0, failed: 0, rejected: [], note: "empty batch" });
  }
  if (rows.length > MAX_ROWS_PER_BATCH) {
    return NextResponse.json(
      { error: `batch too large: ${rows.length} rows, max ${MAX_ROWS_PER_BATCH}` },
      { status: 413 },
    );
  }

  const cards: StoredCard[] = [];
  const rejected: { ticker: string; reason: string }[] = [];
  /** Symbols the compute job explicitly reported as failed. Counted and
   *  returned, never written — the previous good card for that ticker is left
   *  untouched, so a vendor miss degrades to "yesterday's data" not "no data". */
  const upstreamErrors: { ticker: string; reason: string }[] = [];

  for (const row of rows) {
    const ticker = normalizeTicker(row?.ticker);
    if (!ticker) {
      rejected.push({ ticker: String(row?.ticker ?? ""), reason: "invalid ticker" });
      continue;
    }
    if (row.status === "error") {
      upstreamErrors.push({ ticker, reason: row.error ?? "upstream error" });
      continue;
    }

    const input: SignalStateInput = {
      rsi: numOrNull(row.rsi),
      // Three-way, not two: "bullish"/"bearish" are crosses, an explicit null
      // means MACD was computed and found no cross, and an omitted key means it
      // was never computed. Collapsing the last two would score every quiet
      // tape as though its MACD had failed to fetch.
      macdCross: macdOrMissing(row),
      adx: numOrNull(row.adx),
      volatilityPercentile: numOrNull(row.volatilityPercentile),
      confluenceScore: numOrNull(row.confluenceScore),
      direction: isDirection(row.direction) ? row.direction : null,
    };

    for (const horizon of HORIZONS) {
      const card = buildCard(ticker, universe, input, horizon);
      cards.push({ ...card, source, sourceRunId: body.runId ?? null, barDate, computedAt: new Date().toISOString() });
    }
  }

  // Register every ticker we are about to card. `ticker_cards` has a foreign
  // key onto `ticker_universe`, so a symbol seen for the first time must be
  // admitted before its card can land.
  const seen = [...new Set(cards.map((c) => c.ticker))];
  await upsertUniverse(seen.map((ticker) => ({ ticker, universe })));

  const outcomes = await upsertCards(cards);
  const written = outcomes.filter((o) => o.outcome === "written").length;
  const skipped = outcomes.filter((o) => o.outcome === "skipped").length;
  const failed = outcomes.filter((o) => o.outcome === "failed");

  const coverage = await coverageForDate(barDate);

  console.log(
    `[hydrate-universe] run=${body.runId ?? "-"} source=${source} bar=${barDate} ` +
      `tickers=${seen.length} written=${written} skipped=${skipped} failed=${failed.length} ` +
      `upstreamErrors=${upstreamErrors.length} coverage=${coverage.covered}/${coverage.active}`,
  );

  return NextResponse.json({
    ok: true,
    runId: body.runId ?? null,
    source,
    barDate,
    tickers: seen.length,
    written,
    skipped,
    failed: failed.length,
    failures: failed.slice(0, 25),
    upstreamErrors: upstreamErrors.slice(0, 25),
    rejected: rejected.slice(0, 25),
    coverage,
    // Stated explicitly so the contract is visible in every response: this lane
    // is free, and any future change that spends quota here breaks the design.
    modelCalls: 0,
  });
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Preserves the three-way MACD distinction across the wire. A row that omits
 * `macdCross` entirely yields `undefined` (not computed → counted as missing);
 * an explicit `null` yields `null` (computed, no cross → a real observation).
 */
function macdOrMissing(row: HydrateRow): "bullish" | "bearish" | null | undefined {
  if (!("macdCross" in row)) return undefined;
  return row.macdCross === "bullish" || row.macdCross === "bearish" ? row.macdCross : null;
}

function isDirection(v: unknown): v is VerdictDirection {
  return v === "bullish" || v === "bearish" || v === "neutral";
}

/** Accepts YYYY-MM-DD only. A loose Date parse would silently turn a malformed
 *  date into "today", which is exactly how a stale batch overwrites fresh cards. */
function normalizeBarDate(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : v;
}
