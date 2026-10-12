"""CI installs from requirements.txt; Modal builds from py_image.pip_install(...). Keep them identical."""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _modal_image_requirements() -> set[str]:
    tree = ast.parse((ROOT / "modal_app.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "pip_install":
            return {arg.value for arg in node.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str)}
    raise AssertionError("no .pip_install(...) call found in modal_app.py")


def _requirements_txt() -> set[str]:
    lines = (ROOT / "requirements.txt").read_text().splitlines()
    return {line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")}


def test_requirements_txt_matches_modal_image():
    assert _requirements_txt() == _modal_image_requirements()
