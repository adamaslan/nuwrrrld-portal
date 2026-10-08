"""analyze() must agree with homebase/locrun.py:analyze() on the same bars."""
import importlib.util
import pathlib
from types import SimpleNamespace

import pytest

from nwf_lab.features.analyze import analyze_symbol

LOCRUN = pathlib.Path.home() / "code" / "homebase" / "locrun.py"


@pytest.mark.skipif(not LOCRUN.exists(), reason="homebase/locrun.py not present")
def test_analyze_matches_locrun(bundle, cfg):
    spec = importlib.util.spec_from_file_location("locrun_under_test", LOCRUN)
    locrun = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(locrun)

    sym = "AAPL"
    df = bundle.bars[sym]
    price, prev = float(df["close"].iloc[-1]), float(df["close"].iloc[-2])

    class FakeTicker:
        def __init__(self, _):
            self.fast_info = SimpleNamespace(last_price=price, previous_close=prev)
            self.info = {}

        def history(self, period="3mo"):
            return df.rename(columns=str.capitalize)

    locrun.yf.Ticker = FakeTicker
    expected = locrun.analyze(sym)
    got, _ = analyze_symbol(sym, df, {"price": price, "prev_close": prev}, cfg)

    for key in ("direction", "confidence", "ai_score", "ai_action", "price", "change_pct"):
        assert got[key] == expected[key], key
    assert got["indicators_raw"] == expected["indicators_raw"]
