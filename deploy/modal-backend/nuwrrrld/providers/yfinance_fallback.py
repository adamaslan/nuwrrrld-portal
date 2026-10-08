"""yfinance fallback - LOCAL RUNS ONLY. Yahoo blocks Modal / Cloud Run / GitHub Actions IPs."""
from __future__ import annotations

import datetime as dt
import os
from decimal import Decimal
from typing import Sequence

from nuwrrrld.providers.base import Bar, CorporateAction, DataNotReady, OpenPrint, ProviderError

_DATACENTER_ENV_MARKERS = ("MODAL_TASK_ID", "MODAL_ENVIRONMENT", "K_SERVICE", "GITHUB_ACTIONS", "AWS_LAMBDA_FUNCTION_NAME")


def host_allows_yfinance() -> bool:
    return not any(os.environ.get(m) for m in _DATACENTER_ENV_MARKERS)


class YFinanceProvider:
    name = "yfinance"

    @classmethod
    def from_env(cls) -> "YFinanceProvider":
        if not host_allows_yfinance():
            raise ProviderError("yfinance is skipped on datacenter hosts (Yahoo blocks them)")
        return cls()

    def daily_bars(self, tickers: Sequence[str], start: dt.date, end: dt.date) -> list[Bar]:
        import yfinance as yf
        df = yf.download(list(tickers), start=start.isoformat(), end=(end + dt.timedelta(days=1)).isoformat(),
                         auto_adjust=False, group_by="ticker", progress=False, threads=False)
        out: list[Bar] = []
        for t in tickers:
            sub = df[t] if len(tickers) > 1 else df
            for idx, row in sub.dropna(subset=["Close"]).iterrows():
                close = Decimal(str(round(float(row["Close"]), 6)))
                adj = Decimal(str(round(float(row.get("Adj Close", row["Close"])), 6)))
                out.append(Bar(t, idx.date(), Decimal(str(round(float(row["Open"]), 6))),
                               Decimal(str(round(float(row["High"]), 6))), Decimal(str(round(float(row["Low"]), 6))),
                               close, int(row["Volume"]), None, adj,
                               (adj / close) if close else Decimal(1), True, self.name, "yahoo"))
        return out

    def session_open(self, tickers, session_date) -> list[OpenPrint]:
        bars = [b for b in self.daily_bars(list(tickers), session_date, session_date) if b.bar_date == session_date]
        if not bars:
            raise DataNotReady(str(session_date))
        return [OpenPrint(b.ticker, session_date, b.open, "yfinance.Open") for b in bars]

    def session_close(self, tickers, session_date) -> dict[str, Decimal]:
        bars = [b for b in self.daily_bars(list(tickers), session_date, session_date) if b.bar_date == session_date]
        if not bars:
            raise DataNotReady(str(session_date))
        return {b.ticker: b.close for b in bars}

    def spread_bps(self, ticker: str) -> Decimal | None:
        return None

    def corporate_actions(self, tickers, start, end) -> list[CorporateAction]:
        return []

    def healthcheck(self) -> bool:
        return True
