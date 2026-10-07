"""Debate loop (Section 10.3). Persistence is behind `SessionStore` so the loop is testable without a DB."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from decimal import Decimal
from typing import Callable, Protocol

from nuwrrrld.core.council.strategy import DebateState, MarketContext, Proposal, Strategy
from nuwrrrld.core.council.tally import (CouncilConfig, SeatVote, TallyResult, aggregate_invalidation, tally,
                                         validate_proposal)

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Seat:
    slug: str
    member_id: str
    role: str
    vote_weight: float
    strategy: Strategy


class SessionStore(Protocol):
    def claim(self, session_id: str) -> bool: ...
    def load_context(self, session_id: str) -> tuple[MarketContext, CouncilConfig, list[Seat]]: ...
    def add_message(self, session_id: str, seq: int, round_: int, member_id: str | None, kind: str,
                    content_md: str, structured: dict, tokens: int) -> dict: ...
    def add_votes(self, session_id: str, round_: int, votes: list[tuple[Seat, Proposal, bool, bool]]) -> None: ...
    def heartbeat(self, session_id: str, tokens_used: int, rounds_run: int) -> None: ...
    def finish(self, session_id: str, status: str, consensus: dict | None, rounds_run: int, error: str | None) -> None: ...


class LiveEvents(Protocol):
    def put(self, event: dict, partition: str) -> None: ...
    def clear(self, partition: str) -> None: ...


def _known_values(ctx: MarketContext) -> dict[str, float]:
    out: dict[str, float] = {}
    for name, row in (ctx.indicators or {}).items():
        if isinstance(row, dict) and row.get("value") is not None:
            out[name] = float(row["value"])
    out.setdefault("close", float(ctx.reference_price))
    out.setdefault("atr_14", float(ctx.atr14))
    return out


def _coerce_flat() -> Proposal:
    return Proposal("flat", 0.0, None, "Proposal failed validation and was coerced to flat.")


def _valid_or_repaired(seat: Seat, p: Proposal, ctx: MarketContext, llm) -> tuple[Proposal, bool]:
    """Returns (proposal, coerced). One repair attempt, then coerce to flat/0."""
    known = _known_values(ctx)
    errs = validate_proposal(p.direction, p.conviction, p.invalidation_price, ctx.reference_price, p.evidence, known)
    if not errs:
        return p, False
    repair = getattr(seat.strategy, "repair", None)
    if repair is not None:
        fixed = repair(ctx, p, errs, llm)
        if not validate_proposal(fixed.direction, fixed.conviction, fixed.invalidation_price,
                                 ctx.reference_price, fixed.evidence, known):
            return fixed, False
    log.warning("seat %s proposal coerced to flat: %s", seat.slug, errs)
    return _coerce_flat(), True


def _est_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def run_session(session_id: str, store: SessionStore, llm, events: LiveEvents | None = None,
                moderator: Callable[[str, list[str]], str] | None = None, max_workers: int = 6) -> str:
    """Run one debate end-to-end. Returns the final session status."""
    if not store.claim(session_id):
        return "skipped"
    ctx, cfg, seats = store.load_context(session_id)
    seq, tokens, rounds_run = 0, 0, 0
    pool = ThreadPoolExecutor(max_workers=max_workers)

    def emit(round_: int, seat: Seat | None, kind: str, content: str, structured: dict | None = None) -> None:
        nonlocal seq, tokens
        seq += 1
        used = _est_tokens(content)
        tokens += used
        msg = store.add_message(session_id, seq, round_, seat.member_id if seat else None, kind, content,
                                structured or {}, used)
        if events:
            events.put({"seq": seq, "type": kind, "round": round_, "seat": seat.slug if seat else None,
                        "content_md": content, **msg}, session_id)
        store.heartbeat(session_id, tokens, rounds_run)

    try:
        by_slug = {s.slug: s for s in seats}
        da = next((s for s in seats if s.role == "devils_advocate"), None)
        analysts = [s for s in seats if s.role != "devils_advocate"]

        # ROUND 0 - blind openings, concurrent, no seat sees another.
        raw = list(pool.map(lambda s: s.strategy.propose(ctx, llm), seats))
        proposals: dict[str, Proposal] = {}
        votes_rows: list[tuple[Seat, Proposal, bool, bool]] = []
        for seat, p in zip(seats, raw):
            fixed, coerced = _valid_or_repaired(seat, p, ctx, llm)
            proposals[seat.slug] = fixed
            votes_rows.append((seat, fixed, seat.role not in cfg.exclude_roles_from_tally, coerced))
            emit(0, seat, "proposal", fixed.rationale_md, {"direction": fixed.direction, "conviction": fixed.conviction,
                                                         "invalidation_price": str(fixed.invalidation_price) if fixed.invalidation_price else None})
        store.add_votes(session_id, 0, votes_rows)

        def seat_votes() -> list[SeatVote]:
            return [SeatVote(s.slug, s.role, proposals[s.slug].direction, proposals[s.slug].conviction,
                             s.vote_weight, proposals[s.slug].invalidation_price,
                             any(r[0].slug == s.slug and r[3] for r in votes_rows)) for s in seats]

        responded: set[str] = set()
        summary = ""
        current: TallyResult = tally(seat_votes(), cfg, responded)
        last_round = 0
        for r in range(1, cfg.max_rounds + 1):
            if current.consensus and (not cfg.require_da_challenge_response or r > 1):
                break
            if tokens >= cfg.token_budget_per_session:
                emit(r, None, "system", "Token budget reached; stopping the debate.")
                break
            state = DebateState(r, dict(proposals), summary, current.lead, None)
            if da is not None:
                challenge = da.strategy.critique(ctx, state, llm)
                emit(r, da, "challenge", challenge)
                state = DebateState(r, dict(proposals), summary, current.lead, challenge)
            crit = list(pool.map(lambda s: (s, s.strategy.critique(ctx, state, llm),
                                            s.strategy.respond_to_challenge(ctx, state, llm)), analysts))
            for seat, critique_text, response_text in crit:
                emit(r, seat, "critique", critique_text)
                emit(r, seat, "response", response_text)
                responded.add(seat.slug)
            revised = list(pool.map(lambda s: s.strategy.revise(ctx, state, llm), seats))
            votes_rows = []
            for seat, p in zip(seats, revised):
                fixed, coerced = _valid_or_repaired(seat, p, ctx, llm)
                proposals[seat.slug] = fixed
                votes_rows.append((seat, fixed, seat.role not in cfg.exclude_roles_from_tally, coerced))
                emit(r, seat, "revision", fixed.rationale_md, {"direction": fixed.direction, "conviction": fixed.conviction})
            store.add_votes(session_id, r, votes_rows)
            current = tally(seat_votes(), cfg, responded)
            transcript = [f"{s.slug}: {proposals[s.slug].direction}/{proposals[s.slug].conviction:.2f}" for s in seats]
            summary = moderator(summary, transcript) if moderator else "; ".join(transcript)
            emit(r, None, "moderator", summary)
            rounds_run = last_round = r

        votes = seat_votes()
        inval = aggregate_invalidation(votes, current.lead, cfg, ctx.reference_price, ctx.atr14)
        is_consensus = current.consensus and (current.lead == "flat" or inval is not None)
        dissent = "; ".join(f"{s.slug}: {proposals[s.slug].rationale_md}" for s in seats
                            if s.role == "devils_advocate" or proposals[s.slug].direction != current.lead)
        consensus = {
            "outcome": "consensus" if is_consensus else "no_consensus",
            "direction": current.lead if is_consensus else None,
            "conviction": current.conviction if is_consensus else None,
            "invalidation_price": inval if is_consensus else None,
            "reference_price": ctx.reference_price, "agreement_ratio": current.ratio, "final_round": last_round,
            "summary_md": summary or f"Lead: {current.lead} ({current.reason}).", "dissent_summary_md": dissent}
        status = "consensus" if is_consensus else "no_consensus"
        store.finish(session_id, status, consensus, last_round, None)
        if events:
            events.put({"seq": seq + 1, "type": "session_complete", "status": status}, session_id)
        return status
    except Exception as exc:
        log.exception("council session failed session_id=%s", session_id)
        store.finish(session_id, "failed", None, rounds_run, repr(exc)[:2000])
        return "failed"
    finally:
        pool.shutdown(wait=False)
        if events:
            events.clear(session_id)
