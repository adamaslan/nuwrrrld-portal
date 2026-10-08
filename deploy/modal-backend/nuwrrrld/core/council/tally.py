"""Vote roll-up, consensus test and invalidation aggregation (Sections 10.4-10.5). Pure and unit-tested."""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

DIRECTIONS = ("long", "short", "flat")


@dataclass(frozen=True)
class CouncilConfig:
    max_rounds: int = 4
    consensus_threshold: float = 0.67
    headcount_threshold: float = 0.6
    min_counted_voters: int = 4
    exclude_roles_from_tally: tuple[str, ...] = ("devils_advocate",)
    require_da_challenge_response: bool = True
    invalidation_aggregation: str = "median"
    invalidation_atr_clamp: tuple[float, float] = (0.5, 4.0)
    token_budget_per_session: int = 60000
    scheduled_top_k: int = 8
    include_held_tickers: bool = True
    on_demand_daily_limit_per_user: int = 3

    @classmethod
    def from_dict(cls, d: dict) -> "CouncilConfig":
        subjects = d.get("subjects", {})
        return cls(
            max_rounds=d.get("max_rounds", 4), consensus_threshold=d.get("consensus_threshold", 0.67),
            headcount_threshold=d.get("headcount_threshold", 0.6), min_counted_voters=d.get("min_counted_voters", 4),
            exclude_roles_from_tally=tuple(d.get("exclude_roles_from_tally", ["devils_advocate"])),
            require_da_challenge_response=d.get("require_da_challenge_response", True),
            invalidation_aggregation=d.get("invalidation_aggregation", "median"),
            invalidation_atr_clamp=tuple(d.get("invalidation_atr_clamp", [0.5, 4.0])),
            token_budget_per_session=d.get("token_budget_per_session", 60000),
            scheduled_top_k=subjects.get("scheduled_top_k", 8),
            include_held_tickers=subjects.get("include_held_tickers", True),
            on_demand_daily_limit_per_user=d.get("on_demand_daily_limit_per_user", 3))


@dataclass(frozen=True)
class SeatVote:
    slug: str
    role: str
    direction: str
    conviction: float
    weight: float
    invalidation: Decimal | None = None
    coerced: bool = False


@dataclass(frozen=True)
class TallyResult:
    lead: str
    ratio: float
    heads: float
    consensus: bool
    conviction: float
    counted: int
    weights: dict[str, float]
    reason: str


def counted_votes(votes: list[SeatVote], cfg: CouncilConfig) -> list[SeatVote]:
    return [v for v in votes if v.role not in cfg.exclude_roles_from_tally]


def tally(votes: list[SeatVote], cfg: CouncilConfig, responded: set[str] | None = None) -> TallyResult:
    """`responded` = analyst slugs that have posted a 'response' to the DA challenge."""
    counted = counted_votes(votes, cfg)
    w = {d: sum(v.weight * v.conviction for v in counted if v.direction == d) for d in DIRECTIONS}
    wtot = sum(w.values())
    n = len(counted)
    all_flat_zero = n > 0 and all(v.direction == "flat" for v in counted)

    if wtot == 0:
        lead, ratio = "flat", (1.0 if all_flat_zero else 0.0)
    else:
        top = max(w.values())
        leaders = [d for d in DIRECTIONS if w[d] == top]
        lead = leaders[0] if len(leaders) == 1 else "flat"  # ties -> flat
        ratio = (w[lead] / wtot) if lead in w else 0.0
        if len(leaders) > 1:
            ratio = w["flat"] / wtot
    heads = (sum(1 for v in counted if v.direction == lead) / n) if n else 0.0

    reason = "ok"
    ok = True
    if n < cfg.min_counted_voters:
        ok, reason = False, f"counted voters {n} < {cfg.min_counted_voters}"
    elif ratio < cfg.consensus_threshold:
        ok, reason = False, f"agreement ratio {ratio:.3f} < {cfg.consensus_threshold}"
    elif heads < cfg.headcount_threshold:
        ok, reason = False, f"headcount {heads:.3f} < {cfg.headcount_threshold}"
    elif cfg.require_da_challenge_response:
        analysts = {v.slug for v in counted}
        if not analysts <= (responded or set()):
            ok, reason = False, "not every analyst answered the devil's-advocate challenge"

    agreeing = [v for v in counted if v.direction == lead]
    wsum = sum(v.weight for v in agreeing)
    conviction = (sum(v.weight * v.conviction for v in agreeing) / wsum) if wsum else 0.0
    return TallyResult(lead, round(ratio, 3), round(heads, 3), ok, round(conviction, 3), n, w, reason)


def _weighted_median(pairs: list[tuple[float, float]]) -> float:
    pairs = sorted(pairs)
    half = sum(w for _, w in pairs) / 2
    acc = 0.0
    for value, weight in pairs:
        acc += weight
        if acc >= half:
            return value
    return pairs[-1][0]


def aggregate_invalidation(votes: list[SeatVote], lead: str, cfg: CouncilConfig, reference: Decimal,
                           atr14: Decimal) -> Decimal | None:
    """Median/weighted-median/most-conservative level, clamped to [0.5,4] x ATR14, rounded to $0.01.

    Returns None (=> no_consensus) when no seat supplied a level or it lands on the wrong side.
    """
    if lead == "flat":
        return None
    levels = [v for v in counted_votes(votes, cfg) if v.direction == lead and v.invalidation is not None]
    if not levels:
        return None
    vals = [float(v.invalidation) for v in levels]
    agg = cfg.invalidation_aggregation
    if agg == "weighted_median":
        raw = _weighted_median([(float(v.invalidation), v.weight * v.conviction) for v in levels])
    elif agg == "most_conservative":
        ref = float(reference)
        raw = min(vals, key=lambda x: abs(ref - x))
    else:
        raw = statistics.median(vals)
    ref, atr = float(reference), float(atr14)
    # A level already on the wrong side is a defect in the votes, not something the clamp may silently repair.
    if (lead == "long" and raw >= ref) or (lead == "short" and raw <= ref):
        return None
    lo, hi = cfg.invalidation_atr_clamp
    dist = min(max(abs(ref - raw), lo * atr), hi * atr)
    clamped = ref - dist if lead == "long" else ref + dist
    out = Decimal(str(clamped)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if (lead == "long" and out >= reference) or (lead == "short" and out <= reference):
        return None
    return out


def validate_proposal(direction: str, conviction: float, invalidation: Decimal | None,
                      reference: Decimal, evidence: list[dict], known_values: dict[str, float]) -> list[str]:
    """Return a list of validator errors (empty = valid)."""
    errors: list[str] = []
    if direction not in DIRECTIONS:
        errors.append(f"direction must be one of {DIRECTIONS}")
    if not 0.0 <= conviction <= 1.0:
        errors.append("conviction must be within [0, 1]")
    if direction in ("long", "short"):
        if invalidation is None:
            errors.append("invalidation_price is required unless direction is flat")
        elif direction == "long" and invalidation >= reference:
            errors.append("long invalidation must be below the reference price")
        elif direction == "short" and invalidation <= reference:
            errors.append("short invalidation must be above the reference price")
    for item in evidence:
        name, value = item.get("indicator"), item.get("value")
        known = known_values.get(name)
        if known is None or value is None or abs(float(value) - known) > max(1e-6, abs(known) * 0.005):
            errors.append(f"evidence '{name}'={value} does not match the context")
    return errors
