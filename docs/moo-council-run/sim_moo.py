"""Real investment simulation for MOO + hit-rate backtest of the fired signal."""
import json
import numpy as np, pandas as pd, yfinance as yf

CAPITAL = 10_000.0
df = yf.Ticker("MOO").history(period="10y", auto_adjust=True)
px = df["Close"].dropna()
vol = df["Volume"].dropna()

def cagr(s):
    yrs = (s.index[-1] - s.index[0]).days / 365.25
    return (s.iloc[-1] / s.iloc[0]) ** (1 / yrs) - 1

def lump(years):
    s = px[px.index >= px.index[-1] - pd.Timedelta(days=int(365.25 * years))]
    if len(s) < 20: return None
    shares = CAPITAL / s.iloc[0]
    eq = shares * s
    dd = (eq / eq.cummax() - 1).min()
    r = eq.pct_change().dropna()
    return {"years": years, "start": round(float(s.iloc[0]), 2), "end": round(float(s.iloc[-1]), 2),
            "final_value": round(float(eq.iloc[-1]), 2),
            "total_return_pct": round(float(eq.iloc[-1] / CAPITAL - 1) * 100, 2),
            "cagr_pct": round(float(cagr(s)) * 100, 2),
            "max_drawdown_pct": round(float(dd) * 100, 2),
            "ann_vol_pct": round(float(r.std() * np.sqrt(252)) * 100, 2),
            "sharpe_rf0": round(float(r.mean() / r.std() * np.sqrt(252)), 2)}

def dca(years, monthly=250.0):
    s = px[px.index >= px.index[-1] - pd.Timedelta(days=int(365.25 * years))]
    buys = s.resample("MS").first().dropna()
    shares = (monthly / buys).sum(); invested = monthly * len(buys)
    val = shares * float(s.iloc[-1])
    return {"years": years, "monthly": monthly, "months": int(len(buys)),
            "invested": round(invested, 2), "final_value": round(float(val), 2),
            "total_return_pct": round((val / invested - 1) * 100, 2)}

# --- signal replay: the exact conditions the scan fired today ---
d = pd.DataFrame({"c": px, "v": vol})
delta = d.c.diff()
g = delta.clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
l = (-delta.clip(upper=0)).ewm(alpha=1/14, adjust=False).mean()
d["rsi"] = 100 - 100 / (1 + g / l)
e12, e26 = d.c.ewm(span=12, adjust=False).mean(), d.c.ewm(span=26, adjust=False).mean()
d["mh"] = (e12 - e26) - (e12 - e26).ewm(span=9, adjust=False).mean()
d["sma20"] = d.c.rolling(20).mean()
d["volr"] = d.v / d.v.rolling(20).mean()
d["above"] = d.c / d.sma20 - 1

fired = (d.rsi > 70) & (d.mh > 0) & (d.volr > 1.5) & (d.above > 0.03)
out = {}
for h in (5, 20, 60):
    fwd = d.c.shift(-h) / d.c - 1
    sel = fwd[fired].dropna()
    base = fwd.dropna()
    out[f"{h}d"] = {"n": int(len(sel)),
                    "hit_rate_pct": round(float((sel > 0).mean()) * 100, 1) if len(sel) else None,
                    "mean_fwd_pct": round(float(sel.mean()) * 100, 2) if len(sel) else None,
                    "median_fwd_pct": round(float(sel.median()) * 100, 2) if len(sel) else None,
                    "worst_fwd_pct": round(float(sel.min()) * 100, 2) if len(sel) else None,
                    "best_fwd_pct": round(float(sel.max()) * 100, 2) if len(sel) else None,
                    "baseline_hit_rate_pct": round(float((base > 0).mean()) * 100, 1),
                    "baseline_mean_pct": round(float(base.mean()) * 100, 2)}

res = {"ticker": "MOO", "history_start": str(px.index[0].date()), "history_end": str(px.index[-1].date()),
       "last_close": round(float(px.iloc[-1]), 2),
       "lump_sum_10k": [x for x in (lump(y) for y in (1, 3, 5, 10)) if x],
       "dca_250_monthly": [dca(y) for y in (3, 5, 10)],
       "signal_backtest": {"rule": "RSI>70 AND MACD_hist>0 AND vol>1.5x AND price>3% over SMA20",
                           "total_fires": int(fired.sum()), "forward_returns": out},
       "current_state": {"rsi": round(float(d.rsi.iloc[-1]), 1), "macd_hist": round(float(d.mh.iloc[-1]), 3),
                         "vol_ratio": round(float(d.volr.iloc[-1]), 2),
                         "pct_above_sma20": round(float(d.above.iloc[-1]) * 100, 2),
                         "signal_fired_today": bool(fired.iloc[-1])}}
json.dump(res, open("moo_sim.json", "w"), indent=2)
print(json.dumps(res, indent=2))
