"""news-sentiment: in-house VADER score on Finnhub company-news headlines (Finnhub's own score is premium)."""
from __future__ import annotations

import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import MissingInputError
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok

POSITIVE, NEGATIVE = 0.05, -0.05


@feature("news-sentiment", needs=("news",))
def news_sentiment(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

    if not any(bundle.news.values()):
        raise MissingInputError("no news in bundle")
    sia, data, rows = SentimentIntensityAnalyzer(), {}, []
    for t in bundle.tickers:
        items = bundle.news.get(t, [])
        scores = [sia.polarity_scores(i.get("headline", ""))["compound"] for i in items]
        for i, s in zip(items, scores):
            rows.append({"ticker": t, "headline": i.get("headline"), "source": i.get("source"), "compound": s})
        if scores:
            mean = sum(scores) / len(scores)
            data[t] = {"mean": round(mean, 3), "n": len(scores),
                       "label": "positive" if mean > POSITIVE else "negative" if mean < NEGATIVE else "neutral"}
    return ok("news-sentiment", data, {"headlines": pd.DataFrame(rows)}, ["finnhub", "vader"])
