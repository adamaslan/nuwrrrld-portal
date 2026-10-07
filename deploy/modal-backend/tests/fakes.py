"""Test doubles: market-data provider and an httpx-backed LLM transport."""
from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal

import httpx
import psycopg
from psycopg.rows import dict_row

from nuwrrrld.providers.base import Bar, CorporateAction, DataNotReady, OpenPrint


class FakeProvider:
    name = "fake"

    def __init__(self, bars: list[Bar] | None = None, opens: dict[str, Decimal] | None = None, actions=None, ready=True):
        self._bars, self._opens, self._actions, self.ready = bars or [], opens or {}, actions or [], ready
        self.calls = 0

    def daily_bars(self, tickers, start, end):
        self.calls += 1
        return [b for b in self._bars if b.ticker in tickers and start <= b.bar_date <= end]

    def session_open(self, tickers, session_date):
        if not self.ready:
            raise DataNotReady("not yet")
        return [OpenPrint(t, session_date, self._opens[t], "daily_bar.open") for t in tickers if t in self._opens]

    def session_close(self, tickers, session_date):
        return {t: self._opens[t] for t in tickers if t in self._opens}

    def spread_bps(self, ticker):
        return None

    def corporate_actions(self, tickers, start, end):
        return list(self._actions)

    def healthcheck(self):
        return True


def bar(ticker, day, close, provider="fake"):
    c = Decimal(str(close))
    return Bar(ticker, day, c, c * Decimal("1.004"), c * Decimal("0.996"), c, 1_000_000, None, c, Decimal(1), True, provider, "sip")


def conn_factory(dsn):
    return lambda: psycopg.connect(dsn, autocommit=True, row_factory=dict_row, prepare_threshold=None)


def llm_transport(responder):
    """httpx.MockTransport that answers OpenRouter-style chat completions; `responder(body) -> text`."""
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        text = responder(body)
        return httpx.Response(200, json={"choices": [{"message": {"content": text}}],
                                         "usage": {"prompt_tokens": 100, "completion_tokens": 50}})
    return httpx.MockTransport(handler), calls
