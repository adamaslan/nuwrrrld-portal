"""Frozen, hashable run configuration. Every Streamlit slider maps to one field here."""
from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass, field
from pathlib import Path

PORTAL_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ENV_FILE = PORTAL_ROOT / ".env.local"
INVENTORY_PATH = PORTAL_ROOT / "docs" / "nulogdash-inventory.json"
DEFAULT_TICKERS = ("AAPL", "NVDA", "MSFT")


def env_file_candidates() -> list[Path]:
    """NWF_LAB_ENV, this checkout's .env.local, then the main checkout's (git worktrees don't get the
    gitignored .env.local, so a lab running from a worktree would otherwise find no keys)."""
    import subprocess

    found: list[Path] = []
    if os.getenv("NWF_LAB_ENV"):
        found.append(Path(os.environ["NWF_LAB_ENV"]).expanduser())
    found.append(DEFAULT_ENV_FILE)
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=PORTAL_ROOT, capture_output=True, text=True, timeout=5, check=True,
        ).stdout.strip()
        found.append(Path(common).parent / ".env.local")
    except (subprocess.SubprocessError, OSError):
        pass
    return found


@dataclass(frozen=True)
class LabConfig:
    # indicators (mirror homebase/locrun.py:analyze)
    rsi_window: int = 14
    rsi_overbought: float = 70.0
    rsi_oversold: float = 30.0
    rsi_bull: float = 55.0
    rsi_bear: float = 45.0
    macd_fast: int = 12
    macd_slow: int = 26
    macd_signal: int = 9
    bb_window: int = 20
    bb_std: float = 2.0
    sma_fast: int = 20
    sma_slow: int = 50
    vol_window: int = 20
    vol_surge: float = 1.2
    vol_dry: float = 0.8
    bull_vote_threshold: int = 2        # votes needed to call a direction
    buy_score: int = 70                 # ai_score at/above -> BUY
    sell_score: int = 30                # ai_score at/below -> SELL
    # ichimoku
    ichi_tenkan: int = 9
    ichi_kijun: int = 26
    ichi_senkou_b: int = 52
    ichi_cross_lookback: int = 5
    # fibonacci
    fib_lookback: int = 120
    fib_tolerance: float = 0.01         # within 1% of a level counts as "at" it
    # holdfold
    fold_score: int = 40
    hold_score: int = 60
    # backtest
    backtest_hold_days: int = 5
    backtest_min_bars: int = 60
    # paper engine (quant policy, lib/shared/paper-policy.ts v1)
    paper_buy_threshold: int = 75
    paper_sell_threshold: int = 50
    paper_max_position_weight: float = 0.04
    paper_cash_floor: float = 0.0
    paper_start_cash: float = 100_000.0
    # news / insider
    news_lookback_days: int = 7
    insider_lookback_days: int = 90
    # universe
    top_n: int = 10

    def replace(self, **kw) -> LabConfig:
        return dataclasses.replace(self, **kw)


@dataclass(frozen=True)
class Credentials:
    finnhub: str | None = field(default=None, repr=False)
    alpaca_key: str | None = field(default=None, repr=False)
    alpaca_secret: str | None = field(default=None, repr=False)
    openrouter: str | None = field(default=None, repr=False)

    @classmethod
    def from_env(cls, env_file: Path | None = None) -> Credentials:
        from dotenv import load_dotenv

        for candidate in ([env_file] if env_file else env_file_candidates()):
            if candidate.exists():
                load_dotenv(candidate, override=False)
                break
        return cls(
            finnhub=os.getenv("FINNHUB_API_KEY") or None,
            alpaca_key=os.getenv("ALPACA_API_KEY") or None,
            alpaca_secret=os.getenv("ALPACA_API_SECRET") or None,
            openrouter=os.getenv("OPENROUTER_API_KEY") or None,
        )
