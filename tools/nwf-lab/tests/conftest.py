import pytest

from nwf_lab.config import LabConfig
from nwf_lab.pipeline import fetch_fixture, load_positions

TICKERS = ["AAPL", "NVDA", "MSFT"]
DAYS = 300


@pytest.fixture(scope="session")
def cfg():
    return LabConfig()


@pytest.fixture(scope="session")
def bundle(cfg):
    import pathlib

    positions = load_positions(pathlib.Path(__file__).parents[1] / "fixtures" / "sample-positions.csv")
    return fetch_fixture(TICKERS, DAYS, cfg, positions)
