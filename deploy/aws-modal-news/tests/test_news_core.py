"""Offline tests for news_core: every invariant the design leans on (§6, §7, §8.3)."""

import math
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import news_core as nc  # noqa: E402

UTC = timezone.utc
CUTOFF = datetime(2026, 10, 8, 20, 0, tzinfo=UTC)  # 16:00 EDT


def signal(hours_before=1.0, polarity=0.8, confidence=1.0, relevance=1.0, novelty=1.0, event="earnings",
           story="s1", article_id=1, source="benzinga", corroborated=False):
    return nc.ArticleSignal(article_id, CUTOFF - timedelta(hours=hours_before), source, polarity, confidence,
                            relevance, novelty, event, story, corroborated)


class TestClustering:
    def test_reworded_headline_with_different_numbers_clusters(self):
        a = nc.simhash64(nc.normalize_headline("Apple beats Q3 estimates, revenue up 8%", ["AAPL"]))
        b = nc.simhash64(nc.normalize_headline("Apple beats Q3 estimates, revenue up 9%", ["AAPL"]))
        assert nc.hamming(a, b) <= nc.STORY_HAMMING_THRESHOLD

    def test_unrelated_headlines_do_not_cluster(self):
        a = nc.simhash64(nc.normalize_headline("Apple beats quarterly earnings estimates"))
        b = nc.simhash64(nc.normalize_headline("Tesla recalls vehicles over brake software defect"))
        assert nc.hamming(a, b) > nc.STORY_HAMMING_THRESHOLD

    def test_simhash_fits_signed_bigint(self):
        for text in ("a b c", "apple beats estimates", "x" * 200):
            assert -(1 << 63) <= nc.simhash64(text) < (1 << 63)

    def test_first_article_is_new_story_full_novelty(self):
        story, novelty, first = nc.assign_story(123, CUTOFF, [])
        assert novelty == nc.NOVELTY_FIRST and first == CUTOFF and len(story) == 16

    def test_repeat_within_day_is_discounted_then_later_more(self):
        ref = nc.StoryRef("abc", 100, CUTOFF - timedelta(hours=30), CUTOFF - timedelta(hours=30))
        same_day, nov_a, _ = nc.assign_story(100, CUTOFF - timedelta(hours=20), [ref])
        assert same_day == "abc" and nov_a == nc.NOVELTY_SAME_DAY_REPEAT
        _, nov_b, _ = nc.assign_story(100, CUTOFF, [ref])
        assert nov_b == nc.NOVELTY_LATER_REPEAT

    def test_repeat_outside_48h_window_starts_a_new_story(self):
        ref = nc.StoryRef("abc", 100, CUTOFF - timedelta(hours=60), CUTOFF - timedelta(hours=60))
        story, novelty, _ = nc.assign_story(100, CUTOFF, [ref])
        assert story != "abc" and novelty == nc.NOVELTY_FIRST


class TestRelevance:
    def test_single_symbol_named_is_capped_at_one(self):
        assert nc.relevance(1, "AAPL", "AAPL beats estimates") == 1.0

    def test_sixteen_symbol_roundup_is_a_quarter(self):
        assert nc.relevance(16, "AAPL", "Market wrap") == pytest.approx(0.25)

    def test_naming_the_ticker_boosts_but_not_inside_other_words(self):
        assert nc.relevance(4, "AAPL", "AAPL jumps") == pytest.approx(0.5 * 1.25)
        assert nc.relevance(4, "AA", "Apple jumps") == pytest.approx(0.5)


class TestSessionAssignment:
    def test_after_cutoff_rolls_to_next_session(self):
        friday_after_close = datetime(2026, 10, 9, 20, 30, tzinfo=UTC)  # Fri 16:30 ET
        assert nc.session_for_article(friday_after_close) == date(2026, 10, 12)  # Monday

    def test_before_cutoff_same_day(self):
        assert nc.session_for_article(datetime(2026, 10, 8, 19, 59, tzinfo=UTC)) == date(2026, 10, 8)

    def test_cutoff_is_1600_eastern(self):
        assert nc.session_cutoff(date(2026, 10, 8)) == datetime(2026, 10, 8, 20, 0, tzinfo=UTC)
        assert nc.session_cutoff(date(2026, 12, 8)) == datetime(2026, 12, 8, 21, 0, tzinfo=UTC)  # EST


