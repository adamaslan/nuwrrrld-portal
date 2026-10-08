"""Hold/Fold: global verdicts and cached personal verdicts."""
from __future__ import annotations

import datetime as dt
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from nuwrrrld import DISCLAIMER, ENGINE_VERSION, db
from nuwrrrld.api.deps import require_entitlement
from nuwrrrld.core import holdfold as hf
from nuwrrrld.llm import validate

router = APIRouter(prefix="/holdfold", tags=["holdfold"])


class PersonalIn(BaseModel):
    side: Literal["long", "short"] | None = None
    entry_price: float | None = Field(default=None, gt=0)


def _public(r) -> dict:
    d = dict(r)
    d["invalidation_price"] = float(d["invalidation_price"]) if d.get("invalidation_price") is not None else None
    return d


@router.get("/{ticker}")
async def global_verdict(ticker: str, date: dt.date | None = None, user: dict = Depends(require_entitlement)):
    row = await db.pool().fetchrow(
        """SELECT ticker, as_of_date, position_side, verdict, bias, risk_level, vol_regime, readings, invalidation_price, rationale_md
             FROM hold_fold_verdicts WHERE ticker=$1 AND scope='global' AND ($2::date IS NULL OR as_of_date=$2)
            ORDER BY as_of_date DESC LIMIT 1""", ticker.upper(), date)
    if row is None:
        raise HTTPException(404, detail={"code": "no_verdict"})
    return {**_public(row), "disclaimer": DISCLAIMER}


@router.post("/{ticker}/personal")
async def personal_verdict(ticker: str, body: PersonalIn, user: dict = Depends(require_entitlement)):
    t, p = ticker.upper(), db.pool()
    base = await p.fetchrow("SELECT * FROM hold_fold_verdicts WHERE ticker=$1 AND scope='global' ORDER BY as_of_date DESC LIMIT 1", t)
    if base is None:
        raise HTTPException(404, detail={"code": "no_verdict"})
    holding = await p.fetchrow("SELECT quantity, cost_basis FROM holdings WHERE user_id=$1 AND ticker=$2 LIMIT 1", user["id"], t)
    side = body.side or (("long" if holding["quantity"] > 0 else "short") if holding else None)
    if side is None:
        raise HTTPException(422, detail={"code": "side_required", "detail": "Provide a side or add a holding for this ticker."})
    entry = body.entry_price or (float(holding["cost_basis"]) if holding and holding["cost_basis"] else None)
    readings = base["readings"]
    verdict = hf.compute(t, side, readings, None, None, None)
    # Cached per (user, ticker, day): the partial unique index makes the upsert idempotent.
    row = await p.fetchrow(
        """INSERT INTO hold_fold_verdicts (ticker, as_of_date, scope, user_id, position_side, verdict, bias, risk_level, vol_regime,
                                           readings, invalidation_price, rationale_md, engine_version)
           VALUES ($1,$2,'user',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (user_id, ticker, as_of_date, engine_version) WHERE scope='user' DO UPDATE SET
             position_side=EXCLUDED.position_side, verdict=EXCLUDED.verdict, bias=EXCLUDED.bias, risk_level=EXCLUDED.risk_level,
             vol_regime=EXCLUDED.vol_regime, readings=EXCLUDED.readings, invalidation_price=EXCLUDED.invalidation_price,
             rationale_md=EXCLUDED.rationale_md RETURNING *""",
        t, base["as_of_date"], user["id"], side, verdict.verdict, verdict.bias, verdict.risk_level, verdict.vol_regime,
        verdict.readings, verdict.invalidation_price,
        validate.template_rationale({"ticker": t, "verdict": verdict.verdict, "position_side": side, "bias": verdict.bias,
                                     "risk_level": verdict.risk_level, "vol_regime": verdict.vol_regime}), ENGINE_VERSION)
    return {**_public(row), "personal": hf.personal_context(side, entry, readings.get("close"), verdict.invalidation_price),
            "disclaimer": DISCLAIMER}
