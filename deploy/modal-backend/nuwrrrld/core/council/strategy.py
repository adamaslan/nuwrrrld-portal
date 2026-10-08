"""Pluggable per-seat strategy interface + registry (Section 10.2). Strategies themselves are placeholders."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal, Protocol, runtime_checkable

Direction = Literal["long", "short", "flat"]


@dataclass(frozen=True)
class MarketContext:
    """Identical for every seat. Contains ONLY data with bar_date <= as_of_date."""
    as_of_date: date
    ticker: str
    bars: "pandas.DataFrame"            # noqa: F821 - adjusted daily OHLCV history
    indicators: dict[str, dict]
    signal: dict | None
    hold_fold: dict | None
    rotation: dict | None
    reference_price: Decimal
    atr14: Decimal


@dataclass(frozen=True)
class Proposal:
    direction: Direction
    conviction: float
    invalidation_price: Decimal | None
    rationale_md: str
    evidence: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class DebateState:
    round: int
    proposals: dict[str, Proposal]
    transcript_summary: str
    leading_direction: Direction | None
    da_challenge: str | None


@runtime_checkable
class Strategy(Protocol):
    """Reads only MarketContext/DebateState (no network/DB I/O); may use the budget-metered `llm`."""
    key: str
    def propose(self, ctx: MarketContext, llm) -> Proposal: ...
    def critique(self, ctx: MarketContext, state: DebateState, llm) -> str: ...
    def respond_to_challenge(self, ctx: MarketContext, state: DebateState, llm) -> str: ...
    def revise(self, ctx: MarketContext, state: DebateState, llm) -> Proposal: ...
    def target_weight(self, ctx: MarketContext, final: Proposal) -> float: ...


REGISTRY: dict[str, type] = {}


def register(*keys: str):
    def deco(cls):
        for k in keys:
            REGISTRY[k] = cls
        return cls
    return deco


def build_strategy(strategy_key: str, config: dict) -> Strategy:
    try:
        cls = REGISTRY[strategy_key]
    except KeyError:
        raise ValueError(f"Unregistered strategy '{strategy_key}' (check council_members.yaml)") from None
    inst = cls(config)
    inst.key = strategy_key
    return inst


@register("placeholder.strategy_1", "placeholder.strategy_2", "placeholder.strategy_3",
          "placeholder.strategy_4", "placeholder.strategy_5", "placeholder.contrarian")
class PlaceholderStrategy:
    """Stand-in until real strategies are registered: always flat, zero conviction.

    With every seat on a placeholder each session ends 'consensus: flat' and no paper orders are
    created, which is the safe default.
    """
    def __init__(self, config: dict): self.config = config
    def propose(self, ctx, llm): return Proposal("flat", 0.0, None, "Placeholder strategy.")
    def critique(self, ctx, state, llm): return "Placeholder: no critique."
    def respond_to_challenge(self, ctx, state, llm): return "Placeholder: no response."
    def revise(self, ctx, state, llm): return self.propose(ctx, llm)
    def target_weight(self, ctx, final): return 0.0
