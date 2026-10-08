"""Feature registry. Features are pure: (bundle, cfg, ctx) -> FeatureResult. No I/O, no network."""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import LabError, VendorGapError

logger = logging.getLogger(__name__)

Status = Literal["ok", "vendor_gap", "skipped_llm", "skipped_input", "error"]


@dataclass(frozen=True)
class FeatureResult:
    slug: str
    status: Status
    data: dict = field(default_factory=dict)
    frames: dict[str, pd.DataFrame] = field(default_factory=dict)
    sources: tuple[str, ...] = ()
    note: str | None = None


@dataclass(frozen=True)
class RunContext:
    upstream: dict[str, FeatureResult]
    llm_call: Callable[[str], str] | None = None


@dataclass(frozen=True)
class FeatureSpec:
    slug: str
    needs: tuple[str, ...]
    depends_on: tuple[str, ...]
    fn: Callable[[DataBundle, LabConfig, RunContext], FeatureResult]
    llm: bool = False


FEATURES: dict[str, FeatureSpec] = {}


def feature(slug: str, needs=(), depends_on=(), llm: bool = False):
    def wrap(fn):
        FEATURES[slug] = FeatureSpec(slug, tuple(needs), tuple(depends_on), fn, llm)
        return fn

    return wrap


def _load_all() -> None:
    from nwf_lab.features import (  # noqa: F401
        analyze,
        backtest,
        earnings,
        fib,
        holdfold,
        ichimoku,
        insider,
        llm,
        news_sentiment,
        paper,
        portfolio,
        signals,
    )


def _closure(only: list[str] | None) -> list[str]:
    _load_all()
    wanted = list(FEATURES) if not only else list(only)
    unknown = [s for s in wanted if s not in FEATURES]
    if unknown:
        raise LabError(f"unknown feature slug(s): {', '.join(unknown)}")
    seen: dict[str, None] = {}

    def visit(slug: str) -> None:
        if slug in seen:
            return
        for dep in FEATURES[slug].depends_on:
            visit(dep)
        seen[slug] = None

    for s in wanted:
        visit(s)
    return list(seen)  # dependency-first order


def run_features(
    bundle: DataBundle,
    cfg: LabConfig,
    *,
    with_llm: bool = False,
    only: list[str] | None = None,
    llm_call: Callable[[str], str] | None = None,
) -> dict[str, FeatureResult]:
    """Run features in dependency order. One feature's failure never stops the others."""
    results: dict[str, FeatureResult] = {}
    for slug in _closure(only):
        spec = FEATURES[slug]
        ctx = RunContext(upstream=results, llm_call=llm_call if with_llm else None)
        broken = [d for d in spec.depends_on if results[d].status in ("error", "vendor_gap", "skipped_input")]
        if broken:
            results[slug] = FeatureResult(
                slug, "skipped_input", note=f"upstream not ok: {', '.join(broken)}"
            )
            continue
        try:
            results[slug] = spec.fn(bundle, cfg, ctx)
        except VendorGapError as e:
            results[slug] = FeatureResult(slug, "vendor_gap", note=str(e))
        except LabError as e:
            results[slug] = FeatureResult(slug, "skipped_input", note=str(e))
        except Exception as e:  # noqa: BLE001 - a feature crash must be recorded, not propagated
            logger.exception("feature %s crashed", slug)
            results[slug] = FeatureResult(slug, "error", note=f"{type(e).__name__}: {e}")
    return results


def ok(slug: str, data: dict, frames=None, sources=(), note=None) -> FeatureResult:
    return FeatureResult(slug, "ok", data, frames or {}, tuple(sources), note)
