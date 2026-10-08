import pytest

from nwf_lab.errors import LabError
from nwf_lab.saved_lists import MAX_SAVED_LISTS, SavedListStore, clean_tickers, normalize_name


@pytest.fixture
def store(tmp_path):
    return SavedListStore(tmp_path / "lists")


def test_save_then_load_roundtrip_dedupes_and_uppercases(store):
    saved = store.save("  Tech   picks ", ["aapl", "MSFT", "AAPL", "brk-b"])
    assert saved.name == "Tech picks"
    assert store.load("tech PICKS").tickers == ("AAPL", "MSFT", "BRK.B")


def test_same_name_any_case_overwrites(store):
    store.save("Core", ["AAPL"])
    store.save("core", ["NVDA"])
    assert store.names() == ["core"]
    assert store.load("CORE").tickers == ("NVDA",)


@pytest.mark.parametrize("bad", ["", "   ", "x" * 41, "<script>", "=HYPERLINK(1)", "-rf", "a\nb"])
def test_bad_names_rejected(bad):
    with pytest.raises(LabError):
        normalize_name(bad)


def test_junk_tickers_are_dropped_and_empty_list_rejected(store):
    assert clean_tickers(["=CMD|' /C calc'!A0", "<b>", "AAPL", ""]) == ("AAPL",)
    with pytest.raises(LabError):
        store.save("Empty", ["<b>", ""])


def test_cap_blocks_new_names_but_not_overwrites(store):
    for i in range(MAX_SAVED_LISTS):
        store.save(f"list {i}", ["AAPL"])
    with pytest.raises(LabError):
        store.save("one too many", ["AAPL"])
    store.save("list 0", ["MSFT"])
    assert len(store.names()) == MAX_SAVED_LISTS


def test_delete_and_missing(store):
    store.save("Gone", ["AAPL"])
    assert store.delete("gone") is True
    assert store.delete("gone") is False
    assert store.load("gone") is None


def test_corrupt_file_is_skipped(store):
    store.save("Ok", ["AAPL"])
    (store._dir / "junk.json").write_text("{not json")
    assert store.names() == ["Ok"]


def test_app_picks_the_tickers_csv_stem():
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / "app.py").read_text()
    start = text.index("def tickers_file_stem")
    ns: dict = {"Path": Path}
    exec(text[start:text.index("def saved_list_controls")], ns)  # noqa: S102 - our own source

    class F:
        def __init__(self, name):
            self.name = name

    files = [F("positions.csv"), F("my_tech.csv")]
    notes = ["positions.csv: 3 portfolio positions", "my_tech.csv: 12 tickers"]
    assert ns["tickers_file_stem"](files, notes) == "my_tech"
    assert ns["tickers_file_stem"](files[:1], notes[:1]) == ""
