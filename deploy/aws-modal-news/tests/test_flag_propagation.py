"""NEWS_BATCH_SCORING is read by tick, news_ingest and news_aggregate. tick has no Secret, so a flag kept in a Secret
would reach ingest/aggregate but not tick (ingest would stop scoring while tick never queues the batch slots).
Offline source checks only: they say nothing about how the deployed app sets environment variables."""
import ast
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "modal_app.py").read_text()


def _decorator_kwargs(fn_name):
    for node in ast.walk(ast.parse(SRC)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == fn_name:
            for d in node.decorator_list:
                if isinstance(d, ast.Call):
                    return {k.arg: ast.unparse(k.value) for k in d.keywords}
    raise AssertionError(fn_name)


def test_flag_readers_share_one_image_and_tick_has_no_secret():
    for fn in ("tick", "news_ingest", "news_aggregate"):
        assert _decorator_kwargs(fn).get("image") == "image", fn
    assert "secrets" not in _decorator_kwargs("tick")


def test_flag_is_baked_into_the_shared_image_only_when_enabled():
    assert 'image = image.env({"NEWS_BATCH_SCORING": "1"})' in SRC
    assert 'if os.environ.get("NEWS_BATCH_SCORING") == "1":' in SRC
