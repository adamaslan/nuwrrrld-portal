"""Modal deployment of the 4th ("AWS-Modal") pipeline: Alpaca news ingest and
scoring, accuracy metrics, and the news weight fed into confluence.

Design: docs/fin-api-and-4th-aws-modal-pipeline.md (§5.1 jobs, §6 scoring, §7
accuracy, §8.3 weight governance). Pure logic lives in news_core.py (unit
tested offline), I/O in news_io.py; this file is the Modal wiring.

Jobs (all functions of the `nwf4` app):

    news_ingest          Alpaca news -> Neon, universe-filtered, story-clustered
    news_score_articles  lexicon + FinBERT -> ensemble per article (LLM scorer OFF)
    news_corroborate     Finnhub /company-news cross-check for the top 20 tickers
    news_aggregate       per-ticker point-in-time news_score (final + pre-open preview)
    news_label_outcomes  forward abnormal returns vs SPY from SIP daily bars
    news_accuracy_eval   weekly metrics + weight decision (shadow until the gate passes)
    alpaca_live_poller   IEX snapshots for the live set -> Neon live_prices + DynamoDB

**One cron, not seven.** Modal's Starter plan caps cron schedules per account,
and this app needs eight. `tick` is the only scheduled function: it runs every
minute, asks news_core.due_jobs() which jobs §5.1 schedules for that minute (in
America/New_York, DST-correct), and spawns them. Each job is idempotent, so the
retry slots in due_jobs() are safe.

**The news weight stays 0.** Nothing here changes a card score. The evaluator
only appends rows to `confluence_news_weights`; it keeps `status='shadow'`,
weight 0, until the §8.3 gate passes twice in a row, and nothing reads that
table yet.

**Secrets are purpose-scoped** (see deploy/universe-hydration/modal_app.py):

    nuwrrrld-market    ALPACA_API_KEY, ALPACA_API_SECRET, ...
    nuwrrrld-db        DATABASE_URL (Neon, pooled)
    nuwrrrld-aws       AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, ...
                       scoped to exactly the 6 nwf_* DynamoDB tables
    nuwrrrld-finnhub   FINNHUB_API_KEY (news_corroborate only)

Only the `main` Modal environment exists, so every command omits `--env`.

Deploy:
    modal deploy deploy/aws-modal-news/modal_app.py

Reachability check (read-only, safe anytime):
    modal run deploy/aws-modal-news/modal_app.py::main

Run one job by hand:
    modal run deploy/aws-modal-news/modal_app.py::run --job news_ingest
    modal run deploy/aws-modal-news/modal_app.py::run --job news_aggregate --session 2026-10-08 --preview
"""

import asyncio
import json
import os
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import modal

APP_NAME = "nwf4"

app = modal.App(APP_NAME)

LOCAL_SOURCES = ("news_core", "news_io")

# Lean image for the jobs that never touch a model.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("httpx~=0.28", "boto3~=1.35", "asyncpg~=0.30")
    .add_local_python_source(*LOCAL_SOURCES)
)

# FinBERT image: CPU torch only. Weights are cached on the nwf4-models Volume
# (HF_HOME) so only the first scoring run downloads them.
ml_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "httpx~=0.28", "boto3~=1.35", "asyncpg~=0.30", "transformers~=4.46", "torch~=2.5",
        extra_index_url="https://download.pytorch.org/whl/cpu",
    )
    .env({"HF_HOME": "/models/hf"})
    .add_local_python_source(*LOCAL_SOURCES)
)

market_secret = modal.Secret.from_name("nuwrrrld-market")
db_secret = modal.Secret.from_name("nuwrrrld-db")
aws_secret = modal.Secret.from_name("nuwrrrld-aws")
finnhub_secret = modal.Secret.from_name("nuwrrrld-finnhub")

raw_volume = modal.Volume.from_name("nwf4-raw")
models_volume = modal.Volume.from_name("nwf4-models")

# Exactly the 6 tables this pipeline owns, with their partition key attribute.
DYNAMO_TABLES = {
    "nwf_rate_budget": "bucket",
    "nwf_seen": "key",
    "nwf_news_cursor": "stream",
    "nwf_llm_cache": "key",
    "nwf_live_prices": "ticker",
    "nwf_job_locks": "lock_key",
}

NEWS_STREAM = "alpaca_news"
INGEST_LOCK_TTL_SECONDS = 240
INGEST_MAX_PAGES = 8
INGEST_MAX_ARTICLES = 150
INGEST_DEFAULT_LOOKBACK_HOURS = 6
SCORE_BACKLOG_LIMIT = 400
SCORE_BATCH = 16
FINBERT_MODEL_ID = "ProsusAI/finbert"
FINBERT_MAX_CHARS_SUMMARY = 300
CORROBORATE_TOP_N = 20
CORROBORATE_STORY_JACCARD = 0.6
LIVE_SET_CAP = 250
LIVE_POLLER_WRITE_DEADLINE_SECONDS = 40.0
BASELINE_DAYS = 60
LABEL_BENCHMARK = "SPY"
ACCURACY_WINDOWS = (60, 250)
VOLUME_Z_BUCKETS = (("<1", None, 1.0), ("1-2", 1.0, 2.0), (">=2", 2.0, None))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── smoke ────────────────────────────────────────────────────────────────────


