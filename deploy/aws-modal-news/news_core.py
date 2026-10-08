"""Pure logic for the 4th pipeline (nwf4): no network, no database, no clock.

Everything here is a function of its arguments, so it is unit-tested offline
(tests/test_news_core.py) and the Modal jobs in modal_app.py only add I/O around
it. Design: docs/fin-api-and-4th-aws-modal-pipeline.md §6 (scoring), §7
(accuracy), §8.3 (weight governance).

Standard library only, on purpose: the lean Modal image and the test run both
import this module without numpy/scipy.
"""

from __future__ import annotations

import hashlib
import math
import re
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo

NEW_YORK = ZoneInfo("America/New_York")
SESSION_CUTOFF_HOUR_ET = 16

SCORER_VERSION = "ensemble_v1"
SCORER_LEXICON = "lexicon_lm_v1"
SCORER_FINBERT = "finbert_v1"
SCORER_LLM = "llm_v1"

NEUTRAL_BAND = 0.15
AGGREGATE_WINDOW_HOURS = 72
AGGREGATE_SATURATION = 1.5
CORROBORATION_BOOST = 1.1
SUMMARY_MAX_CHARS = 600
STORY_HAMMING_THRESHOLD = 3
STORY_WINDOW_HOURS = 48
NOVELTY_FIRST = 1.0
NOVELTY_SAME_DAY_REPEAT = 0.3
NOVELTY_LATER_REPEAT = 0.1
MIN_BASELINE_DAYS = 10
MIN_STORY_STDEV = 0.5

# Ensemble prior weights (§6.3), renormalised over whichever scorers are present.
ENSEMBLE_WEIGHTS = {SCORER_FINBERT: 0.50, SCORER_LLM: 0.35, SCORER_LEXICON: 0.15}

# §6.5: (prior weight, half-life in hours).
EVENT_TAXONOMY: dict[str, tuple[float, float]] = {
    "earnings": (1.00, 36.0),
    "guidance": (1.00, 48.0),
    "mna": (1.00, 72.0),
    "regulatory_legal": (0.80, 72.0),
    "offering_dilution": (0.90, 48.0),
    "analyst_rating": (0.60, 24.0),
    "capital_return": (0.50, 48.0),
    "management": (0.50, 48.0),
    "product_business": (0.40, 36.0),
    "macro_sector": (0.20, 12.0),
    "other": (0.30, 24.0),
}

# Ordered: the first rule that matches names the event. Specific before general.
EVENT_KEYWORD_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("offering_dilution", ("offering", "dilution", "secondary", "shelf registration", "convertible notes", "at-the-market")),
    ("guidance", ("guidance", "outlook", "forecast", "raises forecast", "cuts forecast", "reaffirms", "withdraws")),
    ("earnings", ("earnings", "eps", "quarterly results", "q1 ", "q2 ", "q3 ", "q4 ", "revenue beat", "revenue miss", "tops estimates", "misses estimates", "beats estimates")),
    ("mna", ("acquire", "acquisition", "merger", "buyout", "takeover", "to buy ", "deal to", "tender offer", "spin-off", "spinoff")),
    ("regulatory_legal", ("fda", "lawsuit", "sues", "sued", "probe", "investigation", "antitrust", "sec charges", "settlement", "ruling", "subpoena", "recall")),
    ("analyst_rating", ("upgrade", "downgrade", "price target", "initiates coverage", "reiterates", "maintains", "overweight", "underweight", "outperform", "underperform")),
    ("capital_return", ("dividend", "buyback", "repurchase", "share repurchase")),
    ("management", ("ceo", "cfo", "chief executive", "chief financial", "steps down", "resigns", "appoints", "names new")),
    ("product_business", ("launch", "unveils", "contract", "partnership", "announces", "customer", "expands", "approval")),
    ("macro_sector", ("fed ", "inflation", "tariff", "jobs report", "treasury", "oil prices", "sector", "futures", "s&p 500", "nasdaq", "dow ")),
)
HIGH_IMPACT_KEYWORDS = ("earnings", "guidance", "fda", "merger", "acquisition", "offering", "downgrade", "upgrade")

