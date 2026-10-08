"""DataBundle: every input of a run, serializable. The only link between fetching and computing."""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.providers import BAR_COLUMNS
from nwf_lab.errors import LabError, VendorGapError
from nwf_lab.symbols import canonical

logger = logging.getLogger(__name__)

JSON_FIELDS = (
    "quotes", "profiles", "metrics", "recommendations", "earnings", "insiders", "peers", "news",
)


@dataclass
class DataBundle:
    tickers: list[str]
    bars: dict[str, pd.DataFrame] = field(default_factory=dict)
    quotes: dict[str, dict] = field(default_factory=dict)
    profiles: dict[str, dict] = field(default_factory=dict)
    metrics: dict[str, dict] = field(default_factory=dict)
    recommendations: dict[str, list] = field(default_factory=dict)
    earnings: dict[str, list] = field(default_factory=dict)
    earnings_calendar: list[dict] = field(default_factory=list)
    insiders: dict[str, list] = field(default_factory=dict)
    peers: dict[str, list] = field(default_factory=dict)
    news: dict[str, list] = field(default_factory=dict)
    positions: pd.DataFrame | None = None        # symbol, shares, cost_basis
    provenance: dict[str, Any] = field(default_factory=dict)  # field -> {source, feed, fetched_at}
    gaps: list[str] = field(default_factory=list)
    manual_edits: list[str] = field(default_factory=list)

    # --- identity ------------------------------------------------------
    def content_hash(self) -> str:
        h = hashlib.sha256()
        for sym in sorted(self.bars):
            h.update(sym.encode())
            h.update(pd.util.hash_pandas_object(self.bars[sym], index=True).values.tobytes())
        meta = {k: getattr(self, k) for k in (*JSON_FIELDS, "earnings_calendar", "tickers")}
        h.update(json.dumps(meta, sort_keys=True, default=str).encode())
        if self.positions is not None:
            h.update(pd.util.hash_pandas_object(self.positions, index=False).values.tobytes())
        return h.hexdigest()[:16]

    def copy(self) -> DataBundle:
        import copy

        return copy.deepcopy(self)

    def summary(self) -> pd.DataFrame:
        rows = []
        for t in self.tickers:
            b = self.bars.get(t)
            rows.append({
                "ticker": t, "bars": 0 if b is None else len(b),
                "last_bar": None if b is None or b.empty else str(b.index[-1].date()),
                "bars_source": (b.attrs.get("source") if b is not None else None),
                "quote": t in self.quotes, "profile": t in self.profiles,
                "news": len(self.news.get(t, [])),
            })
        return pd.DataFrame(rows)

    # --- persistence ---------------------------------------------------
    def save(self, parquet_path: str | Path) -> Path:
        path = Path(parquet_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        frames = []
        for sym, df in self.bars.items():
            f = df.reset_index().rename(columns={df.index.name or "index": "date"})
            f["symbol"] = sym
            f["_source"] = df.attrs.get("source", "unknown")
            f["_feed"] = df.attrs.get("feed", "unknown")
            frames.append(f)
        pd.concat(frames, ignore_index=True).to_parquet(path) if frames else pd.DataFrame(
            columns=["date", "symbol", *BAR_COLUMNS]
        ).to_parquet(path)
        meta = {k: getattr(self, k) for k in (*JSON_FIELDS, "earnings_calendar")}
        meta.update(
            tickers=self.tickers, provenance=self.provenance, gaps=self.gaps,
            manual_edits=self.manual_edits,
            positions=None if self.positions is None else self.positions.to_dict("records"),
        )
        path.with_name(path.stem + ".meta.json").write_text(json.dumps(meta, indent=2, default=str))
        return path

    @classmethod
    def load(cls, parquet_path: str | Path) -> DataBundle:
        path = Path(parquet_path)
        meta_path = path.with_name(path.stem + ".meta.json")
        if not path.exists() or not meta_path.exists():
            raise LabError(f"bundle not found: {path} (+ {meta_path.name})")
        meta = json.loads(meta_path.read_text())
        raw = pd.read_parquet(path)
        bars: dict[str, pd.DataFrame] = {}
        for sym, g in raw.groupby("symbol"):
            df = g.set_index(pd.to_datetime(g["date"]))[BAR_COLUMNS].sort_index()
            df.index.name = "date"
            df.attrs.update(source=g["_source"].iloc[0], feed=g["_feed"].iloc[0])
            bars[str(sym)] = df
        positions = meta.get("positions")
        bars = {t: bars[t] for t in meta["tickers"] if t in bars}  # keep the original ticker order
        return cls(
            tickers=meta["tickers"], bars=bars,
            positions=pd.DataFrame(positions) if positions else None,
            provenance=meta.get("provenance", {}), gaps=meta.get("gaps", []),
            manual_edits=meta.get("manual_edits", []),
            earnings_calendar=meta.get("earnings_calendar", []),
            **{k: meta.get(k, {}) for k in JSON_FIELDS},
        )


def _note_gap(bundle: DataBundle, err: VendorGapError) -> None:
    msg = str(err)
    if msg not in bundle.gaps:
        bundle.gaps.append(msg)
    logger.warning(msg)


def fetch_bundle(
    tickers: list[str],
    days: int,
    cfg: LabConfig,
    *,
    bars_providers: list,
    quote_provider,
    fundamentals,
    positions: pd.DataFrame | None = None,
) -> DataBundle:
    """The only stage that calls vendors. Bars walk the provider chain; first one that serves wins."""
    syms = [canonical(t) for t in tickers]
    if positions is not None:
        extra = [canonical(s) for s in positions["symbol"] if canonical(s) not in syms]
        syms += extra
    b = DataBundle(tickers=syms, positions=positions)
    stamp = datetime.now(UTC).isoformat()

    missing = list(syms)
    for prov in bars_providers:
        if not missing:
            break
        try:
            got = prov.daily_bars(missing, days)
        except VendorGapError as e:
            _note_gap(b, e)
            continue
        for sym, df in got.items():
            b.bars[sym] = df
            b.provenance[f"bars:{sym}"] = {
                "source": df.attrs.get("source", prov.name), "feed": df.attrs.get("feed"),
                "fetched_at": stamp,
            }
        missing = [s for s in missing if s not in got]
    for sym in missing:
        b.gaps.append(f"vendor_gap: no bars for {sym} from any provider")

    try:
        b.quotes = quote_provider.quotes(syms)
        for s in b.quotes:
            b.provenance[f"quote:{s}"] = {"source": b.quotes[s].get("source"), "fetched_at": stamp}
    except VendorGapError as e:
        _note_gap(b, e)

    today = date.today()
    news_start = (today - timedelta(days=cfg.news_lookback_days)).isoformat()
    for sym in syms:
        for attr, call in (
            ("profiles", lambda s=sym: fundamentals.profile(s)),
            ("metrics", lambda s=sym: fundamentals.metrics(s)),
            ("recommendations", lambda s=sym: fundamentals.recommendations(s)),
            ("earnings", lambda s=sym: fundamentals.earnings(s)),
            ("insiders", lambda s=sym: fundamentals.insider_transactions(s)),
            ("peers", lambda s=sym: fundamentals.peers(s)),
            ("news", lambda s=sym: fundamentals.company_news(s, news_start, today.isoformat())),
        ):
            try:
                getattr(b, attr)[sym] = call()
                b.provenance[f"{attr}:{sym}"] = {"source": fundamentals.name, "fetched_at": stamp}
            except VendorGapError as e:
                _note_gap(b, e)
    try:
        b.earnings_calendar = fundamentals.earnings_calendar(
            today.isoformat(), (today + timedelta(days=14)).isoformat()
        )
    except VendorGapError as e:
        _note_gap(b, e)
    return b
