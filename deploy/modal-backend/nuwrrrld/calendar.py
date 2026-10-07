"""NYSE trading calendar (exchange_calendars XNYS) with optional manual overrides.

Every market job asks this module — never the UTC date — whether today is a session.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from functools import lru_cache
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
CALENDAR_NAME = "XNYS"
ROLLING_MONTHS = 18


def today_et(now: dt.datetime | None = None) -> dt.date:
    return (now or dt.datetime.now(dt.timezone.utc)).astimezone(ET).date()


@dataclass(frozen=True)
class SessionRow:
    session_date: dt.date
    is_open: bool
    open_at: dt.datetime | None
    close_at: dt.datetime | None
    is_early_close: bool


@lru_cache(maxsize=1)
def _xnys():
    import exchange_calendars as xcals
    return xcals.get_calendar(CALENDAR_NAME)


class TradingCalendar:
    """Session lookups. `closed_overrides` are ad-hoc closures (admin override, source='manual')."""

    def __init__(self, closed_overrides: frozenset[dt.date] = frozenset()):
        self._cal = _xnys()
        self._closed = closed_overrides

    def is_session(self, day: dt.date) -> bool:
        if day in self._closed:
            return False
        from exchange_calendars.errors import DateOutOfBounds
        try:
            return bool(self._cal.is_session(day.isoformat()))
        except DateOutOfBounds:   # beyond the library's bounds: closed. Any other error must surface, not read as "closed"
            return False

    def session_for(self, day: dt.date) -> dt.date | None:
        return day if self.is_session(day) else None

    def next_session(self, day: dt.date) -> dt.date:
        probe = day + dt.timedelta(days=1)
        for _ in range(15):
            if self.is_session(probe):
                return probe
            probe += dt.timedelta(days=1)
        raise ValueError(f"no session within 15 days after {day}")

    def prev_session(self, day: dt.date) -> dt.date:
        probe = day - dt.timedelta(days=1)
        for _ in range(15):
            if self.is_session(probe):
                return probe
            probe -= dt.timedelta(days=1)
        raise ValueError(f"no session within 15 days before {day}")

    def add_sessions(self, day: dt.date, n: int) -> dt.date:
        """Return the session `n` trading sessions after `day` (horizons count sessions)."""
        if n < 0:
            raise ValueError("n must be >= 0")
        cur = day
        for _ in range(n):
            cur = self.next_session(cur)
        return cur

    def sessions_between(self, start: dt.date, end: dt.date) -> list[dt.date]:
        out, cur = [], start
        while cur <= end:
            if self.is_session(cur):
                out.append(cur)
            cur += dt.timedelta(days=1)
        return out

    def is_last_session_of_week(self, day: dt.date) -> bool:
        """True when `day` is the last session of its ISO week (Friday, or Thursday if Friday is shut)."""
        if not self.is_session(day):
            return False
        nxt = self.next_session(day)
        return nxt.isocalendar()[:2] != day.isocalendar()[:2]

    def is_first_session_of_month(self, day: dt.date) -> bool:
        if not self.is_session(day):
            return False
        return self.prev_session(day).month != day.month

    def rows(self, start: dt.date, end: dt.date) -> list[SessionRow]:
        out: list[SessionRow] = []
        cur = start
        while cur <= end:
            if self.is_session(cur):
                s = cur.isoformat()
                out.append(SessionRow(
                    cur, True,
                    self._cal.session_open(s).to_pydatetime(),
                    self._cal.session_close(s).to_pydatetime(),
                    s in {x.isoformat()[:10] for x in self._cal.early_closes}))
            else:
                out.append(SessionRow(cur, False, None, None, False))
            cur += dt.timedelta(days=1)
        return out


def iso_week_key(day: dt.date) -> str:
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"