@app.function(
    image=image,
    secrets=[market_secret, db_secret, aws_secret],
    volumes={"/raw": raw_volume, "/models": models_volume},
    timeout=60,
)
def smoke() -> dict:
    """Phase N0: prove Alpaca, DynamoDB and Neon are reachable. Read-only; returns booleans only."""
    import httpx

    result: dict[str, object] = {}
    headers = {
        "APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
        "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET"],
    }
    try:
        response = httpx.get("https://paper-api.alpaca.markets/v2/clock", headers=headers, timeout=10.0)
        response.raise_for_status()
        result["alpaca_ok"] = True
        result["alpaca_is_open"] = response.json().get("is_open")
    except httpx.HTTPError as error:
        result["alpaca_ok"] = False
        result["alpaca_error"] = type(error).__name__

    import boto3

    dynamo = boto3.client("dynamodb", region_name=os.environ["AWS_REGION"])
    table_status: dict[str, str] = {}
    for table, pk_attr in DYNAMO_TABLES.items():
        try:
            dynamo.get_item(TableName=table, Key={pk_attr: {"S": "__smoke_check__does-not-exist"}})
            table_status[table] = "reachable"
        except Exception as error:  # noqa: BLE001 - reporting, not handling
            table_status[table] = f"{type(error).__name__}: {error}"
    result["dynamodb_tables"] = table_status
    result["dynamodb_ok"] = all(v == "reachable" for v in table_status.values())

    import asyncpg

    async def _ping() -> bool:
        conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
        try:
            return (await conn.fetchval("SELECT 1")) == 1
        finally:
            await conn.close()

    try:
        result["neon_ok"] = asyncio.run(_ping())
    except Exception as error:  # noqa: BLE001 - reporting, not handling
        result["neon_ok"] = False
        result["neon_error"] = type(error).__name__
    return result


# ── news_ingest ──────────────────────────────────────────────────────────────


@app.function(image=image, secrets=[market_secret, db_secret, aws_secret], timeout=300)
def news_ingest() -> dict:
    """Alpaca news since the cursor -> Neon. Idempotent: Neon ON CONFLICT plus the nwf_seen pre-filter."""
    return asyncio.run(_ingest())


async def _ingest() -> dict:
    import news_core as nc
    import news_io as io

    store = io.DynamoStore()
    owner = store.acquire_lock("news_ingest", INGEST_LOCK_TTL_SECONDS)
    if owner is None:
        return {"skipped": "another news_ingest run holds the lock"}
    conn = await io.connect()
    try:
        universe = await io.load_universe(conn)
        by_normalized = {io.normalize_from_alpaca(t): t for t in universe}
        now = _utcnow()
        cursor = store.get_cursor(NEWS_STREAM) or now - timedelta(hours=INGEST_DEFAULT_LOOKBACK_HOURS)

        fetched: list[dict] = []
        token = None
        budget_stopped = False
        pages = 0
        for _ in range(INGEST_MAX_PAGES):
            try:
                page, token = io.fetch_news_page(store, cursor, token)
            except io.AlpacaBudgetExhausted:
                budget_stopped = True
                break
            pages += 1
            fetched.extend(page)
            if not token or len(fetched) >= INGEST_MAX_ARTICLES:
                break

        matched = []
        for article in fetched:
            tickers = sorted({by_normalized[io.normalize_from_alpaca(s)] for s in article.get("symbols", [])
                              if io.normalize_from_alpaca(s) in by_normalized})
            if tickers:
                matched.append((article, tickers))

        seen = store.seen_many([f"alpaca#{a['id']}" for a, _ in matched])
        fresh = [(a, t) for a, t in matched if f"alpaca#{a['id']}" not in seen]

        article_rows, symbol_rows, new_ids = [], [], []
        if fresh:
            earliest = min(io.parse_iso(a["created_at"]) for a, _ in fresh) - timedelta(hours=nc.STORY_WINDOW_HOURS)
            refs = await _load_story_refs(conn, sorted({t for _, ts in fresh for t in ts}), earliest)
            for article, tickers in fresh:
                created = io.parse_iso(article["created_at"])
                headline = article.get("headline") or ""
                symbols = article.get("symbols", [])
                simhash = nc.simhash64(nc.normalize_headline(headline, symbols))
                article_rows.append((
                    int(article["id"]), article.get("source") or "unknown", article.get("author"), headline,
                    nc.truncate_summary(article.get("summary")), article.get("url"), created,
                    io.parse_iso(article.get("updated_at") or article["created_at"]), simhash,
                ))
                new_ids.append(int(article["id"]))
                for ticker in tickers:
                    story_id, novelty, first_at = nc.assign_story(simhash, created, refs[ticker])
                    refs[ticker].append(nc.StoryRef(story_id, simhash, created, first_at))
                    symbol_rows.append((
                        int(article["id"]), ticker, len(symbols),
                        nc.relevance(len(symbols), ticker, headline, universe[ticker]["name"]),
                        story_id, novelty,
                    ))
            async with conn.transaction():
                await conn.executemany(
                    """INSERT INTO news_articles (article_id, source, author, headline, summary, url,
                                                  created_at, updated_at, simhash)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (article_id) DO NOTHING""",
                    article_rows,
                )
                await conn.executemany(
                    """INSERT INTO news_article_symbols (article_id, ticker, symbols_count, relevance, story_id, novelty)
                       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (article_id, ticker) DO NOTHING""",
                    symbol_rows,
                )
            store.mark_seen(f"alpaca#{i}" for i in new_ids)

        if fetched:
            store.set_cursor(NEWS_STREAM, max(io.parse_iso(a["created_at"]) for a in fetched))
        if new_ids:
            news_score_articles.spawn(new_ids)

        summary = {"pages": pages, "fetched": len(fetched), "universe_matched": len(matched),
                   "new": len(new_ids), "budget_exhausted": budget_stopped,
                   "more_pending": bool(token) and not budget_stopped}
        await io.log_run(conn, "news-ingest", "degraded" if budget_stopped else "ok", summary, items_total=len(fetched))
        return summary
    finally:
        await conn.close()
        store.release_lock("news_ingest", owner)