class TestScorers:
    def test_lexicon_positive_negative_and_neutral(self):
        assert nc.lexicon_score("Company beats estimates and raises guidance").polarity > 0
        assert nc.lexicon_score("Company misses estimates, shares plunge").polarity < 0
        neutral = nc.lexicon_score("Company schedules annual meeting")
        assert neutral.polarity == 0 and neutral.confidence == 0

    def test_negation_flips_a_word(self):
        assert nc.lexicon_score("Firm does not beat estimates").polarity < 0

    def test_offering_defaults_negative(self):
        out = nc.lexicon_score("Company announces public offering of common stock")
        assert out.polarity < 0 and out.event_type == "offering_dilution"

    def test_lexicon_bounds(self):
        out = nc.lexicon_score("beat beat beat surge surge soar rally gain")
        assert -1 <= out.polarity <= 1 and 0 <= out.confidence <= 1

    def test_finbert_output_mapping(self):
        out = nc.finbert_output(0.7, 0.1, 0.2)
        assert out.polarity == pytest.approx(0.6) and out.confidence == pytest.approx(0.7)

    def test_event_rules_are_ordered_specific_first(self):
        assert nc.classify_event("Company prices public offering after earnings") == "offering_dilution"
        assert nc.classify_event("Analyst upgrades stock, raises price target") == "analyst_rating"
        assert nc.classify_event("Nothing to see") == "other"

    @pytest.mark.parametrize("headline", [
        "CEO steps down after board review",   # "eps" inside "steps"
        "Company issues statement on new store openings",   # "sues" inside "issues"
        "Company keeps full-year outlook",     # "eps" inside "keeps"
    ])
    def test_keywords_match_whole_words_only(self, headline):
        assert nc.classify_event(headline) not in ("earnings", "regulatory_legal")


class TestEnsemble:
    def out(self, scorer, polarity, confidence):
        return nc.ScorerOutput(scorer, polarity, confidence)

    def test_none_when_no_known_scorer(self):
        assert nc.ensemble([]) is None

    def test_agreement_keeps_confidence_high(self):
        agree = nc.ensemble([self.out(nc.SCORER_FINBERT, 0.8, 0.9), self.out(nc.SCORER_LEXICON, 0.8, 0.9)])
        assert agree.polarity == pytest.approx(0.8) and agree.confidence == pytest.approx(0.9)

    def test_disagreement_lowers_confidence_not_just_averages_to_zero(self):
        agree = nc.ensemble([self.out(nc.SCORER_FINBERT, 0.6, 0.9), self.out(nc.SCORER_LEXICON, 0.6, 0.9)])
        split = nc.ensemble([self.out(nc.SCORER_FINBERT, 0.6, 0.9), self.out(nc.SCORER_LEXICON, -0.6, 0.9)])
        assert split.confidence < agree.confidence

    def test_single_scorer_has_no_spread_penalty(self):
        only = nc.ensemble([self.out(nc.SCORER_FINBERT, 0.5, 0.8)])
        assert only.polarity == pytest.approx(0.5) and only.confidence == pytest.approx(0.8)

    def test_zero_confidence_everywhere_is_neutral_not_nan(self):
        out = nc.ensemble([self.out(nc.SCORER_FINBERT, 0.4, 0.0), self.out(nc.SCORER_LEXICON, -0.4, 0.0)])
        assert out.polarity == 0.0 and not math.isnan(out.confidence)

    def test_event_prefers_llm(self):
        out = nc.ensemble([
            nc.ScorerOutput(nc.SCORER_LEXICON, 0.1, 0.5, "earnings"),
            nc.ScorerOutput(nc.SCORER_LLM, 0.2, 0.5, "mna"),
        ])
        assert out.event_type == "mna"

    def test_llm_selection_rules(self):
        lex = nc.ScorerOutput(nc.SCORER_LEXICON, 0.5, 0.6)
        fin = nc.ScorerOutput(nc.SCORER_FINBERT, -0.5, 0.6)
        assert nc.needs_llm(lex, fin, "plain text", None)
        calm = nc.ScorerOutput(nc.SCORER_FINBERT, 0.5, 0.6)
        assert not nc.needs_llm(lex, calm, "plain text", 0.0)
        assert nc.needs_llm(lex, calm, "plain text", 2.5)
        assert nc.needs_llm(lex, calm, "FDA approval expected", None)


