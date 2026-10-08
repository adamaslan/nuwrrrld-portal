"""Job idempotency guard (Section 16.2). conn MUST be autocommit so claims/heartbeats are visible at once."""
from __future__ import annotations

import contextlib
import datetime as dt
import json
import traceback

from nuwrrrld import dynamo
from nuwrrrld.calendar import ET


class JobContext:
    def __init__(self, conn, job_name: str, run_key: str):
        self.conn, self.job_name, self.run_key = conn, job_name, run_key
        self.final_status, self.detail = "succeeded", {}

    def heartbeat(self) -> None:
        self.conn.execute("UPDATE job_runs SET heartbeat_at = now() WHERE job_name=%s AND run_key=%s",
                          (self.job_name, self.run_key))

    def skip(self, reason: str) -> None:
        self.final_status, self.detail["skip_reason"] = "skipped", reason


@contextlib.contextmanager
def run_job(conn, job_name: str, run_key: str | None = None, *, stale_after_min: int = 30, force: bool = False):
    """Claim (job_name, run_key) once.

    succeeded/skipped          -> yield None (caller returns)   [unless force]
    running + fresh heartbeat  -> yield None (another container owns it)
    failed / stale running     -> take over, attempt += 1
    """
    run_key = run_key or dt.datetime.now(ET).date().isoformat()
    if force:
        conn.execute("DELETE FROM job_runs WHERE job_name=%s AND run_key=%s", (job_name, run_key))
    row = conn.execute(
        """INSERT INTO job_runs (job_name, run_key, status) VALUES (%s, %s, 'running')
           ON CONFLICT (job_name, run_key) DO UPDATE
             SET status='running', attempt=job_runs.attempt+1, started_at=now(),
                 heartbeat_at=now(), error=NULL, finished_at=NULL
             WHERE job_runs.status = 'failed'
                OR (job_runs.status = 'running'
                    AND job_runs.heartbeat_at < now() - make_interval(mins => %s))
           RETURNING attempt""",
        (job_name, run_key, stale_after_min)).fetchone()
    if row is None:
        yield None
        return
    ctx = JobContext(conn, job_name, run_key)
    try:
        yield ctx
        done = conn.execute(
            "UPDATE job_runs SET status=%s, finished_at=now(), detail=%s WHERE job_name=%s AND run_key=%s RETURNING *",
            (ctx.final_status, json.dumps(ctx.detail), job_name, run_key)).fetchone()
        dynamo.mirror_rows("job_runs", [done])
    except Exception:
        failed = conn.execute(
            "UPDATE job_runs SET status='failed', finished_at=now(), error=%s WHERE job_name=%s AND run_key=%s RETURNING *",
            (traceback.format_exc()[-4000:], job_name, run_key)).fetchone()
        dynamo.mirror_rows("job_runs", [failed])
        raise  # let Modal's retries take over
