import json, sys
sys.path.insert(0, "/Users/adamaslan/code/homebase")
from locrun import analyze

TICKERS = ["MOO","CTVA","DE","NTR","ZTS","ADM","CF","TSN","BG"]
WEIGHTS = {"MOO":None,"CTVA":8.92,"DE":7.96,"NTR":6.57,"ZTS":5.22,"ADM":5.07,"CF":4.81,"TSN":4.37,"BG":3.14}
res = []
for t in TICKERS:
    r = analyze(t, period="6mo")
    if r:
        r["etf_weight_pct"] = WEIGHTS.get(t)
        res.append(r)
json.dump(res, open("moo_scan.json","w"), indent=2, default=str)
print(json.dumps(res[0], indent=2, default=str))