# Curated finance polarity lexicon. Deliberately a compact subset in the spirit
# of Loughran-McDonald (the full list is ~2.3k negative / ~350 positive words);
# the scorer id keeps the design's name, and the evaluator measures how much
# this subset is worth, per scorer, before anything depends on it.
LEXICON_POSITIVE = frozenset(
    """beat beats beating surge surges surged soar soars soared jump jumps jumped rally rallies rallied gain gains gained
    rise rises rose growth grows grew strong stronger strength record profit profits profitable upgrade upgraded upgrades
    outperform outperforms outperformed raises raised boost boosts boosted improve improves improved improvement
    exceed exceeds exceeded exceeding approval approved approves win wins won winning breakthrough accelerate accelerates
    accelerating expand expands expanded expansion momentum bullish optimistic resilient robust favorable successful
    success tops topped upside buyback dividend positive rebound rebounds rebounded recover recovers recovered recovery
    lead leads leading leader innovative efficient efficiency opportunity opportunities""".split()
)
LEXICON_NEGATIVE = frozenset(
    """miss misses missed missing plunge plunges plunged tumble tumbles tumbled drop drops dropped fall falls fell decline
    declines declined weak weaker weakness loss losses lose loses lost downgrade downgraded downgrades underperform
    underperforms cut cuts slash slashes slashed warn warns warning warned lawsuit sues sued probe investigation
    investigations fraud default bankruptcy bankrupt layoff layoffs recall recalls halt halts halted delay delays
    delayed concern concerns risk risks risky volatile volatility pressure pressured struggle struggles struggling
    slump slumps slumped crash crashes crashed selloff bearish pessimistic disappoint disappoints disappointing
    disappointed shortfall deficit penalty fine fined fines violation violations dilution weakening deteriorate
    deteriorates deteriorating downside negative tumult scandal subpoena resigns resignation withdraw withdraws
    withdrawn suspend suspends suspended fail fails failed failure""".split()
)
NEGATIONS = frozenset({"not", "no", "never", "without", "fails", "failed", "cannot", "n't", "neither", "nor"})

_WORD_RE = re.compile(r"[a-z][a-z'\-]*")
_NUMBER_RE = re.compile(r"\$?\d[\d,.]*%?")
_CASHTAG_RE = re.compile(r"\$[A-Za-z]{1,5}\b")


@dataclass(frozen=True)
class ScorerOutput:
    """One scorer's verdict on one article."""

    scorer: str
    polarity: float  # -1..1
    confidence: float  # 0..1
    event_type: Optional[str] = None


# ── Text and clustering ──────────────────────────────────────────────────────


def normalize_headline(headline: str, tickers: Iterable[str] = ()) -> str:
    """Lowercase; mask cashtags, listed tickers and numbers so re-worded copies cluster."""
    text = _CASHTAG_RE.sub(" ", headline)
    for ticker in tickers:
        text = re.sub(rf"\b{re.escape(ticker)}\b", " ", text)
    text = _NUMBER_RE.sub(" ", text.lower())
    return " ".join(_WORD_RE.findall(text))


def simhash64(text: str) -> int:
    """64-bit SimHash over word unigrams and bigrams, as a signed int (Postgres bigint)."""
    words = text.split()
    if not words:
        return 0
    features = words + [f"{a} {b}" for a, b in zip(words, words[1:])]
    votes = [0] * 64
    for feature in features:
        digest = int.from_bytes(hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest(), "big")
        for bit in range(64):
            votes[bit] += 1 if (digest >> bit) & 1 else -1
    value = sum(1 << bit for bit in range(64) if votes[bit] > 0)
    return value - (1 << 64) if value >= (1 << 63) else value


def hamming(a: int, b: int) -> int:
    return bin((a ^ b) & ((1 << 64) - 1)).count("1")


def token_jaccard(a: str, b: str) -> float:
    left, right = set(a.split()), set(b.split())
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


@dataclass(frozen=True)
class StoryRef:
    """A previously seen article for one ticker, used to cluster new ones."""

    story_id: str
    simhash: int
    created_at: datetime
    story_first_at: datetime


