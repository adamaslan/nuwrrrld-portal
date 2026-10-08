import pytest

from nuwrrrld.core import portfolio_metrics, scoring
from nuwrrrld.llm import validate


def cands(n_pos, n_neg):
    out = [{"ticker": f"P{i:02d}", "strength": 0.9 - i * 0.01, "dominant_strength": 0.5, "adx": 20} for i in range(n_pos)]
    out += [{"ticker": f"N{i:02d}", "strength": -(0.9 - i * 0.01), "dominant_strength": 0.5, "adx": 20} for i in range(n_neg)]
    return out


def test_select_top_ten_each_side_no_overlap():
    sel = scoring.select_calls(cands(15, 15))
    assert [c["ticker"] for c in sel["bull"]][:2] == ["P00", "P01"] and len(sel["bull"]) == 10 and len(sel["bear"]) == 10
    assert not {c["ticker"] for c in sel["bull"]} & {c["ticker"] for c in sel["bear"]}


def test_never_pads_with_weak_calls():
    sel = scoring.select_calls(cands(4, 0) + [{"ticker": "Z", "strength": 0.0, "dominant_strength": 0, "adx": 0}])
    assert len(sel["bull"]) == 4 and sel["bear"] == []


def test_tie_break_dominant_then_adx_then_ticker():
    tied = [{"ticker": "B", "strength": 0.5, "dominant_strength": 0.4, "adx": 30},
            {"ticker": "A", "strength": 0.5, "dominant_strength": 0.4, "adx": 30},
            {"ticker": "C", "strength": 0.5, "dominant_strength": 0.6, "adx": 10},
            {"ticker": "D", "strength": 0.5, "dominant_strength": 0.4, "adx": 40}]
    assert [c["ticker"] for c in scoring.select_calls(tied)["bull"]] == ["C", "D", "A", "B"]


def test_reasoning_hash_is_tamper_evident():
    a = scoring.reasoning_sha256("text", [{"x": 1}])
    assert a == scoring.reasoning_sha256("text", [{"x": 1}]) and a != scoring.reasoning_sha256("text!", [{"x": 1}])


def test_horizons_are_trading_sessions():
    assert scoring.HORIZONS == {"1w": 5, "2w": 10, "1m": 21, "2m": 42, "3m": 63, "6m": 126, "12m": 252}


def test_score_bull_and_bear_sign_flip():
    bull = scoring.score_horizon("bull", 100, [102, 105, 110], 100, 104, None)
    bear = scoring.score_horizon("bear", 100, [102, 105, 110], 100, 104, None)
    assert bull.directional_return == pytest.approx(0.10) and bull.hit and bull.excess_return == pytest.approx(0.06)
    assert bear.directional_return == pytest.approx(-0.10) and bear.hit is False
    assert bear.max_adverse_excursion == pytest.approx(-0.10)


def test_invalidation_detected_even_if_recovered():
    s = scoring.score_horizon("bull", 100, [95, 99, 108], None, None, invalidation=96)
    assert s.invalidated_before_target is True and s.hit is True
    assert scoring.score_horizon("bear", 100, [103, 99], None, None, invalidation=102).invalidated_before_target is True


def test_no_data_voids():
    s = scoring.score_horizon("bull", 100, [], None, None, None)
    assert s.status == "void" and s.void_reason


SRC = {"ticker": "XLE", "strength": 0.425, "fired_indicators": [{"reading": 28.4, "threshold": 30}]}


def test_numeric_check_accepts_input_numbers_and_whitelist():
    ok, bad = validate.numeric_check("RSI read 28.4, under the 30 line, on a 14 session basis; strength 0.425.", SRC)
    assert ok and bad == []


def test_numeric_check_catches_invented_numbers():
    ok, bad = validate.numeric_check("RSI read 28.4 and the price target is 87.5.", SRC)
    assert not ok and bad == [87.5]


def test_numeric_check_rounding_and_percent():
    assert validate.numeric_check("strength about 0.43", SRC)[0]
    assert validate.numeric_check("up 42.5%", {"v": 0.425})[0]
    assert not validate.numeric_check("up 55%", {"v": 0.425})[0]


def test_directive_filter_rewrites_and_appends_disclaimer():
    out = validate.directive_filter("You should buy XLE now.")
    assert "should buy" not in out.lower() and "Educational only" in out
    assert validate.directive_filter("Descriptive text.").count("Educational only") == 1
    assert validate.directive_filter("We recommend selling.").lower().find("recommend") == -1


def test_template_is_deterministic_and_directive_free():
    sig = {"ticker": "XLE", "direction": "bullish", "strength": 0.425, "timeframe": "swing", "horizon_days": 21,
           "fired_indicators": [{"indicator": "rsi_14", "reading": 28.4, "rule": "rsi_oversold"}]}
    assert validate.template_explanation(sig) == validate.template_explanation(sig)
    assert validate.numeric_check(validate.template_explanation(sig), sig)[0]


def test_holdings_hash_stable_and_order_independent():
    a = [{"ticker": "A", "quantity": 1}, {"ticker": "B", "quantity": 2}]
    assert portfolio_metrics.holdings_hash(a) == portfolio_metrics.holdings_hash(list(reversed(a)))
    assert portfolio_metrics.holdings_hash(a) != portfolio_metrics.holdings_hash([{"ticker": "A", "quantity": 2}, {"ticker": "B", "quantity": 2}])


def test_portfolio_metrics_and_findings():
    pos = [{"ticker": "XLE", "quantity": 90, "close": 100, "sector": "Energy", "beta": 1.5, "vol_63": 0.2, "signal_direction": "bearish", "verdict": "fold"},
           {"ticker": "XLK", "quantity": 10, "close": 100, "sector": "Tech", "beta": 1.0, "vol_63": 0.1, "signal_direction": "bullish", "verdict": "hold"},
           {"ticker": "ZZZ", "quantity": 1, "close": 100, "sector": None, "beta": None}]
    m = portfolio_metrics.compute_metrics(pos)
    assert m["weights"]["XLE"] == pytest.approx(9000 / 10100, abs=1e-5) and m["unmapped"] == ["ZZZ"] and m["fold_count"] == 1
    codes = {f["code"] for f in portfolio_metrics.findings(m)}
    assert {"CONCENTRATION_HIGH", "SECTOR_OVERWEIGHT", "BEARISH_OVERLAP"} <= codes
    assert portfolio_metrics.findings({"weights": {}}) == []