class TestAggregation:
    def test_absent_when_no_articles(self):
        result = nc.aggregate_ticker([], CUTOFF)
        assert result.news_score is None and result.news_state == "absent" and result.n_articles == 0

    def test_absent_is_not_neutral(self):
        old = [signal(hours_before=200)]
        assert nc.aggregate_ticker(old, CUTOFF).news_state == "absent"
        weak = [signal(polarity=0.01, confidence=0.1)]
        assert nc.aggregate_ticker(weak, CUTOFF).news_state == "neutral"

    def test_no_lookahead_article_after_cutoff_is_excluded(self):
        after = nc.ArticleSignal(9, CUTOFF + timedelta(minutes=1), "b", 1.0, 1.0, 1.0, 1.0, "earnings", "x")
        assert nc.aggregate_ticker([after], CUTOFF).news_state == "absent"

    def test_article_exactly_at_cutoff_is_included_and_window_start_excluded(self):
        at_cut = nc.ArticleSignal(1, CUTOFF, "b", 1.0, 1.0, 1.0, 1.0, "earnings", "x")
        assert nc.aggregate_ticker([at_cut], CUTOFF).n_articles == 1
        edge = nc.ArticleSignal(2, CUTOFF - timedelta(hours=72), "b", 1.0, 1.0, 1.0, 1.0, "earnings", "y")
        assert nc.aggregate_ticker([edge], CUTOFF).n_articles == 0

    def test_score_is_bounded_and_saturates(self):
        many = [signal(polarity=1.0, story=f"s{i}", article_id=i) for i in range(8)]
        assert 0.99 < nc.aggregate_ticker(many, CUTOFF).news_score <= 1.0

    def test_sign_follows_polarity(self):
        assert nc.aggregate_ticker([signal(polarity=-0.9)], CUTOFF).news_state == "bearish"
        assert nc.aggregate_ticker([signal(polarity=0.9)], CUTOFF).news_state == "bullish"

    def test_decay_halves_at_the_event_half_life(self):
        fresh = nc.aggregate_ticker([signal(hours_before=0.0)], CUTOFF).components["S"]
        aged = nc.aggregate_ticker([signal(hours_before=36.0)], CUTOFF).components["S"]  # earnings half-life
        assert aged == pytest.approx(fresh / 2, rel=1e-3)

    def test_corroboration_boost_and_novelty_discount(self):
        base = nc.aggregate_ticker([signal()], CUTOFF).components["S"]
        boosted = nc.aggregate_ticker([signal(corroborated=True)], CUTOFF).components["S"]
        discounted = nc.aggregate_ticker([signal(novelty=0.3)], CUTOFF).components["S"]
        assert boosted == pytest.approx(base * 1.1) and discounted == pytest.approx(base * 0.3)

    def test_fitted_event_and_source_weights_override_priors(self):
        base = nc.aggregate_ticker([signal()], CUTOFF).components["S"]
        fitted = nc.aggregate_ticker([signal()], CUTOFF, event_weights={"earnings": 0.5}, source_weights={"benzinga": 0.5})
        assert fitted.components["S"] == pytest.approx(base * 0.25)

    def test_story_counts_distinct_stories_not_copies(self):
        copies = [signal(story="same", article_id=i) for i in range(5)] + [signal(story="other", article_id=9)]
        result = nc.aggregate_ticker(copies, CUTOFF)
        assert result.n_articles == 6 and result.n_stories == 2 and result.stories_24h == 2

    def test_top_event_and_article(self):
        result = nc.aggregate_ticker(
            [signal(event="earnings", polarity=0.9, article_id=1, story="a"),
             signal(event="analyst_rating", polarity=0.1, article_id=2, story="b")], CUTOFF)
        assert result.top_event == "earnings" and result.top_article_id == 1


class TestVolumeZ:
    def test_none_without_baseline(self):
        assert nc.volume_z(5, [1, 2, 3]) is None

    def test_floor_on_stdev_avoids_blowup(self):
        assert nc.volume_z(3, [1] * 20) == pytest.approx((3 - 1) / 0.5)

    def test_normal_case(self):
        history = [2, 4] * 10
        assert nc.volume_z(6, history) == pytest.approx((6 - 3) / 1.0)


SESSIONS = [date(2026, 10, 1) + timedelta(days=i) for i in range(40)]


