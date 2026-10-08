"""Run output: results.json (deterministic), summary.html, and the status counts line."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

from nwf_lab import charts
from nwf_lab.config import INVENTORY_PATH
from nwf_lab.data.bundle import DataBundle
from nwf_lab.features.registry import FEATURES, FeatureResult

PAPER_ALIASES_PREFIX = ("undocumented-get--api-paper", "undocumented-post--api-pipeline-paper")


def _jsonable(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, (pd.Timestamp,)):
        return str(o)
    return str(o)


def excluded_slugs() -> list[str]:
    if not INVENTORY_PATH.exists():
        return []
    inv = [f["slug"] for f in json.loads(INVENTORY_PATH.read_text())["features"]]
    return [s for s in inv if s not in FEATURES and not s.startswith(PAPER_ALIASES_PREFIX)]


def counts(results: dict[str, FeatureResult]) -> Counter:
    c: Counter = Counter()
    for slug, r in results.items():
        c["llm_skipped" if FEATURES[slug].llm and r.status == "skipped_llm" else r.status] += 1
    return c


def summary_line(results: dict[str, FeatureResult]) -> str:
    c = counts(results)
    in_scope = sum(1 for s in results if not FEATURES[s].llm)
    return (f"{in_scope} in scope · {c['ok']} ok · {c['vendor_gap']} vendor_gap · "
            f"{c['skipped_input']} skipped_input · {c['error']} error · "
            f"{c['llm_skipped']} llm skipped · {len(excluded_slugs())} excluded")


def exit_code(results: dict[str, FeatureResult]) -> int:
    in_scope = [r for s, r in results.items() if not FEATURES[s].llm]
    if any(r.status == "error" for r in in_scope):
        return 1
    return 2 if any(r.status == "vendor_gap" for r in in_scope) else 0


def write_run(out_dir: Path, bundle: DataBundle, results: dict[str, FeatureResult]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle.save(out_dir / "bundle.parquet")
    payload = {
        "results": {s: {"status": r.status, "sources": list(r.sources), "note": r.note, "data": r.data}
                    for s, r in results.items()},
        "meta": {"summary": summary_line(results), "gaps": bundle.gaps, "excluded": excluded_slugs(),
                 "bundle_hash": bundle.content_hash()},
    }
    (out_dir / "results.json").write_text(json.dumps(payload, indent=2, default=_jsonable, sort_keys=True))
    (out_dir / "summary.html").write_text(_html(bundle, results))
    return out_dir


def _html(bundle: DataBundle, results: dict[str, FeatureResult]) -> str:
    parts = [f"<h1>nwf-lab run</h1><p><b>{summary_line(results)}</b></p>"]
    if bundle.gaps:
        parts.append("<h3>Vendor gaps</h3><ul>" + "".join(f"<li>{g}</li>" for g in bundle.gaps) + "</ul>")
    parts.append(charts.status_grid(results).to_html(full_html=False, include_plotlyjs="cdn"))
    if "signals-top" in results and results["signals-top"].status == "ok":
        parts.append(charts.leaderboard(results["signals-top"]).to_html(full_html=False, include_plotlyjs=False))
    if "analyze" in results and results["analyze"].status == "ok":
        first = next(iter(results["analyze"].frames))
        parts.append(charts.candles_with_bands(bundle, results, first).to_html(full_html=False, include_plotlyjs=False))
    if "signals-digest" in results and results["signals-digest"].status == "ok":
        parts.append(f"<pre>{results['signals-digest'].data['text']}</pre>")
    return ("<!doctype html><html><head><meta charset='utf-8'><title>nwf-lab run</title>"
            "<style>body{font-family:system-ui;margin:24px;max-width:1100px}</style></head><body>"
            + "".join(parts) + "</body></html>")
