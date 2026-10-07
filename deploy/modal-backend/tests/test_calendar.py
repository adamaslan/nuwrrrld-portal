import datetime as dt

from nuwrrrld.calendar import TradingCalendar, iso_week_key, today_et

D = dt.date


def test_weekend_and_holiday_are_not_sessions():
    cal = TradingCalendar()
    assert cal.session_for(D(2026, 10, 10)) is None            # Saturday
    assert cal.session_for(D(2026, 12, 25)) is None            # Christmas
    assert cal.session_for(D(2026, 10, 7)) == D(2026, 10, 7)   # Wednesday


def test_next_session_skips_weekend_and_holiday():
    cal = TradingCalendar()
    assert cal.next_session(D(2026, 10, 9)) == D(2026, 10, 12)       # Fri -> Mon
    assert cal.next_session(D(2026, 12, 24)) == D(2026, 12, 28)      # Thu eve -> next trading Mon


def test_add_sessions_counts_trading_sessions_not_calendar_days():
    cal = TradingCalendar()
    assert cal.add_sessions(D(2026, 10, 5), 5) == D(2026, 10, 12)    # 1 week = 5 sessions
    assert cal.add_sessions(D(2026, 10, 5), 0) == D(2026, 10, 5)


def test_last_session_of_week_handles_friday_holiday():
    cal = TradingCalendar()
    assert cal.is_last_session_of_week(D(2026, 10, 9))               # normal Friday
    assert not cal.is_last_session_of_week(D(2026, 10, 8))           # Thursday with open Friday
    # 2026-07-03 (Fri) is the observed Independence Day holiday -> Thursday is the last session
    assert cal.is_session(D(2026, 7, 2)) and not cal.is_session(D(2026, 7, 3))
    assert cal.is_last_session_of_week(D(2026, 7, 2))


def test_first_session_of_month_handles_weekend_start():
    cal = TradingCalendar()
    assert cal.is_first_session_of_month(D(2026, 10, 1))
    assert not cal.is_first_session_of_month(D(2026, 10, 2))
    assert cal.is_first_session_of_month(D(2026, 11, 2))             # Nov 1 is a Sunday


def test_manual_closure_override():
    cal = TradingCalendar(frozenset({D(2026, 10, 7)}))
    assert cal.session_for(D(2026, 10, 7)) is None
    assert cal.next_session(D(2026, 10, 6)) == D(2026, 10, 8)


def test_today_et_uses_market_time_not_utc():
    late_utc = dt.datetime(2026, 10, 8, 2, 30, tzinfo=dt.timezone.utc)   # still Oct 7 in New York
    assert today_et(late_utc) == D(2026, 10, 7)


def test_iso_week_key():
    assert iso_week_key(D(2026, 10, 9)) == "2026-W41"


def test_early_close_flag_in_rows():
    rows = TradingCalendar().rows(D(2026, 11, 27), D(2026, 11, 27))   # day after Thanksgiving
    assert rows[0].is_open and rows[0].is_early_close