def assign_story(simhash: int, created_at: datetime, prior: Sequence[StoryRef]) -> tuple[str, float, datetime]:
    """Return (story_id, novelty, story_first_at). Same story = Hamming <= 3 within 48 h."""
    window = timedelta(hours=STORY_WINDOW_HOURS)
    best: Optional[StoryRef] = None
    best_distance = STORY_HAMMING_THRESHOLD + 1
    for ref in prior:
        if abs(created_at - ref.created_at) > window:
            continue
        distance = hamming(simhash, ref.simhash)
        if distance < best_distance:
            best, best_distance = ref, distance
    if best is None:
        return f"{simhash & ((1 << 64) - 1):016x}", NOVELTY_FIRST, created_at
    age = created_at - best.story_first_at
    novelty = NOVELTY_SAME_DAY_REPEAT if age <= timedelta(hours=24) else NOVELTY_LATER_REPEAT
    return best.story_id, novelty, best.story_first_at


def relevance(symbols_count: int, ticker: str, headline: str, company_name: Optional[str] = None) -> float:
    """§6.2: 1/sqrt(k), boosted 1.25x when the ticker or company is named in the headline."""
    k = max(1, symbols_count)
    named = bool(re.search(rf"(?<![A-Za-z]){re.escape(ticker)}(?![A-Za-z])", headline)) or (
        bool(company_name) and company_name.lower() in headline.lower()
    )
    return min(1.0, (1.0 / math.sqrt(k)) * (1.25 if named else 1.0))


def truncate_summary(summary: Optional[str]) -> Optional[str]:
    if not summary:
        return None
    return summary[:SUMMARY_MAX_CHARS]


# ── Session arithmetic ───────────────────────────────────────────────────────


def session_cutoff(session_date: date) -> datetime:
    """16:00 America/New_York on `session_date`, as UTC."""
    local = datetime(session_date.year, session_date.month, session_date.day, SESSION_CUTOFF_HOUR_ET, tzinfo=NEW_YORK)
    return local.astimezone(timezone.utc)


def session_for_article(created_at: datetime) -> date:
    """The session an article counts toward: after the 16:00 ET cutoff -> next weekday.

    Weekday-only: exchange holidays are resolved by the caller via the broker
    calendar; this is the pure fallback.
    """
    local = created_at.astimezone(NEW_YORK)
    day = local.date()
    if local.hour >= SESSION_CUTOFF_HOUR_ET:
        day += timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


# ── Scorers ──────────────────────────────────────────────────────────────────


def classify_event(text: str) -> str:
    lowered = f" {text.lower()} "
    for event, keywords in EVENT_KEYWORD_RULES:
        if any(keyword in lowered for keyword in keywords):
            return event
    return "other"


def is_high_impact(text: str) -> bool:
    lowered = text.lower()
    return any(keyword in lowered for keyword in HIGH_IMPACT_KEYWORDS)


def lexicon_score(headline: str, summary: Optional[str] = None) -> ScorerOutput:
    """polarity = (pos - neg) / (pos + neg + 1); confidence = min(1, (pos + neg) / 4)."""
    text = f"{headline}. {summary or ''}"
    words = _WORD_RE.findall(text.lower())
    positive = negative = 0.0
    for index, word in enumerate(words):
        negated = any(prev in NEGATIONS for prev in words[max(0, index - 2) : index])
        if word in LEXICON_POSITIVE:
            negative, positive = (negative + 1, positive) if negated else (negative, positive + 1)
        elif word in LEXICON_NEGATIVE:
            positive, negative = (positive + 1, negative) if negated else (positive, negative + 1)
    event = classify_event(headline)
    if event == "offering_dilution":
        negative += 2  # §6.5: the keyword rule defaults an offering's polarity to negative
    polarity = (positive - negative) / (positive + negative + 1)
    confidence = min(1.0, (positive + negative) / 4.0)
    return ScorerOutput(SCORER_LEXICON, _clamp(polarity, -1.0, 1.0), _clamp(confidence, 0.0, 1.0), event)