class TestLabeling:
    closes = {d: 100.0 + i for i, d in enumerate(SESSIONS)}
    flat = {d: 100.0 for d in SESSIONS}

    def test_forward_return_counts_sessions_not_days(self):
        assert nc.forward_return(self.closes, SESSIONS, SESSIONS[0], 5) == pytest.approx(105 / 100 - 1)

    def test_immature_horizon_is_none(self):
        assert nc.forward_return(self.closes, SESSIONS, SESSIONS[-2], 5) is None

    def test_missing_start_bar_is_none(self):
        partial = {d: c for d, c in self.closes.items() if d != SESSIONS[3]}
        assert nc.forward_return(partial, SESSIONS, SESSIONS[3], 1) is None

    def test_abnormal_return_is_relative_to_benchmark(self):
        out = nc.label_outcome(0.5, self.closes, self.flat, SESSIONS, SESSIONS[0], 1)
        assert out.abn_ret == pytest.approx(0.01) and out.hit is True

    def test_bearish_score_on_rising_stock_is_a_miss(self):
        assert nc.label_outcome(-0.5, self.closes, self.flat, SESSIONS, SESSIONS[0], 1).hit is False

    def test_neutral_band_has_no_hit(self):
        assert nc.label_outcome(0.05, self.closes, self.flat, SESSIONS, SESSIONS[0], 1).hit is None

    def test_none_while_either_leg_is_immature(self):
        short_bench = {d: 100.0 for d in SESSIONS[:3]}
        assert nc.label_outcome(0.5, self.closes, short_bench, SESSIONS, SESSIONS[0], 5) is None


class TestMetrics:
    def test_spearman_perfect_and_inverse(self):
        assert nc.spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
        assert nc.spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)

    def test_spearman_handles_ties_and_degenerate(self):
        assert nc.spearman([1, 1, 1], [1, 2, 3]) is None
        assert nc.spearman([1, 2], [1, 2]) is None

    def test_wilson_interval_brackets_the_rate(self):
        lo, hi = nc.wilson_interval(60, 100)
        assert lo < 0.6 < hi and 0 <= lo and hi <= 1
        assert nc.wilson_interval(0, 0) == (None, None)

    def _perfect_rows(self, sessions=30, tickers=25):
        rows = []
        for s in range(sessions):
            day = SESSIONS[0] + timedelta(days=s)
            for t in range(tickers):
                score = (t - tickers / 2) / tickers
                rows.append((day, score, score * 0.1, True))  # a perfect predictor is always right
        return rows

    def test_sessions_under_20_tickers_are_skipped(self):
        rows = [(SESSIONS[0], i / 10, i / 10) for i in range(10)]
        assert nc.session_ics(rows) == []

    def test_perfect_predictor_metrics(self):
        m = nc.compute_slice_metrics(self._perfect_rows(), horizon=1, coverage=0.9)
        assert m.rank_ic == pytest.approx(1.0) and m.hit_rate == 1.0
        assert m.decile_spread > 0 and m.monotonicity == pytest.approx(1.0)
        assert m.coverage == 0.9 and m.n_obs == 30 * 25

    def test_tstat_thins_to_non_overlapping_sessions(self):
        ics = [(SESSIONS[0] + timedelta(days=i), 0.05 + (0.01 if i % 2 else -0.01)) for i in range(40)]
        daily = nc.summarize_ics(ics, 1)
        weekly = nc.summarize_ics(ics, 5)
        assert abs(weekly.ic_tstat) < abs(daily.ic_tstat)

    def test_brier_baseline_for_zero_score(self):
        assert nc.brier_score([(0.0, 0.01), (0.0, -0.01)]) == pytest.approx(0.25)
        assert nc.brier_score([(1.0, 0.01)]) == pytest.approx(0.0)
        assert nc.brier_score([]) is None

    def test_empty_slice_is_all_none_not_a_crash(self):
        m = nc.compute_slice_metrics([], horizon=5)
        assert m.n_obs == 0 and m.hit_rate is None and m.rank_ic is None and m.brier is None