async def _load_story_refs(conn, tickers, since):
    import news_core as nc

    rows = await conn.fetch(
        """SELECT s.ticker, s.story_id, a.simhash, a.created_at,
                  MIN(a.created_at) OVER (PARTITION BY s.ticker, s.story_id) AS first_at
             FROM news_article_symbols s JOIN news_articles a USING (article_id)
            WHERE s.ticker = ANY($1) AND a.created_at > $2""",
        tickers, since,
    )
    refs = defaultdict(list)
    for r in rows:
        refs[r["ticker"]].append(nc.StoryRef(r["story_id"], r["simhash"], r["created_at"], r["first_at"]))
    return refs


# ── news_score_articles ──────────────────────────────────────────────────────


@app.function(
    image=ml_image, secrets=[db_secret], volumes={"/models": models_volume},
    cpu=2.0, memory=3072, timeout=900,
)
def news_score_articles(article_ids: list[int] | None = None) -> dict:
    """Lexicon + FinBERT -> ensemble_v1 per article. The LLM scorer (llm_v1) is OFF by decision.

    Fails closed: if FinBERT can't run, nothing is written and the articles stay
    unscored (and are counted as unscored by news_aggregate) rather than being
    scored by the lexicon alone.
    """
    return asyncio.run(_score(article_ids))


def _finbert_outputs(texts):
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    import news_core as nc

    tokenizer = AutoTokenizer.from_pretrained(FINBERT_MODEL_ID, cache_dir="/models/hf")
    model = AutoModelForSequenceClassification.from_pretrained(FINBERT_MODEL_ID, cache_dir="/models/hf")
    model.eval()
    labels = {i: name.lower() for i, name in model.config.id2label.items()}
    outputs = []
    for start in range(0, len(texts), SCORE_BATCH):
        batch = texts[start : start + SCORE_BATCH]
        encoded = tokenizer(batch, padding=True, truncation=True, max_length=128, return_tensors="pt")
        with torch.no_grad():
            probabilities = torch.softmax(model(**encoded).logits, dim=-1)
        for row in probabilities:
            p = {labels[i]: float(row[i]) for i in range(len(labels))}
            outputs.append(nc.finbert_output(p["positive"], p["negative"], p["neutral"]))
    try:
        models_volume.commit()
    except Exception as error:  # noqa: BLE001 - caching the weights is best effort
        print(f"WARNING: could not commit FinBERT weights to the Volume: {type(error).__name__}")
    return outputs


async def _score(article_ids) -> dict:
    import news_core as nc
    import news_io as io

    conn = await io.connect()
    try:
        if article_ids:
            rows = await conn.fetch(
                "SELECT article_id, headline, summary FROM news_articles WHERE article_id = ANY($1)", article_ids)
        else:
            rows = await conn.fetch(
                """SELECT article_id, headline, summary FROM news_articles a
                    WHERE NOT EXISTS (SELECT 1 FROM news_article_scores s
                                       WHERE s.article_id = a.article_id AND s.scorer = $1)
                    ORDER BY created_at LIMIT $2""",
                nc.SCORER_VERSION, SCORE_BACKLOG_LIMIT)
        if not rows:
            return {"scored": 0}

        lexicon = [nc.lexicon_score(r["headline"], r["summary"]) for r in rows]
        texts = [f"{r['headline']}. {(r['summary'] or '')[:FINBERT_MAX_CHARS_SUMMARY]}".strip() for r in rows]
        finbert = await asyncio.to_thread(_finbert_outputs, texts)  # blocking torch + Volume commit

        score_rows = []
        for row, lex, fin in zip(rows, lexicon, finbert):
            ens = nc.ensemble([lex, fin])
            score_rows += [
                (row["article_id"], nc.SCORER_LEXICON, lex.polarity, lex.confidence, lex.event_type, "lm-subset-v1"),
                (row["article_id"], nc.SCORER_FINBERT, fin.polarity, fin.confidence, None, FINBERT_MODEL_ID),
                (row["article_id"], nc.SCORER_VERSION, ens.polarity, ens.confidence, ens.event_type, "ensemble"),
            ]
        await conn.executemany(
            """INSERT INTO news_article_scores (article_id, scorer, polarity, confidence, event_type, model_id)
               VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (article_id, scorer) DO NOTHING""",
            score_rows,
        )
        summary = {"scored": len(rows), "llm": "disabled"}
        await io.log_run(conn, "news-score", "ok", summary, items_total=len(rows))
        return summary
    finally:
        await conn.close()


