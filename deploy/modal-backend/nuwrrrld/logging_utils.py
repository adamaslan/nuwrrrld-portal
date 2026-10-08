"""Structured JSON logging (Section 18): one JSON object per line on stdout."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import time

_RESERVED = {"job", "run_key", "request_id", "user_hash", "session_id", "latency_ms"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + "Z",
            "level": record.levelname,
            "fn": os.environ.get("MODAL_FUNCTION_NAME", record.name),
            "msg": record.getMessage(),
        }
        payload.update({k: getattr(record, k) for k in _RESERVED if hasattr(record, k)})
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)[-2000:]
        return json.dumps(payload, default=str)


def configure(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if any(isinstance(h.formatter, JsonFormatter) for h in root.handlers):
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.handlers[:] = [handler]
    root.setLevel(level)


def user_hash(user_id: object) -> str:
    return hashlib.sha256(str(user_id).encode()).hexdigest()[:12]
