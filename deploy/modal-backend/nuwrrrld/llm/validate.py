"""Anti-hallucination output validation (Section 13.4): numeric cross-check, directive filter, templates."""
from __future__ import annotations

import re
from typing import Any, Iterable

from nuwrrrld import DISCLAIMER

# Indicator parameters and horizon labels that legitimately appear in prose.
NUMBER_WHITELIST = frozenset({1, 2, 3, 5, 9, 10, 12, 14, 20, 21, 25, 26, 30, 42, 50, 63, 70, 126, 200, 252, 0, 100})
_NUM_RE = re.compile(r"(?<![\w.])[-+]?\$?\d[\d,]*(?:\.\d+)?%?")


def _flatten_numbers(value: Any) -> Iterable[float]:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        yield float(value)
    elif hasattr(value, "__float__") and not isinstance(value, str):
        yield float(value)
    elif isinstance(value, dict):
        for v in value.values():
            yield from _flatten_numbers(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _flatten_numbers(v)
    elif isinstance(value, str):
        for m in _NUM_RE.findall(value):
            try:
                yield float(m.replace("$", "").replace(",", "").rstrip("%"))
            except ValueError:
                continue


def extract_numbers(text: str) -> list[tuple[float, int, bool]]:
    """(value, decimals, is_percent) for every number in text."""
    out = []
    for m in _NUM_RE.findall(text):
        raw = m.replace("$", "").replace(",", "")
        pct = raw.endswith("%")
        raw = raw.rstrip("%")
        try:
            val = float(raw)
        except ValueError:
            continue
        out.append((val, len(raw.split(".")[1]) if "." in raw else 0, pct))
    return out


def unmatched_numbers(text: str, source: Any) -> list[float]:
    """Numbers in `text` that match no value in `source` (within display rounding) nor the whitelist."""
    pool = list(_flatten_numbers(source))
    bad = []
    for val, decimals, pct in extract_numbers(text):
        if abs(val) in NUMBER_WHITELIST:
            continue
        tol = 0.51 * 10 ** -decimals
        candidates = [p * 100 for p in pool] + pool if pct else pool + [p * 100 for p in pool]
        if any(abs(round(c, decimals) - val) <= tol or abs(abs(c) - abs(val)) <= tol for c in candidates):
            continue
        bad.append(val)
    return bad


def numeric_check(text: str, source: Any) -> tuple[bool, list[float]]:
    bad = unmatched_numbers(text, source)
    return (not bad), bad


_DIRECTIVES = [
    (re.compile(r"\byou\s+should\s+(?:definitely\s+)?buy\b", re.I), "the model's reading is bullish on"),
    (re.compile(r"\byou\s+should\s+(?:definitely\s+)?sell\b", re.I), "the model's reading is bearish on"),
    (re.compile(r"\b(?:i|we)\s+recommend\s+(?:that\s+you\s+)?buy(?:ing)?\b", re.I), "the signals lean bullish on"),
    (re.compile(r"\b(?:i|we)\s+recommend\s+(?:that\s+you\s+)?sell(?:ing)?\b", re.I), "the signals lean bearish on"),
    (re.compile(r"\byou\s+must\s+(?:buy|sell)\b", re.I), "the indicators point toward a view on"),
    (re.compile(r"\b(?:buy|sell)\s+now\b", re.I), "a signal is present now"),
]


def directive_filter(text: str, *, append_disclaimer: bool = True) -> str:
    for pattern, repl in _DIRECTIVES:
        text = pattern.sub(repl, text)
    if append_disclaimer and DISCLAIMER not in text:
        text = f"{text.rstrip()}\n\n_{DISCLAIMER}_"
    return text


def template_explanation(sig: dict) -> str:
    """Deterministic fallback built only from the structured signal."""
    fired = sig.get("fired_indicators") or []
    lines = [f"{sig['ticker']}: {sig['direction']} signal, strength {sig['strength']:+.3f}, "
             f"{sig['timeframe'].replace('_', ' ')} view over about {sig['horizon_days']} sessions."]
    for f in fired[:6]:
        reading = f.get("reading")
        lines.append(f"- {f['indicator']} reading {reading:.3f} ({f['rule'].replace('_', ' ')})." if reading is not None
                     else f"- {f['indicator']} ({f['rule'].replace('_', ' ')}).")
    if not fired:
        lines.append("- No rule fired; indicators are mixed.")
    lines.append("This reading weakens if the indicators above reverse.")
    return directive_filter("\n".join(lines))


def template_rationale(verdict: dict) -> str:
    return directive_filter(
        f"{verdict['ticker']}: verdict {verdict['verdict']} for a {verdict['position_side']} position; "
        f"bias {verdict['bias']}, risk {verdict['risk_level']}, volatility regime {verdict['vol_regime']}.")