# ── news_corroborate ─────────────────────────────────────────────────────────


@app.function(image=image, secrets=[db_secret, aws_secret, finnhub_secret], timeout=300)
def news_corroborate() -> dict:
    """Mark Alpaca stories that Finnhub /company-news also carries, for the 20 busiest tickers."""
    return asyncio.run(_corroborate())


async def _corroborate() -> dict:
    import news_core as nc
    import news_io as io

    conn = await io.connect()
    try:
        if not os.environ.get("FINNHUB_API_KEY"):
            summary = {"error": "FINNHUB_API_KEY missing from the environment", "corroborated": 0}
            await io.log_run(conn, "news-corroborate", "fail", summary)
            return summary
        top = await conn.fetch(
            """SELECT s.ticker, COUNT(DISTINCT s.story_id) AS stories
                 FROM news_article_symbols s JOIN news_articles a USING (article_id)
                WHERE a.created_at > now() - interval '24 hours'
                GROUP BY s.ticker ORDER BY stories DESC, s.ticker LIMIT $1""",
            CORROBORATE_TOP_N)
        today = _utcnow().date()
        marked: set[int] = set()
        error = None
        for record in top:
            ticker = record["ticker"]
            try:
                finnhub_items = io.fetch_finnhub_company_news(
                    io.normalize_to_alpaca(ticker), (today - timedelta(days=1)).isoformat(), today.isoformat())
            except io.VendorUnavailable as exc:
                error = str(exc)
                break
            finally:
                time.sleep(io.FINNHUB_MIN_INTERVAL_SECONDS)
            local = await conn.fetch(
                """SELECT a.article_id, a.headline, a.simhash FROM news_articles a
                    JOIN news_article_symbols s USING (article_id)
                   WHERE s.ticker = $1 AND a.created_at > now() - interval '48 hours' AND NOT a.corroborated""",
                ticker)
            normalized = [nc.normalize_headline(item.get("headline", ""), [ticker]) for item in finnhub_items]
            hashes = [nc.simhash64(n) for n in normalized]
            for row in local:
                mine = nc.normalize_headline(row["headline"], [ticker])
                if any(nc.hamming(row["simhash"], h) <= nc.STORY_HAMMING_THRESHOLD
                       or nc.token_jaccard(mine, n) >= CORROBORATE_STORY_JACCARD
                       for h, n in zip(hashes, normalized)):
                    marked.add(row["article_id"])
        if marked:
            await conn.execute("UPDATE news_articles SET corroborated = true WHERE article_id = ANY($1)", sorted(marked))
        summary = {"tickers": len(top), "corroborated": len(marked), "error": error}
        await io.log_run(conn, "news-corroborate", "degraded" if error else "ok", summary, items_total=len(top))
        return summary
    finally:
        await conn.close()


# ── news_aggregate ───────────────────────────────────────────────────────────


@app.function(image=image, secrets=[market_secret, db_secret, aws_secret], timeout=600)
def news_aggregate(session: str | None = None, preview: bool = False, force: bool = False) -> dict:
    """Per-ticker news_score for one session (§6.4). `preview` is the 09:20 pre-open look: its rows are
    flagged and replaced by the 16:05 final; the labeler ignores them."""
    return asyncio.run(_aggregate(session, preview, force))


