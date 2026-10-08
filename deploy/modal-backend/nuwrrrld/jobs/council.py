"""Council jobs: seeding, session planning, Postgres-backed SessionStore (Section 10)."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
from decimal import Decimal
from pathlib import Path

import yaml

from nuwrrrld import dynamo
from nuwrrrld.core.council.debate import Seat
from nuwrrrld.core.council.strategy import MarketContext, build_strategy
from nuwrrrld.core.council.tally import CouncilConfig
from nuwrrrld.jobs import universe

DEFAULT_YAML = Path(__file__).resolve().parents[2] / "council_members.yaml"
STALE_HEARTBEAT_MIN = 30
_ENV_RE = re.compile(r"\$\{(\w+)\}")


def load_yaml(path: str | Path = DEFAULT_YAML) -> dict:
    text = _ENV_RE.sub(lambda m: os.environ.get(m.group(1), ""), Path(path).read_text())
    return yaml.safe_load(text)


def config_version(seat: dict) -> str:
    return hashlib.sha256(json.dumps(seat, sort_keys=True).encode()).hexdigest()[:16]


def seed_council(conn, cfg: dict, inception: dt.date | None = None) -> dict:
    """Idempotent: upsert seats and create paper portfolios (council + per-member, daily + weekly)."""
    from nuwrrrld.core.paper.sizing import DEFAULT_RULES
    inception = inception or dt.date.today()
    assert sum(1 for s in cfg["seats"] if s["role"] == "devils_advocate") == 1, "exactly one devil's advocate seat"
    for s in cfg["seats"]:
        conn.execute(
            """INSERT INTO council_members (slug, display_name, role, strategy_key, strategy_config, model, vote_weight, config_version)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (slug) DO UPDATE SET display_name=EXCLUDED.display_name, role=EXCLUDED.role,
                 strategy_key=EXCLUDED.strategy_key, strategy_config=EXCLUDED.strategy_config, model=EXCLUDED.model,
                 vote_weight=EXCLUDED.vote_weight, config_version=EXCLUDED.config_version, updated_at=now()""",
            (s["slug"], s["display_name"], s["role"], s["strategy_key"], json.dumps(s.get("strategy_config", {})),
             s["model"], s["vote_weight"], config_version(s)))
    cash = DEFAULT_RULES["starting_cash"]
    made = 0
    for cadence in ("daily", "weekly"):
        r = conn.execute(
            """INSERT INTO paper_portfolios (owner_type, cadence, name, starting_cash, cash, rules, inception_date, peak_equity)
               VALUES ('council',%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (name) DO NOTHING RETURNING id""",
            (cadence, f"Council ({cadence})", cash, cash, json.dumps(DEFAULT_RULES), inception, cash)).fetchone()
        made += 1 if r else 0
        for m in conn.execute("SELECT id, display_name FROM council_members WHERE active").fetchall():
            r = conn.execute(
                """INSERT INTO paper_portfolios (owner_type, member_id, cadence, name, starting_cash, cash, rules, inception_date, peak_equity)
                   VALUES ('member',%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (name) DO NOTHING RETURNING id""",
                (m["id"], cadence, f"{m['display_name']} ({cadence})", cash, cash, json.dumps(DEFAULT_RULES), inception, cash)).fetchone()
            made += 1 if r else 0
    return {"seats": len(cfg["seats"]), "portfolios_created": made}


def seed_instruments(conn, rows: list[dict]) -> int:
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO instruments (ticker, name, asset_type, sector, industry, is_tracked_etf, benchmark)
               VALUES (%(ticker)s,%(name)s,%(asset_type)s,%(sector)s,%(industry)s,%(is_tracked_etf)s,%(benchmark)s)
               ON CONFLICT (ticker) DO UPDATE SET name=EXCLUDED.name, sector=EXCLUDED.sector,
                 industry=EXCLUDED.industry, is_tracked_etf=EXCLUDED.is_tracked_etf""", rows)
    return len(rows)


def plan_scheduled_sessions(conn, cadence: str, as_of: dt.date, cfg: dict | None = None) -> list[str]:
    """Top-K |strength| tracked ETFs for the latest run + every held ticker, so exits get debated."""
    cfg = cfg or load_yaml()
    cc = CouncilConfig.from_dict(cfg["council"])
    run = conn.execute("SELECT id FROM signal_runs WHERE as_of_date=%s AND NOT is_backfill AND status IN ('explained','published','computed') "
                       "ORDER BY started_at DESC LIMIT 1", (as_of,)).fetchone()
    if run is None:
        return []
    top = [r["ticker"] for r in conn.execute(
        "SELECT ticker FROM signals WHERE run_id=%s ORDER BY abs(strength) DESC, ticker LIMIT %s", (run["id"], cc.scheduled_top_k)).fetchall()]
    held: list[str] = []
    if cc.include_held_tickers:
        held = [r["ticker"] for r in conn.execute(
            """SELECT DISTINCT p.ticker FROM paper_positions p JOIN paper_portfolios pp ON pp.id=p.portfolio_id
                WHERE pp.cadence=%s AND pp.status <> 'archived' AND NOT pp.is_backtest""", (cadence,)).fetchall()]
    snapshot = {"council": cfg["council"], "seats": {s["slug"]: config_version(s) for s in cfg["seats"]}}
    ids = []
    for ticker in dict.fromkeys(top + held):
        key = f"sched:{cadence}:{as_of}:{ticker}"
        row = conn.execute(
            """INSERT INTO council_sessions (cadence, as_of_date, subject_ticker, trades_portfolios, status, max_rounds,
                                             config_snapshot, idempotency_key, token_budget)
               VALUES (%s,%s,%s,true,'queued',%s,%s,%s,%s) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id""",
            (cadence, as_of, ticker, cc.max_rounds, json.dumps(snapshot), key, cc.token_budget_per_session)).fetchone()
        if row is None:
            row = conn.execute("SELECT id, status FROM council_sessions WHERE idempotency_key=%s", (key,)).fetchone()
            if row["status"] not in ("queued", "running"):
                continue
        ids.append(str(row["id"]))
    return ids


class PgSessionStore:
    """psycopg-backed SessionStore for core.council.debate.run_session."""

    def __init__(self, conn):
        self.conn = conn

    def claim(self, session_id: str) -> bool:
        row = self.conn.execute(
            """UPDATE council_sessions SET status='running', started_at=COALESCE(started_at, now()), heartbeat_at=now()
                WHERE id=%s AND (status='queued' OR (status='running' AND heartbeat_at < now() - make_interval(mins => %s)))
            RETURNING id""", (session_id, STALE_HEARTBEAT_MIN)).fetchone()
        return row is not None

    def load_context(self, session_id: str) -> tuple[MarketContext, CouncilConfig, list[Seat]]:
        s = self.conn.execute("SELECT * FROM council_sessions WHERE id=%s", (session_id,)).fetchone()
        as_of, ticker = s["as_of_date"], s["subject_ticker"]
        bars = universe.load_bars(self.conn, [ticker], as_of)[ticker]
        ind = {r["indicator"]: {"value": float(r["value"]) if r["value"] is not None else None, "components": r["components"]}
               for r in self.conn.execute(
                   "SELECT DISTINCT ON (indicator) indicator, value, components FROM indicator_values "
                   "WHERE ticker=%s AND bar_date=%s ORDER BY indicator, computed_at DESC", (ticker, as_of)).fetchall()}
        sig = self.conn.execute("SELECT direction, strength::float AS strength, timeframe, fired_indicators FROM signals "
                                "WHERE ticker=%s AND as_of_date=%s ORDER BY created_at DESC LIMIT 1", (ticker, as_of)).fetchone()
        hf = self.conn.execute("SELECT verdict, bias, risk_level, vol_regime, invalidation_price::float AS invalidation_price "
                               "FROM hold_fold_verdicts WHERE ticker=%s AND as_of_date=%s AND scope='global' LIMIT 1", (ticker, as_of)).fetchone()
        rot = self.conn.execute("SELECT quadrant, rank FROM sector_rotation_snapshots WHERE ticker=%s AND as_of_date=%s",
                                (ticker, as_of)).fetchone()
        ref = Decimal(str(bars["close"].iloc[-1])).quantize(Decimal("0.000001"))
        atr = Decimal(str((ind.get("atr_14") or {}).get("value") or 0)).quantize(Decimal("0.000001"))
        ctx = MarketContext(as_of, ticker, bars, ind, sig, hf, rot, ref, atr)
        self.conn.execute("UPDATE council_sessions SET context_snapshot=%s WHERE id=%s",
                          (json.dumps({"ticker": ticker, "as_of": str(as_of), "reference_price": str(ref), "atr14": str(atr),
                                       "signal": sig, "hold_fold": hf, "rotation": rot, "indicators": ind}, default=str), session_id))
        cfg = CouncilConfig.from_dict(s["config_snapshot"]["council"])
        seats = [Seat(m["slug"], str(m["id"]), m["role"], float(m["vote_weight"]),
                      build_strategy(m["strategy_key"], m["strategy_config"]))
                 for m in self.conn.execute("SELECT * FROM council_members WHERE active ORDER BY slug").fetchall()]
        return ctx, cfg, seats

    def add_message(self, session_id, seq, round_, member_id, kind, content_md, structured, tokens) -> dict:
        row = self.conn.execute(
            """INSERT INTO council_messages (session_id, seq, round, member_id, kind, content_md, structured, output_tokens)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (session_id, seq) DO NOTHING RETURNING id""",
            (session_id, seq, round_, member_id, kind, content_md, json.dumps(structured), tokens)).fetchone()
        return {"message_id": str(row["id"]) if row else None}

    def add_votes(self, session_id, round_, votes) -> None:
        for seat, p, counted, coerced in votes:
            self.conn.execute(
                """INSERT INTO council_votes (session_id, round, member_id, direction, conviction, invalidation_price, counted, coerced)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (session_id, round, member_id) DO UPDATE SET direction=EXCLUDED.direction,
                     conviction=EXCLUDED.conviction, invalidation_price=EXCLUDED.invalidation_price,
                     counted=EXCLUDED.counted, coerced=EXCLUDED.coerced""",
                (session_id, round_, seat.member_id, p.direction, round(p.conviction, 3), p.invalidation_price, counted, coerced))

    def heartbeat(self, session_id: str, tokens_used: int, rounds_run: int) -> None:
        self.conn.execute("UPDATE council_sessions SET heartbeat_at=now(), tokens_used=%s, rounds_run=%s WHERE id=%s",
                          (tokens_used, rounds_run, session_id))

    def finish(self, session_id, status, consensus, rounds_run, error) -> None:
        if consensus is not None:
            self.conn.execute(
                """INSERT INTO council_consensus (session_id, outcome, direction, conviction, invalidation_price, reference_price,
                                                  agreement_ratio, final_round, summary_md, dissent_summary_md)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (session_id) DO NOTHING""",
                (session_id, consensus["outcome"], consensus["direction"], consensus["conviction"],
                 consensus["invalidation_price"], consensus["reference_price"], consensus["agreement_ratio"],
                 consensus["final_round"], consensus["summary_md"], consensus["dissent_summary_md"]))
            dynamo.mirror_rows("council_consensus", [{"session_id": session_id, **consensus}])
        row = self.conn.execute(
            "UPDATE council_sessions SET status=%s, rounds_run=%s, error=%s, finished_at=now() WHERE id=%s RETURNING *",
            (status, rounds_run, error, session_id)).fetchone()
        dynamo.mirror_rows("council_sessions", [{**row, "id": str(row["id"])}])


class ModalQueueEvents:
    """Adapter from modal.Queue to the LiveEvents protocol (partition per session)."""

    def __init__(self, queue):
        self.queue = queue

    def put(self, event: dict, partition: str) -> None:
        self.queue.put(event, partition=partition)

    def clear(self, partition: str) -> None:
        self.queue.clear(partition=partition)
