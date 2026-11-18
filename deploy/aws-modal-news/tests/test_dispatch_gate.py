"""The dispatcher gate accepts only the explicit enabled value."""

import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "modal_app.py"
SPEC = importlib.util.spec_from_file_location("nwf5_modal_app", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_dispatcher_requires_exact_enabled_value():
    assert MODULE._dispatcher_enabled(None) is False
    assert MODULE._dispatcher_enabled("") is False
    assert MODULE._dispatcher_enabled("true") is False
    assert MODULE._dispatcher_enabled("1") is True