async def _aggregate(session_arg, preview, force) -> dict:
    import news_core as nc
    import news_io as io

    store = io.DynamoStore()
    conn = await io.connect()
    try:
        now = _utcnow()
        session = date.fromisoformat(session_arg) if session_arg else now.astimezone(nc.NEW_YORK).date()
        if not session_arg and not io.is_trading_day(store, session):
            return {"skipped": f"{session} is not a trading day"}
        if not preview and not force:
            done = await conn.fetchval(
                """SELECT 1 FROM news_ticker_scores WHERE session_date = $1 AND scorer_version = $2
                      AND COALESCE(components->>'preview','false') <> 'true' LIMIT 1""",
                session, nc.SCORER_VERSION)
            if done:
                return {"skipped": f"final aggregate for {session} already exists"}

        cutoff = min(now, nc.session_cutoff(session)) if preview else nc.session_cutoff(session)
        window_start = cutoff - timedelta(hours=nc.AGGREGATE_WINDOW_HOURS)
        universe = await io.load_universe(conn)

        rows = await conn.fetch(
            """SELECT s.ticker, a.article_id, a.created_at, a.source, a.corroborated,
                      s.relevance, s.novelty, s.story_id, e.polarity, e.confidence, e.event_type
                 FROM news_articles a
                 JOIN news_article_symbols s USING (article_id)
                 JOIN news_article_scores e ON e.article_id = a.article_id AND e.scorer = $3
                WHERE a.created_at > $1 AND a.created_at <= $2""",
            window_start, cutoff, nc.SCORER_VERSION)
        unscored = await conn.fetchval(
            """SELECT COUNT(*) FROM news_articles a
                WHERE a.created_at > $1 AND a.created_at <= $2
                  AND NOT EXISTS (SELECT 1 FROM news_article_scores e WHERE e.article_id = a.article_id AND e.scorer = $3)""",
            window_start, cutoff, nc.SCORER_VERSION)

        signals = defaultdict(list)
        for r in rows:
            signals[r["ticker"]].append(nc.ArticleSignal(
                r["article_id"], r["created_at"], r["source"], r["polarity"], r["confidence"], r["relevance"],
                r["novelty"], r["event_type"] or "other", r["story_id"], r["corroborated"]))

        history = await _story_history(conn, cutoff)
        upserts, filled = [], 0
        for ticker in sorted(universe):
            result = nc.aggregate_ticker(signals.get(ticker, []), cutoff)
            z = nc.volume_z(result.stories_24h, history.get(ticker, [])) if result.n_articles else None
            filled += result.news_score is not None
            components = dict(result.components)
            if preview:
                components["preview"] = True
            upserts.append((ticker, session, nc.SCORER_VERSION, cutoff, result.news_score, result.news_state,
                            result.n_articles, result.n_stories, z, result.top_event, result.top_article_id,
                            json.dumps(components)))
        await conn.executemany(
            """INSERT INTO news_ticker_scores (ticker, session_date, scorer_version, cutoff_at, news_score, news_state,
                                               n_articles, n_stories, volume_z, top_event, top_article_id, components)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
               ON CONFLICT (ticker, session_date, scorer_version) DO UPDATE SET
                 cutoff_at = EXCLUDED.cutoff_at, news_score = EXCLUDED.news_score, news_state = EXCLUDED.news_state,
                 n_articles = EXCLUDED.n_articles, n_stories = EXCLUDED.n_stories, volume_z = EXCLUDED.volume_z,
                 top_event = EXCLUDED.top_event, top_article_id = EXCLUDED.top_article_id,
                 components = EXCLUDED.components, computed_at = now()""",
            upserts)
        summary = {"session": str(session), "preview": preview, "tickers": len(upserts), "scored": filled,
                   "unscored_articles_in_window": unscored}
        status = "degraded" if unscored else "ok"
        await io.log_run(conn, "news-aggregate", status, summary, items_total=len(upserts),
                         coverage={"expected": len(upserts), "filled": filled}, session=str(session))
        return summary
    finally:
        await conn.close()


async def _story_history(conn, cutoff):
    """Daily distinct-story counts per ticker over the baseline window, zeros included once the archive is old enough."""
    import news_core as nc

    start = cutoff - timedelta(days=BASELINE_DAYS)
    earliest = await conn.fetchval("SELECT MIN(created_at) FROM news_articles")
    if earliest is None:
        return {}
    archive_days = (cutoff.date() - earliest.date()).days
    span = min(BASELINE_DAYS, archive_days)
    if span < nc.MIN_BASELINE_DAYS:
        return {}
    counts = await conn.fetch(
        """SELECT s.ticker, (a.created_at AT TIME ZONE 'America/New_York')::date AS d, COUNT(DISTINCT s.story_id) AS c
             FROM news_article_symbols s JOIN news_articles a USING (article_id)
            WHERE a.created_at > $1 AND a.created_at <= $2 GROUP BY 1, 2""",
        start, cutoff - timedelta(hours=24))
    by_ticker = defaultdict(dict)
    for r in counts:
        by_ticker[r["ticker"]][r["d"]] = r["c"]
    days = [(cutoff - timedelta(days=i + 1)).astimezone(nc.NEW_YORK).date() for i in range(span)]
    return {t: [per_day.get(d, 0) for d in days] for t, per_day in by_ticker.items()}


# ── news_label_outcomes ──────────────────────────────────────────────────────


@app.function(image=image, secrets=[db_secret], timeout=900)
def news_label_outcomes() -> dict:
    """Join matured scores to SIP daily-bar forward returns (§7.1). Only labels where D and D+h bars exist."""
    return asyncio.run(_label())


