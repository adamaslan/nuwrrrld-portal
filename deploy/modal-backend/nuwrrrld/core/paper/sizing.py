"""Position sizing, order planning and pre-trade checks (Section 11.2). Pure functions."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal

DEFAULT_RULES: dict = {
    "starting_cash": 100000, "allow_short": True, "max_gross_exposure": 1.0, "max_net_exposure": 1.0,
    "max_position_weight": 0.10, "max_sector_weight": 0.30, "risk_per_trade": 0.01, "min_trade_notional": 500,
    "slippage_bps": 5, "spread_bps_fallback": 2, "commission_per_order": 0, "fill_mode": "next_open",
    "stop_check": "close", "drawdown_halt": 0.25, "max_new_positions_per_session": 5, "rebalance_band": 0.02,
    "order_expiry_sessions": 1, "fractional_shares": True,
}
QTY_QUANT = Decimal("0.000001")
EXIT_INTENTS = ("reduce", "close", "stop_exit")


@dataclass(frozen=True)
class OrderPlan:
    side: str          # buy | sell | sell_short | buy_to_cover
    quantity: Decimal
    intent: str        # open | increase | reduce | close | stop_exit | rebalance


def _floor_shares(qty: Decimal, fractional: bool) -> Decimal:
    return qty.quantize(QTY_QUANT, rounding=ROUND_DOWN) if fractional else qty.to_integral_value(rounding=ROUND_DOWN)


def council_target_qty(equity: Decimal, conviction: float, reference: Decimal, invalidation: Decimal | None,
                       direction: str, rules: dict) -> Decimal | None:
    """Signed target quantity for a long/short/flat consensus. None = leave the position unchanged."""
    if direction == "flat":
        return Decimal(0)
    if invalidation is None or reference <= 0:
        return None
    stop_distance = abs(reference - invalidation)
    if stop_distance == 0:
        return None
    risk_dollars = equity * Decimal(str(rules["risk_per_trade"])) * Decimal(str(conviction))
    qty_risk = risk_dollars / stop_distance
    qty_cap = equity * Decimal(str(rules["max_position_weight"])) / reference
    qty = _floor_shares(min(qty_risk, qty_cap), rules["fractional_shares"])
    return qty if direction == "long" else -qty


def member_target_qty(equity: Decimal, target_weight: float, reference: Decimal, rules: dict) -> Decimal:
    cap = Decimal(str(rules["max_position_weight"]))
    weight = max(-cap, min(cap, Decimal(str(target_weight))))
    return _floor_shares(abs(weight) * equity / reference, rules["fractional_shares"]) * (1 if weight >= 0 else -1)


def plan_orders(current_qty: Decimal, target_qty: Decimal, price: Decimal, equity: Decimal, rules: dict) -> list[OrderPlan]:
    """Turn a target into orders; a long<->short flip becomes `close` then `open`."""
    delta = target_qty - current_qty
    if delta == 0:
        return []
    min_notional = Decimal(str(rules["min_trade_notional"]))
    band = Decimal(str(rules["rebalance_band"]))
    if abs(delta * price) < min_notional and target_qty != 0:
        return []
    if current_qty != 0 and target_qty != 0 and equity > 0 and (current_qty > 0) == (target_qty > 0):
        if abs(delta * price) / equity < band:
            return []
    plans: list[OrderPlan] = []
    if current_qty != 0 and (target_qty == 0 or (current_qty > 0) != (target_qty > 0)):
        plans.append(OrderPlan("sell" if current_qty > 0 else "buy_to_cover", abs(current_qty), "close"))
        remaining = target_qty
        if remaining != 0 and abs(remaining * price) >= min_notional:
            plans.append(OrderPlan("buy" if remaining > 0 else "sell_short", abs(remaining), "open"))
        return plans
    if current_qty == 0:
        return [OrderPlan("buy" if delta > 0 else "sell_short", abs(delta), "open")]
    same_dir_grow = abs(target_qty) > abs(current_qty)
    if current_qty > 0:
        return [OrderPlan("buy", delta, "increase")] if same_dir_grow else [OrderPlan("sell", abs(delta), "reduce")]
    return [OrderPlan("sell_short", abs(delta), "increase")] if same_dir_grow else [OrderPlan("buy_to_cover", abs(delta), "reduce")]


@dataclass(frozen=True)
class PortfolioState:
    status: str
    equity: Decimal
    cash: Decimal
    positions: dict[str, tuple[Decimal, Decimal, str | None]]   # ticker -> (qty, price, sector)
    new_positions_this_session: int = 0


def pre_trade_check(state: PortfolioState, ticker: str, plan: OrderPlan, price: Decimal, sector: str | None,
                    rules: dict, decision_date_ok: bool = True) -> str | None:
    """Return a rejection reason, or None when the order passes. Checks run in spec order."""
    if state.status != "active" and plan.intent not in EXIT_INTENTS:
        return f"portfolio {state.status}: only exits allowed"
    if not decision_date_ok:
        return "decision_date is not the latest final bar date"
    is_exit = plan.intent in EXIT_INTENTS
    signed = plan.quantity if plan.side in ("buy", "buy_to_cover") else -plan.quantity
    new_pos = {t: q for t, (q, _, _) in state.positions.items()}
    new_pos[ticker] = new_pos.get(ticker, Decimal(0)) + signed
    prices = {t: p for t, (_, p, _) in state.positions.items()}
    prices[ticker] = price
    gross = sum(abs(q) * prices[t] for t, q in new_pos.items())
    net = sum(q * prices[t] for t, q in new_pos.items())
    equity = state.equity
    if not is_exit and equity > 0:
        if gross / equity > Decimal(str(rules["max_gross_exposure"])):
            return "gross exposure limit"
        if abs(net) / equity > Decimal(str(rules["max_net_exposure"])):
            return "net exposure limit"
        if sector:
            sector_value = sum(abs(q) * prices[t] for t, q in new_pos.items()
                               if (state.positions.get(t, (0, 0, None))[2] if t != ticker else sector) == sector)
            if sector_value / equity > Decimal(str(rules["max_sector_weight"])):
                return "sector weight limit"
        if plan.intent == "open" and state.new_positions_this_session >= rules["max_new_positions_per_session"]:
            return "new positions per session limit"
    if plan.side == "sell_short" and not rules["allow_short"]:
        return "shorts disabled"
    if plan.side in ("buy", "buy_to_cover") and state.cash - plan.quantity * price < 0:
        return "insufficient cash"
    return None
