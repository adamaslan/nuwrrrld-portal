import datetime as dt
import time
from decimal import Decimal as D

import httpx
import jwt
import pytest
import respx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from nuwrrrld.api import auth
from nuwrrrld.providers import alpaca, daily_bars_with_fallback
from nuwrrrld.providers.base import ProviderError, RateLimited, from_alpaca_symbol, to_alpaca_symbol
from tests.fakes import FakeProvider, bar

# --- Alpaca adapter ---------------------------------------------------------------------------------------------------
def provider(**kw):
    return alpaca.AlpacaProvider("kid", "sec", client=httpx.Client(base_url=alpaca.DATA_URL), **kw)


def bars_payload(sym, n=2, token=None):
    return {"bars": {sym: [{"t": f"2026-10-0{i + 5}T04:00:00Z", "o": 100 + i, "h": 102 + i, "l": 99 + i, "c": 101 + i, "v": 1000, "vw": 100.5}
                            for i in range(n)]}, "next_page_token": token}


def test_symbol_normalization_round_trip():
    assert to_alpaca_symbol("BRK-B") == "BRK.B" and from_alpaca_symbol("BRK.B") == "BRK-B"


@respx.mock
def test_daily_bars_paginates_normalizes_and_sends_auth_and_params():
    route = respx.get(f"{alpaca.DATA_URL}/v2/stocks/bars").mock(side_effect=[
        httpx.Response(200, json=bars_payload("BRK.B", token="tok")), httpx.Response(200, json=bars_payload("BRK.B", 1))])
    out = provider().daily_bars(["BRK-B"], dt.date(2026, 10, 5), dt.date(2026, 10, 6))
    assert len(out) == 3 and {b.ticker for b in out} == {"BRK-B"}
    first = route.calls[0].request
    assert first.url.params["symbols"] == "BRK.B" and first.url.params["adjustment"] == "split" and first.url.params["feed"] == "sip"
    assert first.headers["APCA-API-KEY-ID"] == "kid" and first.headers["APCA-API-SECRET-KEY"] == "sec"
    assert route.calls[1].request.url.params["page_token"] == "tok"
    assert out[0].bar_date == dt.date(2026, 10, 5) and out[0].provider == "alpaca" and out[0].feed == "sip"       # 04:00Z -> ET session date
    assert isinstance(out[0].close, D)


@respx.mock
def test_batches_150_symbols_per_request():
    route = respx.get(f"{alpaca.DATA_URL}/v2/stocks/bars").mock(return_value=httpx.Response(200, json={"bars": {}}))
    provider().daily_bars([f"T{i}" for i in range(320)], dt.date(2026, 10, 5), dt.date(2026, 10, 6))
    assert route.call_count == 3


@respx.mock
def test_retries_5xx_then_succeeds(monkeypatch):
    monkeypatch.setattr("tenacity.nap.time.sleep", lambda s: None)
    respx.get(f"{alpaca.DATA_URL}/v2/stocks/bars").mock(side_effect=[httpx.Response(503), httpx.Response(200, json=bars_payload("SPY"))])
    assert len(provider().daily_bars(["SPY"], dt.date(2026, 10, 5), dt.date(2026, 10, 6))) == 2


@respx.mock
def test_rate_limit_exhausts_retries_and_4xx_is_not_retried(monkeypatch):
    monkeypatch.setattr("tenacity.nap.time.sleep", lambda s: None)
    r = respx.get(f"{alpaca.DATA_URL}/v2/stocks/bars").mock(return_value=httpx.Response(429, headers={"Retry-After": "2"}))
    with pytest.raises(RateLimited):
        provider().daily_bars(["SPY"], dt.date(2026, 10, 5), dt.date(2026, 10, 6))
    assert r.call_count == 4
    before = r.call_count                                  # respx returns the same Route for an identical pattern
    r.mock(return_value=httpx.Response(403, text="forbidden"))
    with pytest.raises(ProviderError):
        provider().daily_bars(["SPY"], dt.date(2026, 10, 5), dt.date(2026, 10, 6))
    assert r.call_count - before == 1                      # a 4xx is not retried


@respx.mock
def test_every_request_takes_a_shared_budget_token():
    respx.get(f"{alpaca.DATA_URL}/v2/stocks/bars").mock(return_value=httpx.Response(200, json=bars_payload("SPY")))
    taken = []
    provider(take_tokens=taken.append).daily_bars(["SPY"], dt.date(2026, 10, 5), dt.date(2026, 10, 6))
    assert taken == [1]


@respx.mock
def test_spread_and_corporate_actions_and_healthcheck():
    respx.get(f"{alpaca.DATA_URL}/v2/stocks/snapshots").mock(return_value=httpx.Response(200, json={"SPY": {"latestQuote": {"ap": 100.1, "bp": 99.9}}}))
    assert provider().spread_bps("SPY") == D("20.000")
    respx.get(f"{alpaca.DATA_URL}/v2/stocks/snapshots").mock(return_value=httpx.Response(200, json={"SPY": {"latestQuote": {"ap": 0, "bp": 0}}}))
    assert provider().spread_bps("SPY") is None
    respx.get(f"{alpaca.DATA_URL}/v1/corporate-actions").mock(return_value=httpx.Response(200, json={"corporate_actions": {
        "forward_splits": [{"symbol": "XLE", "ex_date": "2026-10-05", "new_rate": 2, "old_rate": 1}],
        "cash_dividends": [{"symbol": "XLE", "ex_date": "2026-10-06", "rate": 0.5}]}}))
    acts = provider().corporate_actions(["XLE"], dt.date(2026, 10, 1), dt.date(2026, 10, 7))
    assert [(a.kind, a.ratio, a.amount) for a in acts] == [("split", D(2), None), ("dividend", None, D("0.5"))]
    respx.get(f"{alpaca.DATA_URL}/v2/stocks/bars").mock(return_value=httpx.Response(200, json=bars_payload("SPY")))
    assert provider().healthcheck() is True


