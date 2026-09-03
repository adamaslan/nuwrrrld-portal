import json, yfinance as yf
t = yf.Ticker("MOO")
info = t.info
out = {"symbol": "MOO", "longName": info.get("longName"), "category": info.get("category"),
       "totalAssets": info.get("totalAssets"), "navPrice": info.get("navPrice"),
       "yield": info.get("yield"), "expenseRatio": info.get("netExpenseRatio"),
       "beta3Y": info.get("beta3Year"), "ytdReturn": info.get("ytdReturn"),
       "threeYearAvgReturn": info.get("threeYearAverageReturn"),
       "fiveYearAvgReturn": info.get("fiveYearAverageReturn")}
try:
    fd = t.funds_data
    th = fd.top_holdings
    out["top_holdings"] = [{"symbol": i, "name": r.get("Name"), "weight": float(r.get("Holding Percent", 0))}
                           for i, r in th.iterrows()]
    out["sector_weightings"] = fd.sector_weightings
    out["asset_classes"] = fd.asset_classes
except Exception as e:
    out["holdings_error"] = str(e)
print(json.dumps(out, indent=2, default=str))