def finbert_output(p_positive: float, p_negative: float, p_neutral: float) -> ScorerOutput:
    """polarity = p_pos - p_neg; confidence = max class probability."""
    return ScorerOutput(
        SCORER_FINBERT,
        _clamp(p_positive - p_negative, -1.0, 1.0),
        _clamp(max(p_positive, p_negative, p_neutral), 0.0, 1.0),
    )


def ensemble(outputs: Sequence[ScorerOutput]) -> Optional[ScorerOutput]:
    """§6.3: confidence-weighted polarity; scorer disagreement lowers confidence."""
    present = [o for o in outputs if o.scorer in ENSEMBLE_WEIGHTS]
    if not present:
        return None
    weighted_conf = sum(ENSEMBLE_WEIGHTS[o.scorer] * o.confidence for o in present)
    weight_total = sum(ENSEMBLE_WEIGHTS[o.scorer] for o in present)
    if weighted_conf <= 0:
        polarity = 0.0
    else:
        polarity = sum(ENSEMBLE_WEIGHTS[o.scorer] * o.polarity * o.confidence for o in present) / weighted_conf
    spread = statistics.pstdev([o.polarity for o in present]) if len(present) > 1 else 0.0
    confidence = (weighted_conf / weight_total) * (1.0 - 0.5 * min(1.0, spread))
    event = next((o.event_type for o in present if o.scorer == SCORER_LLM and o.event_type), None) or next(
        (o.event_type for o in present if o.event_type), None
    )
    return ScorerOutput(SCORER_VERSION, _clamp(polarity, -1.0, 1.0), _clamp(confidence, 0.0, 1.0), event)


def needs_llm(lexicon: ScorerOutput, finbert: ScorerOutput, text: str, volume_z: Optional[float]) -> bool:
    """§6.3 LLM selection: sign disagreement at conf >= .5, unusual attention, or a high-impact keyword."""
    disagree = (
        lexicon.polarity * finbert.polarity < 0 and lexicon.confidence >= 0.5 and finbert.confidence >= 0.5
    )
    return disagree or (volume_z is not None and volume_z >= 2.0) or is_high_impact(text)


# ── Per-ticker aggregation (§6.4) ────────────────────────────────────────────


@dataclass(frozen=True)
class ArticleSignal:
    """One article's contribution to one ticker, with everything §6.4 multiplies."""

    article_id: int
    created_at: datetime
    source: str
    polarity: float
    confidence: float
    relevance: float
    novelty: float
    event_type: str
    story_id: str
    corroborated: bool = False


@dataclass(frozen=True)
class TickerScore:
    news_score: Optional[float]
    news_state: str
    n_articles: int
    n_stories: int
    stories_24h: int
    top_event: Optional[str]
    top_article_id: Optional[int]
    components: dict


def news_state(score: Optional[float]) -> str:
    if score is None:
        return "absent"
    if abs(score) < NEUTRAL_BAND:
        return "neutral"
    return "bullish" if score > 0 else "bearish"


def aggregate_ticker(
    signals: Sequence[ArticleSignal],
    cutoff: datetime,
    event_weights: Optional[Mapping[str, float]] = None,
    source_weights: Optional[Mapping[str, float]] = None,
) -> TickerScore:
    """news_score = tanh(S / 1.5) over articles in (cutoff - 72h, cutoff]. Absent when none qualify."""
    window_start = cutoff - timedelta(hours=AGGREGATE_WINDOW_HOURS)
    inside = [s for s in signals if window_start < s.created_at <= cutoff]
    if not inside:
        return TickerScore(None, "absent", 0, 0, 0, None, None, {})

    total = 0.0
    by_event: dict[str, float] = defaultdict(float)
    strongest: tuple[float, Optional[int]] = (0.0, None)
    for s in inside:
        prior_weight, half_life = EVENT_TAXONOMY.get(s.event_type, EVENT_TAXONOMY["other"])
        event_weight = (event_weights or {}).get(s.event_type, prior_weight)
        source_weight = (source_weights or {}).get(s.source, 1.0)
        age_hours = (cutoff - s.created_at).total_seconds() / 3600.0
        decay = math.exp(-math.log(2) * age_hours / half_life)
        contribution = (
            s.polarity
            * s.confidence
            * s.relevance
            * event_weight
            * source_weight
            * s.novelty
            * decay
            * (CORROBORATION_BOOST if s.corroborated else 1.0)
        )
        total += contribution
        by_event[s.event_type] += contribution
        if abs(contribution) > abs(strongest[0]):
            strongest = (contribution, s.article_id)

    score = math.tanh(total / AGGREGATE_SATURATION)
    recent = {s.story_id for s in inside if (cutoff - s.created_at) <= timedelta(hours=24)}
    top_event = max(by_event, key=lambda event: abs(by_event[event])) if by_event else None
    return TickerScore(
        news_score=score,
        news_state=news_state(score),
        n_articles=len(inside),
        n_stories=len({s.story_id for s in inside}),
        stories_24h=len(recent),
        top_event=top_event,
        top_article_id=strongest[1],
        components={"S": round(total, 6), "events": {k: round(v, 6) for k, v in by_event.items()}},
    )