@respx.mock
def test_session_open_raises_data_not_ready_when_no_bar():
    from nuwrrrld.providers.base import DataNotReady
    respx.get(f"{alpaca.DATA_URL}/v2/stocks/bars").mock(return_value=httpx.Response(200, json={"bars": {}}))
    with pytest.raises(DataNotReady):
        provider().session_open(["SPY"], dt.date(2026, 10, 7))


def test_refuses_live_trading_host(monkeypatch):
    monkeypatch.setenv("ALPACA_BASE_URL", "https://api.alpaca.markets")
    with pytest.raises(ProviderError):
        provider()


@respx.mock
def test_latest_prices_for_live_poller():
    respx.get(f"{alpaca.DATA_URL}/v2/stocks/snapshots").mock(return_value=httpx.Response(200, json={
        "XLE": {"latestTrade": {"p": 101.25, "t": "2026-10-07T14:00:00Z"}, "latestQuote": {"bp": 101.2, "ap": 101.3}}}))
    out = alpaca.latest_prices(provider(), ["XLE"])
    assert out["XLE"]["price"] == D("101.250000") and out["XLE"]["feed"] == "iex" and out["XLE"]["source"] == "alpaca"


# --- fallback chain ----------------------------------------------------------------------------------------------------
D0 = dt.date(2026, 10, 6)


def test_fallback_fetches_only_missing_tickers_and_logs(caplog):
    primary = FakeProvider([bar("XLE", D0, 100)])
    fb = FakeProvider([bar("XLK", D0, 50, "yf"), bar("XLE", D0, 999, "yf")])
    fb.name = "other"
    with caplog.at_level("WARNING"):
        bars, missing = daily_bars_with_fallback(primary, ["XLE", "XLK"], D0, D0, fb)
    assert missing == [] and {(b.ticker, b.provider) for b in bars} == {("XLE", "fake"), ("XLK", "yf")}    # XLE stays on the primary
    assert any("falling back" in r.message and "XLK" in r.message for r in caplog.records)


def test_yfinance_is_skipped_on_datacenter_hosts_failing_closed(monkeypatch):
    monkeypatch.setenv("MODAL_TASK_ID", "ta-123")
    from nuwrrrld.providers.yfinance_fallback import YFinanceProvider
    primary = FakeProvider([])
    bars, missing = daily_bars_with_fallback(primary, ["XLE"], D0, D0, YFinanceProvider())
    assert bars == [] and missing == ["XLE"]
    with pytest.raises(ProviderError):
        YFinanceProvider.from_env()


# --- Clerk JWT -----------------------------------------------------------------------------------------------------------
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PRIV = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
OTHER_PRIV = OTHER.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
PUB = KEY.public_key()
ISS = "https://clerk.example.test"


@pytest.fixture(autouse=True)
def clerk_env(monkeypatch):
    monkeypatch.setenv("CLERK_ISSUER", ISS)
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://financial.nuwrrrld.com")


def token(priv=PRIV, alg="RS256", **over):
    now = int(time.time())
    claims = {"sub": "user_1", "sid": "sess_1", "iss": ISS, "iat": now, "exp": now + 60, "azp": "https://financial.nuwrrrld.com", **over}
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, priv, algorithm=alg)


def test_valid_token_accepted():
    u = auth.verify_clerk_token(token(), key=PUB)
    assert u.clerk_user_id == "user_1" and u.session_id == "sess_1"


@pytest.mark.parametrize("tok", [
    lambda: token(exp=int(time.time()) - 3600, iat=int(time.time()) - 7200),   # expired
    lambda: token(iss="https://evil.example"),                                    # wrong issuer
    lambda: token(azp="https://evil.example"),                                    # wrong authorized party
    lambda: token(priv=OTHER_PRIV),                                               # signed by another key / unknown kid
    lambda: token(sub=None),                                                      # required claim missing
    lambda: "not.a.jwt",
])
def test_bad_tokens_rejected(tok):
    with pytest.raises(HTTPException) as e:
        auth.verify_clerk_token(tok(), key=PUB)
    assert e.value.status_code == 401


def test_alg_none_and_hs256_confusion_rejected():
    now = int(time.time())
    claims = {"sub": "user_1", "iss": ISS, "iat": now, "exp": now + 60}
    none_tok = jwt.encode(claims, key=None, algorithm="none")
    pub_pem = PUB.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    hs_tok = jwt.encode(claims, pub_pem, algorithm="HS256") if False else jwt.encode(claims, "x" * 32, algorithm="HS256")
    for t in (none_tok, hs_tok):
        with pytest.raises(HTTPException):
            auth.verify_clerk_token(t, key=PUB)


def test_azp_absent_is_allowed():
    assert auth.verify_clerk_token(token(azp=None), key=PUB).clerk_user_id == "user_1"