async def _label() -> dict:
    import news_core as nc
    import news_io as io

    conn = await io.connect()
    try:
        sessions = [r["bar_date"] for r in await conn.fetch(
            "SELECT bar_date FROM daily_bars WHERE ticker = $1 AND feed = 'sip' ORDER BY bar_date", LABEL_BENCHMARK)]
        if not sessions:
            summary = {"labeled": 0, "error": f"no {LABEL_BENCHMARK} SIP bars in daily_bars; nothing can be labeled"}
            await io.log_run(conn, "news-label", "fail", summary)
            return summary
        pending = await conn.fetch(
            """SELECT t.ticker, t.session_date, t.scorer_version, t.news_score, h.h AS horizon
                 FROM news_ticker_scores t CROSS JOIN (VALUES (1), (5), (20)) AS h(h)
                WHERE t.news_score IS NOT NULL AND COALESCE(t.components->>'preview','false') <> 'true'
                  AND NOT EXISTS (SELECT 1 FROM news_score_outcomes o
                                   WHERE o.ticker = t.ticker AND o.session_date = t.session_date
                                     AND o.scorer_version = t.scorer_version AND o.horizon_days = h.h)""")
        if not pending:
            return {"labeled": 0, "pending": 0}
        tickers = sorted({r["ticker"] for r in pending} | {LABEL_BENCHMARK})
        first = min(r["session_date"] for r in pending)
        closes = defaultdict(dict)
        for r in await conn.fetch(
            "SELECT ticker, bar_date, close FROM daily_bars WHERE feed = 'sip' AND ticker = ANY($1) AND bar_date >= $2",
            tickers, first):
            closes[r["ticker"]][r["bar_date"]] = r["close"]

        out, immature, no_bars = [], 0, 0
        for r in pending:
            if r["ticker"] not in closes:
                no_bars += 1
                continue
            outcome = nc.label_outcome(r["news_score"], closes[r["ticker"]], closes[LABEL_BENCHMARK],
                                       sessions, r["session_date"], r["horizon"])
            if outcome is None:
                immature += 1
                continue
            out.append((r["ticker"], r["session_date"], r["scorer_version"], outcome.horizon_days, outcome.ret,
                        LABEL_BENCHMARK, outcome.abn_ret, outcome.hit))
        if out:
            await conn.executemany(
                """INSERT INTO news_score_outcomes (ticker, session_date, scorer_version, horizon_days, ret,
                                                    benchmark, abn_ret, hit)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING""", out)
        summary = {"labeled": len(out), "immature": immature, "no_sip_bars": no_bars, "benchmark": LABEL_BENCHMARK}
        await io.log_run(conn, "news-label", "degraded" if no_bars else "ok", summary, items_total=len(pending))
        return summary
    finally:
        await conn.close()


# ── news_accuracy_eval ───────────────────────────────────────────────────────


@app.function(image=image, secrets=[db_secret], timeout=900)
def news_accuracy_eval(force: bool = False) -> dict:
    """Weekly metrics (§7.2) and the weight decision (§8.3). Appends only; never touches a card."""
    return asyncio.run(_evaluate(force))


def _volume_bucket(z):
    if z is None:
        return None
    for label, low, high in VOLUME_Z_BUCKETS:
        if (low is None or z >= low) and (high is None or z < high):
            return label
    return None


