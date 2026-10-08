from decimal import Decimal as D

import pytest

from nuwrrrld.core.paper import fills, sizing, stats

RULES = dict(sizing.DEFAULT_RULES)


def test_fill_price_pays_up_on_buys_gives_up_on_sells():
    buy = fills.fill_price(D(100), "buy", D(5), D(2))        # 5 + 1 = 6 bps
    sell = fills.fill_price(D(100), "sell", D(5), D(2))
    assert buy == D("100.060000") and sell == D("99.940000")
    assert fills.fill_price(D(100), "buy_to_cover", D(5), D(2)) == buy
    assert fills.fill_price(D(100), "sell_short", D(5), D(2)) == sell


def test_next_position_open_add_reduce_flip_close():
    assert fills.next_position(D(0), D(0), D(10), D(100)) == (D(10), D(100), True)
    q, avg, reset = fills.next_position(D(10), D(100), D(10), D(110))
    assert (q, avg, reset) == (D(20), D(105), False)
    assert fills.next_position(D(20), D(105), D(-5), D(120)) == (D(15), D(105), False)       # reduce keeps cost basis
    assert fills.next_position(D(10), D(100), D(-15), D(120)) == (D(-5), D(120), True)        # flip resets
    assert fills.next_position(D(10), D(100), D(-10), D(120)) == (D(0), D(0), False)
    assert fills.next_position(D(-10), D(100), D(5), D(90)) == (D(-5), D(100), False)          # partial cover


def test_tighten_only_moves_toward_price():
    assert fills.tighten(D(90), D(92), D(10)) == D(92)       # long: raise
    assert fills.tighten(D(90), D(85), D(10)) == D(90)       # never loosen
    assert fills.tighten(D(110), D(108), D(-10)) == D(108)   # short: lower
    assert fills.tighten(D(110), D(115), D(-10)) == D(110)
    assert fills.tighten(None, D(90), D(10)) == D(90)


def test_council_sizing_risk_vs_cap():
    eq = D(100000)
    # risk $: 100000*0.01*1.0 = 1000 / stop 5 = 200 sh ($20k) -> capped at 10% = $10k = 100 sh
    assert sizing.council_target_qty(eq, 1.0, D(100), D(95), "long", RULES) == D("100.000000")
    # wide stop: 1000/20 = 50 sh < cap
    assert sizing.council_target_qty(eq, 1.0, D(100), D(80), "long", RULES) == D("50.000000")
    assert sizing.council_target_qty(eq, 0.5, D(100), D(80), "short", {**RULES}) is None
    assert sizing.council_target_qty(eq, 1.0, D(100), D(120), "short", RULES) == D("-50.000000")
    assert sizing.council_target_qty(eq, 1.0, D(100), None, "flat", RULES) == D(0)
    assert sizing.council_target_qty(eq, 1.0, D(100), None, "long", RULES) is None


def test_whole_shares_when_not_fractional():
    r = {**RULES, "fractional_shares": False}
    assert sizing.council_target_qty(D(100000), 1.0, D(100), D(83), "long", r) == D(58)


def test_member_target_clipped_to_cap():
    assert sizing.member_target_qty(D(100000), 0.5, D(100), RULES) == D("100.000000")
    assert sizing.member_target_qty(D(100000), -0.05, D(100), RULES) == D("-50.000000")


@pytest.mark.parametrize("cur,tgt,expected", [
    (0, 100, [("buy", 100, "open")]),
    (0, -100, [("sell_short", 100, "open")]),
    (50, 150, [("buy", 100, "increase")]),
    (100, 40, [("sell", 60, "reduce")]),
    (100, 0, [("sell", 100, "close")]),
    (-100, 0, [("buy_to_cover", 100, "close")]),
    (-100, -40, [("buy_to_cover", 60, "reduce")]),
    (-100, -150, [("sell_short", 50, "increase")]),
    (100, -50, [("sell", 100, "close"), ("sell_short", 50, "open")]),
    (-100, 50, [("buy_to_cover", 100, "close"), ("buy", 50, "open")]),
    (100, 100, [])])
def test_plan_orders(cur, tgt, expected):
    plans = sizing.plan_orders(D(cur), D(tgt), D(100), D(100_000), RULES)
    assert [(p.side, int(p.quantity), p.intent) for p in plans] == expected


def test_plan_orders_skips_dust_and_rebalance_band():
    assert sizing.plan_orders(D(0), D(2), D(100), D(100000), RULES) == []          # $200 < $500 min notional
    assert sizing.plan_orders(D(1000), D(1010), D(100), D(100000), RULES) == []     # $1000 / $100k = 1% < 2% band
    assert sizing.plan_orders(D(1000), D(1100), D(100), D(100000), RULES) != []     # 10%


def state(**kw):
    base = dict(status="active", equity=D(100000), cash=D(100000), positions={})
    return sizing.PortfolioState(**{**base, **kw})


def test_pretrade_rejections_in_order():
    buy = sizing.OrderPlan("buy", D(50), "open")
    assert sizing.pre_trade_check(state(), "XLE", buy, D(100), "Energy", RULES) is None
    assert "halted" in sizing.pre_trade_check(state(status="halted"), "XLE", buy, D(100), "Energy", RULES)
    assert sizing.pre_trade_check(state(status="halted"), "XLE", sizing.OrderPlan("sell", D(10), "close"), D(100), "Energy", RULES) is None
    assert "decision_date" in sizing.pre_trade_check(state(), "XLE", buy, D(100), "Energy", RULES, decision_date_ok=False)
    assert "gross" in sizing.pre_trade_check(state(), "XLE", sizing.OrderPlan("buy", D(2000), "open"), D(100), "Energy", RULES)
    assert "shorts" in sizing.pre_trade_check(state(), "XLE", sizing.OrderPlan("sell_short", D(50), "open"), D(100), "Energy", {**RULES, "allow_short": False})
    assert "cash" in sizing.pre_trade_check(state(cash=D(1000)), "XLE", buy, D(100), "Energy", RULES)
    assert "new positions" in sizing.pre_trade_check(state(new_positions_this_session=5), "XLE", buy, D(100), "Energy", RULES)


def test_pretrade_sector_cap():
    s = state(positions={"XLF": (D(250), D(100), "Financials")}, cash=D(75000))
    assert "sector" in sizing.pre_trade_check(s, "XLK", sizing.OrderPlan("buy", D(100), "open"), D(100), "Financials", RULES)
    assert sizing.pre_trade_check(s, "XLE", sizing.OrderPlan("buy", D(50), "open"), D(100), "Energy", RULES) is None


def test_equity_stats():
    s = stats.equity_stats([100, 110, 99, 120])
    assert round(s["total_return"], 4) == 0.2 and s["max_drawdown"] == pytest.approx(-0.1)
    assert stats.equity_stats([100]) == {"sessions": 1}
    assert stats.equity_stats([100, 110], [100, 105])["excess_return"] == pytest.approx(0.05)


def test_trade_stats_round_trips():
    fl = [{"ticker": "A", "side": "buy", "quantity": D(10), "fill_price": D(100)},
          {"ticker": "A", "side": "sell", "quantity": D(10), "fill_price": D(110)},
          {"ticker": "B", "side": "sell_short", "quantity": D(10), "fill_price": D(50)},
          {"ticker": "B", "side": "buy_to_cover", "quantity": D(10), "fill_price": D(55)}]
    s = stats.trade_stats(fl, 100000)
    assert s["closed_trades"] == 2 and s["hit_rate"] == 0.5 and s["avg_win"] == 100 and s["avg_loss"] == -50
