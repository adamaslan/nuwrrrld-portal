"""LLM features: build the prompt from in-scope outputs; call OpenRouter only when asked to.

With LLM off the result is `skipped_llm` and carries the exact prompt that would have been sent."""
from __future__ import annotations

import json
import os

import httpx

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.features.registry import FeatureResult, RunContext, feature

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "anthropic/claude-haiku-4.5"
LLM_TIMEOUT_S = 60.0

INSTRUCTIONS = {
    "brief": "Write a 5-bullet market brief for these tickers.",
    "council": "Act as a council of four analysts (technical, macro, risk, quant). Each gives a one-line view per ticker.",
    "council-deliberate": "Four analysts (technical, macro, risk, quant) debate these signals, then converge on one call per ticker.",
    "council-public": "Summarize the council's views for a retail audience in plain language. No jargon.",
    "council-sample": "Give one short sample council exchange about the top-ranked ticker.",
    "nuai": "Answer as a concise trading assistant: what stands out in this data?",
    "signal-chat": "Explain the top-ranked ticker's signal to a user who asks 'why is this a buy or sell?'.",
    "portfolio-health-ai": "Explain the portfolio health result and the single most useful change to make.",
}
DEPENDS = {
    "portfolio-health-ai": ("portfolio-health", "portfolio-suggestions"),
}
DEFAULT_DEPENDS = ("signals-top", "analyze", "holdfold", "news-sentiment")


def openrouter_caller(api_key: str, model: str | None = None):
    model = model or os.getenv("NWF_LAB_LLM_MODEL", DEFAULT_MODEL)

    def call(prompt: str) -> str:
        r = httpx.post(
            OPENROUTER_URL, headers={"Authorization": f"Bearer {api_key}"}, timeout=LLM_TIMEOUT_S,
            json={"model": model, "messages": [{"role": "user", "content": prompt}]},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    return call


def build_prompt(slug: str, ctx: RunContext) -> str:
    context = {
        k: v.data for k, v in ctx.upstream.items()
        if k in (DEPENDS.get(slug) or DEFAULT_DEPENDS) and v.status == "ok"
    }
    return f"{INSTRUCTIONS[slug]}\n\nData (JSON):\n{json.dumps(context, default=str)[:12000]}"


def _make(slug: str) -> None:
    @feature(slug, depends_on=DEPENDS.get(slug, ("signals-top", "analyze")), llm=True)
    def _run(bundle: DataBundle, cfg: LabConfig, ctx: RunContext, _slug: str = slug) -> FeatureResult:
        prompt = build_prompt(_slug, ctx)
        if ctx.llm_call is None:
            return FeatureResult(_slug, "skipped_llm", {"prompt": prompt}, note="LLM off; prompt only")
        return FeatureResult(_slug, "ok", {"prompt": prompt, "response": ctx.llm_call(prompt)},
                             sources=("openrouter",))


for _s in INSTRUCTIONS:
    _make(_s)
