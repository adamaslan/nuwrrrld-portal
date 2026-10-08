"""Environment-driven settings. Values are injected by Modal Secrets; nothing is read from files."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

DEFAULT_REFERRAL_MAX_REWARDS_PER_YEAR = 12


def _csv(name: str, default: str = "") -> frozenset[str]:
    return frozenset(p.strip() for p in os.environ.get(name, default).split(",") if p.strip())


@dataclass(frozen=True)
class Settings:
    market_provider: str = field(default_factory=lambda: os.environ.get("MARKET_DATA_PROVIDER", "alpaca"))
    market_fallback: str | None = field(default_factory=lambda: os.environ.get("MARKET_DATA_FALLBACK") or None)
    alpaca_feed_eod: str = field(default_factory=lambda: os.environ.get("ALPACA_DATA_FEED_EOD", "sip"))
    alpaca_feed_live: str = field(default_factory=lambda: os.environ.get("ALPACA_DATA_FEED_LIVE", "iex"))
    llm_model_fast: str = field(default_factory=lambda: os.environ.get("LLM_MODEL_FAST", ""))
    llm_model_smart: str = field(default_factory=lambda: os.environ.get("LLM_MODEL_SMART", ""))
    llm_daily_budget_usd: float = field(default_factory=lambda: float(os.environ.get("LLM_DAILY_BUDGET_USD", "25")))
    user_daily_token_budget: int = field(default_factory=lambda: int(os.environ.get("USER_DAILY_TOKEN_BUDGET", "60000")))
    disclaimer_version: str = field(default_factory=lambda: os.environ.get("DISCLAIMER_VERSION", "1"))
    friend_reward_mode: str = field(default_factory=lambda: os.environ.get("FRIEND_REWARD_MODE", "on_first_subscription"))
    referral_cap: int = field(default_factory=lambda: int(os.environ.get("REFERRAL_MAX_REWARDS_PER_YEAR", DEFAULT_REFERRAL_MAX_REWARDS_PER_YEAR)))
    shadow_mode: bool = field(default_factory=lambda: os.environ.get("SHADOW_MODE", "0") == "1")
    authorized_parties: frozenset[str] = field(default_factory=lambda: _csv("CLERK_AUTHORIZED_PARTIES"))
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(_csv("CORS_ORIGINS", "https://financial.nuwrrrld.com")))


def settings() -> Settings:
    return Settings()