def volume_z(stories_24h: int, history: Sequence[int]) -> Optional[float]:
    """Attention vs the ticker's own 60-day baseline; None until the baseline has history."""
    if len(history) < MIN_BASELINE_DAYS:
        return None
    return (stories_24h - statistics.fmean(history)) / max(statistics.pstdev(history), MIN_STORY_STDEV)


# ── Outcome labeling (§7.1) ──────────────────────────────────────────────────

HORIZONS = (1, 5, 20)


@dataclass(frozen=True)
class Outcome:
    horizon_days: int
    ret: float
    abn_ret: float
    hit: Optional[bool]


def forward_return(closes: Mapping[date, float], sessions: Sequence[date], session: date, horizon: int) -> Optional[float]:
    """close[D+h] / close[D] - 1 over the trading calendar `sessions`; None until D+h has a bar."""
    if session not in closes:
        return None
    try:
        start = sessions.index(session)
    except ValueError:
        return None
    if start + horizon >= len(sessions):
        return None
    end_close = closes.get(sessions[start + horizon])
    if end_close is None or closes[session] <= 0:
        return None
    return end_close / closes[session] - 1.0


def label_outcome(
    news_score: float,
    ticker_closes: Mapping[date, float],
    benchmark_closes: Mapping[date, float],
    sessions: Sequence[date],
    session: date,
    horizon: int,
) -> Optional[Outcome]:
    """Abnormal return vs the benchmark; hit only outside the neutral band. None while immature."""
    ret = forward_return(ticker_closes, sessions, session, horizon)
    bench = forward_return(benchmark_closes, sessions, session, horizon)
    if ret is None or bench is None:
        return None
    abn = ret - bench
    hit = None
    if abs(news_score) >= NEUTRAL_BAND and abn != 0:
        hit = (news_score > 0) == (abn > 0)
    return Outcome(horizon, ret, abn, hit)