class TestGovernance:
    good = nc.GateInputs(130, 6000, 0.03, 2.5, 0.01, 0.0, 0.0, 0.7)

    def test_gate_passes_only_when_every_condition_holds(self):
        assert nc.gate_passes(self.good)

    @pytest.mark.parametrize("field,value", [
        ("n_sessions", 119), ("n_pairs", 4999), ("mean_ic_5d", 0.019), ("ic_tstat_5d", 1.9),
        ("delta_ic_5d", 0.004), ("delta_ic_1d", -0.001), ("delta_ic_20d", -0.001), ("monotonicity_5d", 0.5),
    ])
    def test_each_condition_is_necessary(self, field, value):
        assert not nc.gate_passes(nc.GateInputs(**{**self.good.__dict__, field: value}))

    def test_missing_delta_ic_fails_the_gate(self):
        assert not nc.gate_passes(nc.GateInputs(**{**self.good.__dict__, "delta_ic_5d": None}))

    def test_shadow_needs_two_consecutive_passes(self):
        grid = {0.0: 0.0, 0.25: 0.004, 0.5: 0.006}
        first = nc.next_weight_state(nc.WeightState("shadow", 0.0), True, 0.03, 2.5, grid, 0.01)
        assert first.status == "shadow" and first.weight == 0.0 and first.gate_passed_last
        second = nc.next_weight_state(first, True, 0.03, 2.5, grid, 0.01)
        assert second.status == "active" and second.weight == 0.5

    def test_a_failed_pass_resets_the_streak(self):
        state = nc.WeightState("shadow", 0.0, gate_passed_last=True)
        assert not nc.next_weight_state(state, False, 0.0, 0.0, {}, None).gate_passed_last

    def test_weight_never_exceeds_ic_implied_cap(self):
        grid = {0.0: 0.0, 0.25: 0.01, 0.5: 0.02, 0.75: 0.03, 1.0: 0.04}
        out = nc.next_weight_state(nc.WeightState("shadow", 0.0, True), True, 0.03, 2.5, grid, 0.01)
        assert out.weight <= 0.03 / 0.05 + 1e-9

    def test_hysteresis_blocks_small_changes(self):
        state = nc.WeightState("active", 0.5)
        grid = {0.0: 0.0, 0.25: 0.01, 0.5: 0.02, 0.75: 0.02}
        out = nc.next_weight_state(state, True, 0.04, 3.0, grid, 0.01)
        assert out.weight == 0.5  # candidate .75 vs .5 = 0.25 move, but argmax tie -> smaller weight .5

    def test_three_negative_delta_ic_weeks_demote(self):
        state = nc.WeightState("active", 0.5)
        for _ in range(2):
            state = nc.next_weight_state(state, True, 0.04, 3.0, {0.5: 0.0}, -0.01)
            assert state.status == "active"
        assert nc.next_weight_state(state, True, 0.04, 3.0, {0.5: 0.0}, -0.01).status == "demoted"

    def test_negative_tstat_demotes_immediately(self):
        assert nc.next_weight_state(nc.WeightState("active", 0.5), True, 0.04, -0.1, {}, 0.01).status == "demoted"

    def test_demoted_returns_to_shadow_after_eight_weeks(self):
        state = nc.WeightState("demoted", 0.0)
        for _ in range(7):
            state = nc.next_weight_state(state, False, None, None, {}, None)
            assert state.status == "demoted"
        assert nc.next_weight_state(state, False, None, None, {}, None).status == "shadow"

    def test_override_is_never_changed_by_the_evaluator(self):
        pinned = nc.WeightState("override", 0.0)
        assert nc.next_weight_state(pinned, True, 0.9, 9.0, {1.0: 1.0}, 1.0) is pinned

    def test_scorer_weight_proposal_needs_300_obs_and_shrinks(self):
        assert nc.propose_scorer_weights({nc.SCORER_FINBERT: (0.05, 299), nc.SCORER_LEXICON: (0.01, 400)}) == nc.ENSEMBLE_WEIGHTS
        fitted = nc.propose_scorer_weights({nc.SCORER_FINBERT: (0.0, 500), nc.SCORER_LEXICON: (0.05, 500)})
        assert nc.ENSEMBLE_WEIGHTS[nc.SCORER_LEXICON] < fitted[nc.SCORER_LEXICON] <= 1.5 * nc.ENSEMBLE_WEIGHTS[nc.SCORER_LEXICON]
        assert fitted[nc.SCORER_FINBERT] < nc.ENSEMBLE_WEIGHTS[nc.SCORER_FINBERT]

    def test_weight_version_format(self):
        assert nc.weight_version(datetime(2026, 10, 17, 14, tzinfo=UTC)) == "nw-2026-10-17-1"


