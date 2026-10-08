from decimal import Decimal

import pytest

from nuwrrrld.core.council.tally import (CouncilConfig, SeatVote, aggregate_invalidation, tally, validate_proposal)

CFG = CouncilConfig()
ANALYSTS = {f"seat_{i}" for i in range(1, 6)}


def votes(spec, da=("flat", 0.0)):
    out = [SeatVote(f"seat_{i}", "analyst", d, c, 1.0, Decimal(str(inv)) if inv else None) for i, (d, c, inv) in enumerate(spec, 1)]
    out.append(SeatVote("seat_6", "devils_advocate", da[0], da[1], 1.0))
    return out


def test_unanimous_long_reaches_consensus():
    t = tally(votes([("long", 0.8, 95)] * 5), CFG, ANALYSTS)
    assert t.consensus and t.lead == "long" and t.ratio == 1.0 and t.conviction == 0.8


def test_da_vote_is_not_counted():
    t = tally(votes([("long", 0.8, 95)] * 5, da=("short", 1.0)), CFG, ANALYSTS)
    assert t.counted == 5 and t.consensus


def test_weighted_ratio_below_threshold_blocks_consensus():
    t = tally(votes([("long", 0.9, 95), ("long", 0.9, 95), ("short", 0.9, 105), ("short", 0.9, 105), ("flat", 0.1, None)]), CFG, ANALYSTS)
    assert not t.consensus


def test_headcount_guard_stops_one_heavy_voter():
    spec = [("long", 1.0, 95), ("short", 0.1, 105), ("short", 0.1, 105), ("flat", 0.1, None), ("flat", 0.1, None)]
    v = votes(spec)
    v[0] = SeatVote("seat_1", "analyst", "long", 1.0, 10.0, Decimal(95))     # heavy weight: ratio passes, heads do not
    t = tally(v, CFG, ANALYSTS)
    assert t.ratio >= CFG.consensus_threshold and t.heads < CFG.headcount_threshold and not t.consensus


def test_tie_resolves_to_flat():
    t = tally(votes([("long", 0.5, 95), ("long", 0.5, 95), ("short", 0.5, 105), ("short", 0.5, 105), ("flat", 0.0, None)]), CFG, ANALYSTS)
    assert t.lead == "flat"


def test_all_flat_zero_conviction_is_flat_consensus():
    t = tally(votes([("flat", 0.0, None)] * 5), CFG, ANALYSTS)
    assert t.consensus and t.lead == "flat" and t.conviction == 0.0


def test_min_counted_voters():
    few = [SeatVote("seat_1", "analyst", "long", 1, 1, Decimal(95)), SeatVote("seat_2", "analyst", "long", 1, 1, Decimal(95))]
    assert not tally(few, CFG, {"seat_1", "seat_2"}).consensus


def test_da_challenge_response_required():
    t = tally(votes([("long", 0.8, 95)] * 5), CFG, responded={"seat_1"})
    assert not t.consensus and "devil" in t.reason
    assert tally(votes([("long", 0.8, 95)] * 5), CouncilConfig(require_da_challenge_response=False), set()).consensus


def test_coerced_flat_votes_count_in_headcount_and_can_block():
    three_long = votes([("long", 0.9, 95)] * 3 + [("flat", 0.0, None)] * 2)
    assert tally(three_long, CFG, ANALYSTS).consensus                   # 3/5 heads = 0.6 passes
    two_long = votes([("long", 0.9, 95)] * 2 + [("flat", 0.0, None)] * 3)
    t = tally(two_long, CFG, ANALYSTS)
    assert not t.consensus and t.heads == 0.4                           # coerced seats (flat/0) deny the headcount


def test_invalidation_median_and_clamp():
    v = votes([("long", 0.8, 95), ("long", 0.8, 96), ("long", 0.8, 94), ("long", 0.8, 95), ("long", 0.8, 97)])
    assert aggregate_invalidation(v, "long", CFG, Decimal(100), Decimal(2)) == Decimal("95.00")
    far = votes([("long", 0.8, 50)] * 5)
    assert aggregate_invalidation(far, "long", CFG, Decimal(100), Decimal(2)) == Decimal("92.00")   # 4 ATR clamp
    near = votes([("long", 0.8, 99.99)] * 5)
    assert aggregate_invalidation(near, "long", CFG, Decimal(100), Decimal(2)) == Decimal("99.00")  # 0.5 ATR clamp


def test_invalidation_none_when_wrong_side_or_missing():
    wrong = votes([("long", 0.8, 105)] * 5)
    assert aggregate_invalidation(wrong, "long", CFG, Decimal(100), Decimal(2)) is None
    assert aggregate_invalidation(votes([("long", 0.8, None)] * 5), "long", CFG, Decimal(100), Decimal(2)) is None
    assert aggregate_invalidation(votes([("flat", 0, None)] * 5), "flat", CFG, Decimal(100), Decimal(2)) is None


def test_invalidation_short_side_and_aggregations():
    v = votes([("short", 0.8, 104), ("short", 0.8, 110), ("short", 0.8, 106), ("short", 0.8, 105), ("short", 0.8, 103)])
    assert aggregate_invalidation(v, "short", CFG, Decimal(100), Decimal(2)) == Decimal("105.00")
    cons = CouncilConfig(invalidation_aggregation="most_conservative")
    assert aggregate_invalidation(v, "short", cons, Decimal(100), Decimal(2)) == Decimal("103.00")
    wm = CouncilConfig(invalidation_aggregation="weighted_median")
    assert aggregate_invalidation(v, "short", wm, Decimal(100), Decimal(2)) == Decimal("105.00")


@pytest.mark.parametrize("direction,conv,inval,errors", [
    ("long", 0.5, Decimal(95), 0), ("short", 0.5, Decimal(105), 0), ("flat", 0.0, None, 0),
    ("long", 1.5, Decimal(95), 1), ("long", 0.5, None, 1), ("long", 0.5, Decimal(105), 1),
    ("short", 0.5, Decimal(95), 1), ("sideways", 0.5, None, 1)])
def test_validate_proposal(direction, conv, inval, errors):
    assert len(validate_proposal(direction, conv, inval, Decimal(100), [], {})) == errors


def test_evidence_must_exist_in_context():
    ok = validate_proposal("flat", 0, None, Decimal(100), [{"indicator": "rsi_14", "value": 41.2}], {"rsi_14": 41.2})
    bad = validate_proposal("flat", 0, None, Decimal(100), [{"indicator": "rsi_14", "value": 70}], {"rsi_14": 41.2})
    assert ok == [] and len(bad) == 1


def test_config_from_yaml_dict():
    cc = CouncilConfig.from_dict({"max_rounds": 2, "subjects": {"scheduled_top_k": 3}})
    assert cc.max_rounds == 2 and cc.scheduled_top_k == 3 and cc.consensus_threshold == 0.67