async def _evaluate(force) -> dict:
    import news_core as nc
    import news_io as io

    conn = await io.connect()
    try:
        now = _utcnow()
        today = now.astimezone(nc.NEW_YORK).date()
        if not force and await conn.fetchval(
                "SELECT 1 FROM news_accuracy WHERE computed_on = $1 AND scorer_version = $2 LIMIT 1", today, nc.SCORER_VERSION):
            return {"skipped": f"evaluation for {today} already exists"}

        outcome_rows = await conn.fetch(
            """SELECT o.session_date, o.horizon_days, t.news_score, o.abn_ret, o.hit, t.top_event, t.volume_z, u.universe
                 FROM news_score_outcomes o
                 JOIN news_ticker_scores t USING (ticker, session_date, scorer_version)
                 LEFT JOIN ticker_universe u ON u.ticker = o.ticker
                WHERE o.scorer_version = $1""", nc.SCORER_VERSION)
        coverage_rows = await conn.fetch(
            """SELECT session_date, COUNT(*) AS total, COUNT(news_score) AS filled FROM news_ticker_scores
                WHERE scorer_version = $1 AND COALESCE(components->>'preview','false') <> 'true' GROUP BY 1""",
            nc.SCORER_VERSION)
        coverage_by_session = {r["session_date"]: r["filled"] / r["total"] for r in coverage_rows if r["total"]}

        accuracy_rows = []
        gate_source = None
        for horizon in nc.HORIZONS:
            horizon_rows = [r for r in outcome_rows if r["horizon_days"] == horizon]
            all_sessions = sorted({r["session_date"] for r in horizon_rows})
            for window in ACCURACY_WINDOWS:
                in_window = set(all_sessions[-window:])
                rows = [r for r in horizon_rows if r["session_date"] in in_window]
                if not rows:
                    continue
                cov = [coverage_by_session[s] for s in in_window if s in coverage_by_session]
                coverage = sum(cov) / len(cov) if cov else None
                slices = {("all", "ensemble"): rows}
                for r in rows:
                    for kind, value in (("event_type", r["top_event"]), ("asset_type", r["universe"]),
                                        ("volume_z", _volume_bucket(r["volume_z"]))):
                        if value:
                            slices.setdefault((kind, value), []).append(r)
                for (kind, value), members in slices.items():
                    m = nc.compute_slice_metrics(
                        [(r["session_date"], r["news_score"], r["abn_ret"], r["hit"]) for r in members], horizon, coverage)
                    accuracy_rows.append((today, nc.SCORER_VERSION, horizon, window, kind, value, m.n_obs, m.coverage,
                                          m.hit_rate, m.hit_rate_lo, m.hit_rate_hi, m.rank_ic, m.ic_tstat, m.icir,
                                          m.decile_spread, m.monotonicity, m.brier, None))
                    if (horizon, window, kind) == (5, 250, "all"):
                        gate_source = (len(in_window), m)
        if accuracy_rows:
            await conn.executemany(
                """INSERT INTO news_accuracy (computed_on, scorer_version, horizon_days, window_sessions, slice_kind,
                       slice_value, n_obs, coverage, hit_rate, hit_rate_lo, hit_rate_hi, rank_ic, ic_tstat, icir,
                       decile_spread, monotonicity, brier, delta_ic)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                   ON CONFLICT DO NOTHING""", accuracy_rows)

        if not force and await conn.fetchval(
                """SELECT 1 FROM confluence_news_weights
                    WHERE decided_by = 'evaluator' AND (effective_from AT TIME ZONE 'America/New_York')::date = $1
                    LIMIT 1""", today):
            decision = {"skipped": f"weight decision for {today} already exists", "wrote": False}
        else:
            decision = await _decide_weight(conn, now, gate_source)
        summary = {"computed_on": str(today), "accuracy_rows": len(accuracy_rows), "labeled_outcomes": len(outcome_rows),
                   "weight": decision,
                   "note": "delta_ic is NULL: ticker_cards keeps no history, so the gate cannot pass yet"}
        await io.log_run(conn, "news-accuracy-eval", "ok", summary, items_total=len(outcome_rows))
        return summary
    finally:
        await conn.close()


async def _decide_weight(conn, now, gate_source) -> dict:
    import news_core as nc

    last = await conn.fetchrow(
        "SELECT status, weight, metrics FROM confluence_news_weights ORDER BY effective_from DESC LIMIT 1")
    if last is None:
        state = nc.WeightState("shadow", 0.0)
    else:
        previous = json.loads(last["metrics"]) if isinstance(last["metrics"], str) else dict(last["metrics"])
        state = nc.WeightState(last["status"], float(last["weight"]), bool(previous.get("gate_passed_last", False)),
                               int(previous.get("delta_ic_negative_streak", 0)), int(previous.get("weeks_demoted", 0)))
    if state.status == "override":
        return {"status": "override", "weight": state.weight, "wrote": False}

    n_sessions, m = gate_source if gate_source else (0, None)
    gate = nc.GateInputs(
        n_sessions, m.n_obs if m else 0, m.rank_ic if m else None, m.ic_tstat if m else None,
        None, None, None, m.monotonicity if m else None)  # ΔIC unavailable -> gate cannot pass
    passed = nc.gate_passes(gate)
    new = nc.next_weight_state(state, passed, gate.mean_ic_5d, gate.ic_tstat_5d, {}, None)

    prefix = nc.weight_version(now, 0)[:-1]
    sequence = (await conn.fetchval("SELECT COUNT(*) FROM confluence_news_weights WHERE weight_version LIKE $1",
                                    prefix + "%")) + 1
    metrics = {"gate_passed_last": new.gate_passed_last, "delta_ic_negative_streak": new.delta_ic_negative_streak,
               "weeks_demoted": new.weeks_demoted, "n_sessions_5d_250": n_sessions,
               "n_pairs_5d_250": gate.n_pairs, "rank_ic_5d": gate.mean_ic_5d, "ic_tstat_5d": gate.ic_tstat_5d,
               "monotonicity_5d": gate.monotonicity_5d, "delta_ic": None,
               "scorer_weight_proposal": nc.propose_scorer_weights({})}
    await conn.execute(
        """INSERT INTO confluence_news_weights (weight_version, effective_from, status, weight, scorer_version, metrics, decided_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'evaluator')""",
        nc.weight_version(now, sequence), now, new.status, new.weight, nc.SCORER_VERSION, json.dumps(metrics))
    return {"status": new.status, "weight": new.weight, "gate_passed": passed, "wrote": True}


# ── alpaca_live_poller ───────────────────────────────────────────────────────


@app.function(image=image, secrets=[market_secret, db_secret, aws_secret], timeout=90)
def alpaca_live_poller() -> dict:
    """IEX snapshots for the live set; changed tickers only -> Neon live_prices, mirrored to DynamoDB."""
    return asyncio.run(_poll())