# ── Metrics (§7.2) ───────────────────────────────────────────────────────────


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _ranks(values: Sequence[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        average = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = average
        i = j + 1
    return ranks


def spearman(xs: Sequence[float], ys: Sequence[float]) -> Optional[float]:
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    vy = math.sqrt(sum((b - my) ** 2 for b in ry))
    if vx == 0 or vy == 0:
        return None
    return cov / (vx * vy)


def wilson_interval(successes: int, trials: int, z: float = 1.96) -> tuple[Optional[float], Optional[float]]:
    if trials <= 0:
        return None, None
    p = successes / trials
    denom = 1 + z * z / trials
    centre = (p + z * z / (2 * trials)) / denom
    margin = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / denom
    return max(0.0, centre - margin), min(1.0, centre + margin)


MIN_TICKERS_PER_SESSION_IC = 20


def session_ics(rows: Sequence[tuple[date, float, float]]) -> list[tuple[date, float]]:
    """Per-session rank IC of (session, news_score, abn_ret); sessions under 20 tickers are skipped."""
    grouped: dict[date, list[tuple[float, float]]] = defaultdict(list)
    for session, score, abn in rows:
        grouped[session].append((score, abn))
    result = []
    for session in sorted(grouped):
        pairs = grouped[session]
        if len(pairs) < MIN_TICKERS_PER_SESSION_IC:
            continue
        ic = spearman([p[0] for p in pairs], [p[1] for p in pairs])
        if ic is not None:
            result.append((session, ic))
    return result


@dataclass(frozen=True)
class IcSummary:
    mean_ic: Optional[float]
    ic_tstat: Optional[float]
    icir: Optional[float]
    n_sessions: int


def summarize_ics(ics: Sequence[tuple[date, float]], horizon: int) -> IcSummary:
    """Mean IC, ICIR, and a t-stat on non-overlapping sessions (every h-th) so 5d/20d windows don't inflate it."""
    values = [ic for _, ic in ics]
    if not values:
        return IcSummary(None, None, None, 0)
    mean_ic = statistics.fmean(values)
    stdev = statistics.stdev(values) if len(values) > 1 else 0.0
    icir = mean_ic / stdev if stdev > 0 else None
    thinned = values[:: max(1, horizon)]
    tstat = None
    if len(thinned) > 1:
        sd = statistics.stdev(thinned)
        if sd > 0:
            tstat = statistics.fmean(thinned) / (sd / math.sqrt(len(thinned)))
    return IcSummary(mean_ic, tstat, icir, len(values))


def decile_stats(rows: Sequence[tuple[date, float, float]]) -> tuple[Optional[float], Optional[float]]:
    """(top-minus-bottom decile spread of abn_ret, monotonicity) averaged over sessions of >= 20 tickers."""
    grouped: dict[date, list[tuple[float, float]]] = defaultdict(list)
    for session, score, abn in rows:
        grouped[session].append((score, abn))
    decile_returns: dict[int, list[float]] = defaultdict(list)
    for pairs in grouped.values():
        if len(pairs) < MIN_TICKERS_PER_SESSION_IC:
            continue
        ordered = sorted(pairs, key=lambda p: p[0])
        size = len(ordered)
        buckets: dict[int, list[float]] = defaultdict(list)
        for index, (_, abn) in enumerate(ordered):
            buckets[min(9, index * 10 // size)].append(abn)
        for decile, values in buckets.items():
            decile_returns[decile].append(statistics.fmean(values))
    if len(decile_returns) < 10:
        return None, None
    means = [statistics.fmean(decile_returns[d]) for d in range(10)]
    return means[9] - means[0], spearman(list(range(10)), means)


def brier_score(rows: Sequence[tuple[float, float]]) -> Optional[float]:
    """rows = (news_score, abn_ret). p_up = 0.5 + 0.5 * score, against 1[abn_ret > 0]."""
    if not rows:
        return None
    return statistics.fmean((0.5 + 0.5 * score - (1.0 if abn > 0 else 0.0)) ** 2 for score, abn in rows)


@dataclass(frozen=True)
class SliceMetrics:
    n_obs: int
    coverage: Optional[float]
    hit_rate: Optional[float]
    hit_rate_lo: Optional[float]
    hit_rate_hi: Optional[float]
    rank_ic: Optional[float]
    ic_tstat: Optional[float]
    icir: Optional[float]
    decile_spread: Optional[float]
    monotonicity: Optional[float]
    brier: Optional[float]


def compute_slice_metrics(
    rows: Sequence[tuple[date, float, float, Optional[bool]]],
    horizon: int,
    coverage: Optional[float] = None,
) -> SliceMetrics:
    """rows = (session, news_score, abn_ret, hit). Everything §7.2 asks for, for one slice."""
    triples = [(session, score, abn) for session, score, abn, _ in rows]
    hits = [hit for *_, hit in rows if hit is not None]
    wins = sum(1 for hit in hits if hit)
    lo, hi = wilson_interval(wins, len(hits))
    ic = summarize_ics(session_ics(triples), horizon)
    spread, monotonicity = decile_stats(triples)
    return SliceMetrics(
        n_obs=len(rows),
        coverage=coverage,
        hit_rate=(wins / len(hits)) if hits else None,
        hit_rate_lo=lo,
        hit_rate_hi=hi,
        rank_ic=ic.mean_ic,
        ic_tstat=ic.ic_tstat,
        icir=ic.icir,
        decile_spread=spread,
        monotonicity=monotonicity,
        brier=brier_score([(score, abn) for _, score, abn, _ in rows]),
    )


# ── Weight governance (§8.3) ─────────────────────────────────────────────────

MIN_SLICE_OBS_FOR_REFIT = 300
WEIGHT_GRID = (0.0, 0.25, 0.5, 0.75, 1.0)
WEIGHT_HYSTERESIS = 0.10
GATE_MIN_SESSIONS = 120
GATE_MIN_PAIRS = 5000
GATE_MIN_IC = 0.02
GATE_MIN_TSTAT = 2.0
GATE_MIN_DELTA_IC = 0.005
GATE_MIN_MONOTONICITY = 0.6
DEMOTE_STREAK = 3
DEMOTED_COOLDOWN_WEEKS = 8


@dataclass(frozen=True)
class GateInputs:
    """Horizon-5, 250-session, ensemble metrics plus ΔIC at horizons 1 and 20."""

    n_sessions: int
    n_pairs: int
    mean_ic_5d: Optional[float]
    ic_tstat_5d: Optional[float]
    delta_ic_5d: Optional[float]
    delta_ic_1d: Optional[float]
    delta_ic_20d: Optional[float]
    monotonicity_5d: Optional[float]


def gate_passes(g: GateInputs) -> bool:
    """§8.3. Any missing metric (e.g. ΔIC with no card history) fails the gate: absent is not passing."""
    required = (g.mean_ic_5d, g.ic_tstat_5d, g.delta_ic_5d, g.delta_ic_1d, g.delta_ic_20d, g.monotonicity_5d)
    if any(value is None for value in required):
        return False
    return (
        g.n_sessions >= GATE_MIN_SESSIONS
        and g.n_pairs >= GATE_MIN_PAIRS
        and g.mean_ic_5d >= GATE_MIN_IC
        and g.ic_tstat_5d >= GATE_MIN_TSTAT
        and g.delta_ic_5d >= GATE_MIN_DELTA_IC
        and g.delta_ic_1d >= 0
        and g.delta_ic_20d >= 0
        and g.monotonicity_5d >= GATE_MIN_MONOTONICITY
    )


@dataclass(frozen=True)
class WeightState:
    status: str  # shadow | active | demoted | override
    weight: float
    gate_passed_last: bool = False  # did the previous evaluation pass the gate
    delta_ic_negative_streak: int = 0
    weeks_demoted: int = 0


def next_weight_state(
    state: WeightState,
    gate_now: bool,
    mean_ic_5d: Optional[float],
    ic_tstat_5d: Optional[float],
    delta_ic_by_weight: Mapping[float, float],
    delta_ic_now: Optional[float],
) -> WeightState:
    """One weekly step of the shadow/active/demoted state machine. An override is never touched."""
    if state.status == "override":
        return state

    if state.status == "shadow":
        if gate_now and state.gate_passed_last and mean_ic_5d is not None:
            weight = _choose_weight(mean_ic_5d, delta_ic_by_weight, current=0.0)
            if weight > 0:
                return WeightState("active", weight, True, 0, 0)
        return WeightState("shadow", 0.0, gate_now, 0, 0)

    if state.status == "active":
        streak = state.delta_ic_negative_streak + 1 if (delta_ic_now is not None and delta_ic_now < 0) else 0
        if streak >= DEMOTE_STREAK or (ic_tstat_5d is not None and ic_tstat_5d < 0):
            return WeightState("demoted", 0.0, False, 0, 0)
        weight = state.weight
        if mean_ic_5d is not None:
            candidate = _choose_weight(mean_ic_5d, delta_ic_by_weight, current=state.weight)
            if abs(candidate - state.weight) >= WEIGHT_HYSTERESIS:
                weight = candidate
        return WeightState("active", weight, gate_now, streak, 0)

    # demoted: sit out the cooldown, then re-enter evaluation as shadow.
    weeks = state.weeks_demoted + 1
    if weeks >= DEMOTED_COOLDOWN_WEEKS:
        return WeightState("shadow", 0.0, False, 0, 0)
    return WeightState("demoted", 0.0, False, 0, weeks)


def _choose_weight(mean_ic_5d: float, delta_ic_by_weight: Mapping[float, float], current: float) -> float:
    """w_raw = clamp(IC/0.05, 0, 1); pick the grid weight <= w_raw with the best ΔIC (ties -> smaller)."""
    w_raw = _clamp(mean_ic_5d / 0.05, 0.0, 1.0)
    candidates = [w for w in WEIGHT_GRID if w <= w_raw and w in delta_ic_by_weight]
    if not candidates:
        return current if current <= w_raw else 0.0
    return max(candidates, key=lambda w: (delta_ic_by_weight[w], -w))


def propose_scorer_weights(
    per_scorer_ic: Mapping[str, tuple[Optional[float], int]],
) -> dict[str, float]:
    """§6.3/§7.3 re-fit PROPOSAL: shrink 50% toward the prior, clamp to [0, 1.5] x prior, only >= 300 obs.

    Returned for the audit snapshot. It does not change what the scorers use;
    that requires a new scorer_version, which is a deliberate, separate step.
    """
    proposal = dict(ENSEMBLE_WEIGHTS)
    eligible = {
        scorer: max(ic, 0.0)
        for scorer, (ic, n_obs) in per_scorer_ic.items()
        if scorer in ENSEMBLE_WEIGHTS and ic is not None and n_obs >= MIN_SLICE_OBS_FOR_REFIT
    }
    total_ic = sum(eligible.values())
    if len(eligible) < 2 or total_ic <= 0:
        return proposal
    prior_mass = sum(ENSEMBLE_WEIGHTS[s] for s in eligible)
    for scorer, ic in eligible.items():
        fitted = prior_mass * (ic / total_ic)
        shrunk = 0.5 * ENSEMBLE_WEIGHTS[scorer] + 0.5 * fitted
        proposal[scorer] = _clamp(shrunk, 0.0, 1.5 * ENSEMBLE_WEIGHTS[scorer])
    return proposal


def weight_version(now: datetime, sequence: int = 1) -> str:
    return f"nw-{now.astimezone(timezone.utc).strftime('%Y-%m-%d')}-{sequence}"


# ── Scheduler (one Modal cron fans out to every job) ─────────────────────────

JOB_INGEST = "news_ingest"
JOB_CORROBORATE = "news_corroborate"
JOB_AGGREGATE_FINAL = "news_aggregate_final"
JOB_AGGREGATE_PREVIEW = "news_aggregate_preview"
JOB_LABEL = "news_label_outcomes"
JOB_EVAL = "news_accuracy_eval"
JOB_POLLER = "alpaca_live_poller"

# Retry slots exist because a cron tick can be skipped; each job is idempotent
# (a finished final aggregate / label / eval no-ops on the retry).
_FINAL_AGGREGATE_SLOTS = ((16, 5), (16, 25))
_LABEL_SLOTS = ((19, 0), (19, 30))
_EVAL_SLOTS = ((10, 0), (10, 30))


def due_jobs(now: datetime) -> list[str]:
    """Which jobs §5.1 says should start this minute (evaluated in America/New_York).

    Holidays are handled inside the jobs (broker clock/calendar), not here.
    """
    local = now.astimezone(NEW_YORK)
    hour, minute, weekday = local.hour, local.minute, local.weekday()
    on_weekday = weekday < 5
    clock = (hour, minute)
    due: list[str] = []

    in_ingest_window = on_weekday and 7 <= hour < 20
    if (in_ingest_window and minute % 2 == 0) or (not in_ingest_window and minute % 30 == 0):
        due.append(JOB_INGEST)

    in_market = on_weekday and (9, 30) <= clock <= (16, 0)
    if in_market and minute in (0, 30):
        due.append(JOB_CORROBORATE)
    if in_market:
        due.append(JOB_POLLER)
    if on_weekday and clock == (9, 20):
        due.append(JOB_AGGREGATE_PREVIEW)
    if on_weekday and clock in _FINAL_AGGREGATE_SLOTS:
        due.append(JOB_AGGREGATE_FINAL)
    if on_weekday and clock in _LABEL_SLOTS:
        due.append(JOB_LABEL)
    if weekday == 5 and clock in _EVAL_SLOTS:
        due.append(JOB_EVAL)
    return due