class TestScheduler:
    def at(self, y, mo, d, h, mi):
        from zoneinfo import ZoneInfo
        return datetime(y, mo, d, h, mi, tzinfo=ZoneInfo("America/New_York"))

    def test_ingest_every_two_minutes_in_window_weekday(self):
        assert nc.JOB_INGEST in nc.due_jobs(self.at(2026, 10, 8, 10, 4))
        assert nc.JOB_INGEST not in nc.due_jobs(self.at(2026, 10, 8, 10, 5))

    def test_ingest_every_thirty_minutes_off_hours_and_weekends(self):
        assert nc.JOB_INGEST in nc.due_jobs(self.at(2026, 10, 8, 21, 30))
        assert nc.JOB_INGEST not in nc.due_jobs(self.at(2026, 10, 8, 21, 10))
        assert nc.JOB_INGEST in nc.due_jobs(self.at(2026, 10, 10, 11, 0))   # Saturday
        assert nc.JOB_INGEST not in nc.due_jobs(self.at(2026, 10, 10, 11, 2))

    def test_window_edges(self):
        assert nc.JOB_INGEST in nc.due_jobs(self.at(2026, 10, 8, 7, 0))
        assert nc.JOB_INGEST in nc.due_jobs(self.at(2026, 10, 8, 19, 58))
        assert nc.JOB_INGEST not in nc.due_jobs(self.at(2026, 10, 8, 20, 2))
        assert nc.JOB_INGEST in nc.due_jobs(self.at(2026, 10, 8, 20, 30))

    def test_poller_covers_the_session_inclusive_of_close_only(self):
        assert nc.JOB_POLLER in nc.due_jobs(self.at(2026, 10, 8, 9, 30))
        assert nc.JOB_POLLER not in nc.due_jobs(self.at(2026, 10, 8, 9, 29))
        assert nc.JOB_POLLER in nc.due_jobs(self.at(2026, 10, 8, 16, 0))
        assert nc.JOB_POLLER not in nc.due_jobs(self.at(2026, 10, 8, 16, 1))
        assert nc.JOB_POLLER not in nc.due_jobs(self.at(2026, 10, 10, 10, 0))

    def test_corroborate_every_half_hour_in_market(self):
        assert nc.JOB_CORROBORATE in nc.due_jobs(self.at(2026, 10, 8, 10, 30))
        assert nc.JOB_CORROBORATE not in nc.due_jobs(self.at(2026, 10, 8, 9, 0))
        assert nc.JOB_CORROBORATE not in nc.due_jobs(self.at(2026, 10, 8, 10, 15))

    def test_daily_slots(self):
        assert nc.JOB_SCORE_BACKLOG in nc.due_jobs(self.at(2026, 10, 8, 17, 30))
        assert nc.JOB_SCORE_BACKLOG not in nc.due_jobs(self.at(2026, 10, 8, 17, 31))
        assert nc.JOB_SCORE_BACKLOG not in nc.due_jobs(self.at(2026, 10, 10, 17, 30))   # Saturday
        assert nc.JOB_AGGREGATE_PREVIEW in nc.due_jobs(self.at(2026, 10, 8, 9, 20))
        assert nc.JOB_AGGREGATE_FINAL in nc.due_jobs(self.at(2026, 10, 8, 16, 5))
        assert nc.JOB_AGGREGATE_FINAL in nc.due_jobs(self.at(2026, 10, 8, 16, 25))   # retry slot
        assert nc.JOB_LABEL in nc.due_jobs(self.at(2026, 10, 8, 19, 0))
        assert nc.JOB_EVAL not in nc.due_jobs(self.at(2026, 10, 8, 10, 0))          # Thursday

    def test_eval_only_saturday_morning(self):
        assert nc.JOB_EVAL in nc.due_jobs(self.at(2026, 10, 10, 10, 0))
        assert nc.JOB_AGGREGATE_FINAL not in nc.due_jobs(self.at(2026, 10, 10, 16, 5))

    def test_dst_follows_eastern_not_utc(self):
        winter = datetime(2026, 12, 8, 21, 5, tzinfo=timezone.utc)   # 16:05 EST
        assert nc.JOB_AGGREGATE_FINAL in nc.due_jobs(winter)
        summer = datetime(2026, 10, 8, 20, 5, tzinfo=timezone.utc)   # 16:05 EDT
        assert nc.JOB_AGGREGATE_FINAL in nc.due_jobs(summer)