async def _poll() -> dict:
    import news_io as io

    store = io.DynamoStore()
    conn = await io.connect()
    try:
        live_set = [r["ticker"] for r in await conn.fetch(
            """SELECT ticker FROM (
                   SELECT ticker, 1 AS rank FROM paper_positions
                   UNION SELECT ticker, 2 FROM paper_watchlists WHERE active
                   UNION SELECT ticker, 3 FROM watchlist_items
                   UNION SELECT ticker, 4 FROM live_prices) t
                GROUP BY ticker ORDER BY MIN(rank), ticker LIMIT $1""", LIVE_SET_CAP)]
        if not live_set:
            return {"skipped": "empty live set"}
        snapshots: dict[str, dict] = {}
        budget_stopped = False
        for batch in io.chunked(live_set, io.SNAPSHOT_BATCH):
            try:
                snapshots.update(io.fetch_snapshots(store, list(batch)))
            except io.AlpacaBudgetExhausted:
                budget_stopped = True  # the poller skips a minute rather than queueing
                break
        current = {r["ticker"]: float(r["price"]) for r in await conn.fetch(
            "SELECT ticker, price FROM live_prices WHERE ticker = ANY($1)", list(snapshots))}
        changed = {}
        for ticker, snap in snapshots.items():
            trade = snap.get("latestTrade") or {}
            price, traded_at = trade.get("p"), trade.get("t")
            if price is None or traded_at is None or current.get(ticker) == float(price):
                continue
            volume = trade.get("s")  # last trade size, the same meaning the Finnhub feeder writes
            changed[ticker] = (float(price), int(volume) if volume is not None else None, io.parse_iso(traded_at))
        if changed:
            await conn.executemany(
                """INSERT INTO live_prices (ticker, price, volume, traded_at) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (ticker) DO UPDATE SET price = EXCLUDED.price, volume = EXCLUDED.volume,
                       traded_at = EXCLUDED.traded_at, updated_at = now()
                   WHERE EXCLUDED.traded_at >= live_prices.traded_at""",  # never overwrite a newer tick (other feeders write here)
                [(t, p, v, ts) for t, (p, v, ts) in changed.items()])
        written, deferred = store.put_live_prices(
            {t: (p, io.iso_utc(ts)) for t, (p, _v, ts) in changed.items()}, LIVE_POLLER_WRITE_DEADLINE_SECONDS)
        return {"live_set": len(live_set), "snapshots": len(snapshots), "changed": len(changed),
                "dynamo_written": written, "dynamo_deferred": deferred, "budget_exhausted": budget_stopped}
    finally:
        await conn.close()


# ── dispatcher: the only scheduled function ──────────────────────────────────


@app.function(image=image, schedule=modal.Cron("* * * * *"), timeout=60)
def tick() -> list[str]:
    """Every minute: spawn the jobs news_core.due_jobs() says are scheduled for this minute (ET)."""
    import news_core as nc

    launchers = {
        nc.JOB_INGEST: lambda: news_ingest.spawn(),
        nc.JOB_CORROBORATE: lambda: news_corroborate.spawn(),
        nc.JOB_AGGREGATE_PREVIEW: lambda: news_aggregate.spawn(None, True),
        nc.JOB_AGGREGATE_FINAL: lambda: news_aggregate.spawn(None, False),
        nc.JOB_LABEL: lambda: news_label_outcomes.spawn(),
        nc.JOB_EVAL: lambda: news_accuracy_eval.spawn(),
        nc.JOB_POLLER: lambda: alpaca_live_poller.spawn(),
        nc.JOB_SCORE_BACKLOG: lambda: news_score_articles.spawn(None),  # separate from news_ingest's targeted scoring
    }
    due = nc.due_jobs(_utcnow())
    for job in due:
        launchers[job]()
    return due


# ── entrypoints ──────────────────────────────────────────────────────────────


@app.local_entrypoint()
def main():
    """modal run deploy/aws-modal-news/modal_app.py::main  (the read-only reachability check)"""
    report = smoke.remote()
    print(json.dumps(report, indent=2))
    assert report["alpaca_ok"], "Alpaca unreachable"
    assert report["dynamodb_ok"], f"DynamoDB tables not all reachable: {report['dynamodb_tables']}"
    assert report["neon_ok"], "Neon unreachable"
    print("smoke OK")


@app.local_entrypoint()
def run(job: str, session: str = "", preview: bool = False, force: bool = False):
    """modal run deploy/aws-modal-news/modal_app.py::run --job news_ingest"""
    jobs = {
        "news_ingest": lambda: news_ingest.remote(),
        "news_score_articles": lambda: news_score_articles.remote(None),
        "news_corroborate": lambda: news_corroborate.remote(),
        "news_aggregate": lambda: news_aggregate.remote(session or None, preview, force),
        "news_label_outcomes": lambda: news_label_outcomes.remote(),
        "news_accuracy_eval": lambda: news_accuracy_eval.remote(force),
        "alpaca_live_poller": lambda: alpaca_live_poller.remote(),
    }
    if job not in jobs:
        raise SystemExit(f"unknown job {job!r}; choose one of: {', '.join(jobs)}")
    print(json.dumps(jobs[job](), indent=2, default=str))
