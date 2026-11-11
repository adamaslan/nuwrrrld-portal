/**
 * Blog article data for /blog.
 *
 * Every number quoted in these articles comes from one recorded run:
 * the 25-ticker, 5-year backtest comparison executed on 2026-11-01 using the
 * public engines (signals-app + this repo's tools/nwf-lab),
 * data through the 2026-10-30 close. The full method, raw output files, and
 * caveats are archived in the team's private documentation repo (not publicly
 * accessible; the articles must say that and never link or name it).
 *
 * Editorial rules for these articles:
 * - Historical results only. Never imply a backtest predicts future returns.
 * - Say "lab engine in the repo" for the offline runs; equivalence to the
 *   live site's deployed scoring is UNVERIFIED and articles must say so.
 * - Losses and caveats get named, not buried.
 */

export type BlogBlock =
  | { kind: "p"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "stats"; items: { value: string; label: string }[] }
  | { kind: "table"; caption?: string; columns: string[]; rows: string[][] };

export interface BlogArticle {
  slug: string;
  title: string;
  description: string;
  date: string; // ISO date of publication
  feature: string; // product area the article highlights
  blocks: BlogBlock[];
  /** Method notes are not attributed to the historical backtest run. */
  kind?: "method";
  sources?: { title: string; href: string }[];
}

const RUN_NOTE =
  "Recorded run date: 2026-11-01. No fees, slippage or taxes; price-only historical lab results, not live performance. Data: Yahoo Finance daily bars, 2021-11-01 through the 2026-10-30 close. Offline runs of the public repos' own engines. Past results do not predict future results. Not investment advice.";

export const BLOG_RETURN_BASIS = "Historical lab, price-only returns. No fees, slippage or taxes; not live performance.";

export const BLOG_METHOD_BASIS = "Research method note. No new performance results or live feature claim; not investment advice.";

export const BLOG_ARTICLES: BlogArticle[] = [
{
  "slug": "fresh-signal-old-prices",
  "title": "A fresh signal can still be built from old prices",
  "description": "Run time, market-bar time and retrieval time answer different questions. Check them separately before trusting a ranking.",
  "feature": "Data quality",
  "blocks": [
    {
      "kind": "p",
      "text": "A page can refresh right now and still show yesterday's analysis of last month's prices. The newest timestamp tells you when something happened, but not necessarily what happened. Before asking whether a signal is bullish, ask how old its inputs are."
    },
    {
      "kind": "h2",
      "text": "Keep three clocks separate"
    },
    {
      "kind": "list",
      "items": [
        "Market-bar time: the session the price actually describes.",
        "Computed time: when the engine ran its rules on those inputs.",
        "Retrieved time: when a page or service received the result."
      ]
    },
    {
      "kind": "p",
      "text": "A new retrieval does not create a new market bar. A new computation does not make an old return window current. If a source does not report a clock, the honest value is unknown, not the time the browser loaded."
    },
    {
      "kind": "h2",
      "text": "Read the interval, not only the headline"
    },
    {
      "kind": "p",
      "text": "For a return ranking, check both the baseline session and the final session. Two tickers can have fresh computations but different endpoints. Comparing them as one league table can reward a timing mismatch rather than price performance."
    },
    {
      "kind": "h2",
      "text": "What we changed in research code"
    },
    {
      "kind": "p",
      "text": "An unmerged NWF change checks the return snapshot date independently of signal freshness and rejects intervals that do not fit their period labels. Its tests include an old snapshot inside a freshly generated signal. This is implementation evidence, not a claim that production price feeds are repaired or the change is live."
    },
    {
      "kind": "h2",
      "text": "A practical reading checklist"
    },
    {
      "kind": "list",
      "items": [
        "Find the last underlying price date, not only the page refresh time.",
        "Check whether the return endpoints match the other rows you are comparing.",
        "Treat missing source time or an unknown price basis as missing evidence, not a neutral or zero result."
      ]
    },
    {
      "kind": "p",
      "text": "Weekends and market holidays complicate age checks. A bounded calendar tolerance can catch obvious gaps, but it is not a substitute for an exchange calendar. Past results do not predict future results. This is a method note, not investment advice."
    }
  ],
  "sources": [
    {
      "title": "NWF return-ranking implementation and review status",
      "href": "https://github.com/adamaslan/nuwrrrld-portal/pull/361"
    }
  ],
  "date": "2026-11-11",
  "kind": "method"
},
{
  "slug": "returns-splits-and-periods",
  "title": "Before ranking returns, agree on the price basis",
  "description": "A split, a dividend and a lookback label can change what a percentage means. Here is how to keep the comparison consistent.",
  "feature": "Method",
  "blocks": [
    {
      "kind": "p",
      "text": "A return starts with simple arithmetic: ending price divided by starting price, minus one. The hard part is making sure both prices describe the same thing. Sorting a precise-looking percentage does not solve that input problem."
    },
    {
      "kind": "h2",
      "text": "A split is not automatically an investment loss"
    },
    {
      "kind": "p",
      "text": "Consider an invented three-for-one split. A holding of one share at $90 becomes three shares at $30 before any market move. Looking only at the raw per-share price would show a large drop even though the value in this simplified example is unchanged. This is an arithmetic illustration, not a result for a real ticker."
    },
    {
      "kind": "p",
      "text": "A consistently split-adjusted history can remove that mechanical discontinuity. Mixing an adjusted endpoint with an unadjusted baseline can create a misleading return. A column named adjusted_close does not, by itself, prove the entire series shares one adjustment convention."
    },
    {
      "kind": "h2",
      "text": "Price return and total return are different"
    },
    {
      "kind": "p",
      "text": "Split adjustment and dividend treatment are separate choices. A price-only comparison need not include cash distributions. Total return needs an explicit treatment of those distributions and reinvestment. Name the basis rather than comparing the two as if they were interchangeable."
    },
    {
      "kind": "h2",
      "text": "Trailing month is not month-to-date"
    },
    {
      "kind": "list",
      "items": [
        "Trailing 30 calendar days looks back from the selected final date, using the declared baseline rule.",
        "Month-to-date starts at the month boundary under a stated convention.",
        "Trailing 365 calendar days is not automatically the same interval as year-to-date or a fixed number of trading sessions."
      ]
    },
    {
      "kind": "p",
      "text": "On a nontrading date, the baseline may move to a prior completed session. Show the actual endpoints and keep that rule the same across tickers. If the available history is too short, withhold the return instead of silently using a much older price."
    },
    {
      "kind": "h2",
      "text": "Verify before repairing"
    },
    {
      "kind": "p",
      "text": "An unusual number is a reason to investigate, not permission to divide a stored series by a guessed split factor. Preserve the original records, compare a declared independent reference and inspect corporate actions before proposing a repair. The current NWF work does not establish that any named ticker's stored history has been corrected."
    },
    {
      "kind": "p",
      "text": "Past results do not predict future results. The invented split example explains the calculation only; it is not investment advice or a new backtest."
    }
  ],
  "sources": [
    {
      "title": "Return validation and its unresolved history checks",
      "href": "https://github.com/adamaslan/gcp3/pull/89"
    },
    {
      "title": "NWF numeric return contract",
      "href": "https://github.com/adamaslan/nuwrrrld-portal/pull/361"
    }
  ],
  "date": "2026-11-11",
  "kind": "method"
},
{
  "slug": "confluence-is-not-probability",
  "title": "More agreeing signals do not mean more independent evidence",
  "description": "Confluence is a summary of detector agreement. Overlapping inputs can make a bigger count look more convincing than it is.",
  "feature": "Signals",
  "blocks": [
    {
      "kind": "p",
      "text": "Price above a moving average, positive recent momentum and a rising trend can all describe the same move. Counting them separately may help explain the chart. It does not make them independent witnesses."
    },
    {
      "kind": "h2",
      "text": "Ask what the score is summarizing"
    },
    {
      "kind": "p",
      "text": "A directional agreement score combines the observations a rule set emits. Its value depends on which observations are eligible, their weights and the denominator. A label such as HIGH describes that scoring rule; it is not a measured probability that the next trade will win."
    },
    {
      "kind": "h2",
      "text": "One price move can produce several observations"
    },
    {
      "kind": "p",
      "text": "A scan can inspect several moving-average windows, momentum horizons or volatility thresholds. If those recipes depend on the same price history, their agreement may be highly correlated. Adding more window variants can increase the observation count without adding a new data source."
    },
    {
      "kind": "list",
      "items": [
        "Raw observation count: what the detectors emitted.",
        "Eligible evidence: what passed source, timing and validity checks.",
        "Independent information: a stronger claim that needs evaluation, not a count of names."
      ]
    },
    {
      "kind": "h2",
      "text": "Context is useful without becoming another vote"
    },
    {
      "kind": "p",
      "text": "Distance from a moving average can tell a reader how stretched the price is relative to recent volatility. That is useful context even when there is no tested reason to turn it into a BUY or SELL vote. Our offline MA-distance research output uses zero confluence weight and is not promoted into the live signal set."
    },
    {
      "kind": "h2",
      "text": "What would justify a stronger claim?"
    },
    {
      "kind": "p",
      "text": "Freeze the rule and evaluation horizon, compare it with a baseline on later held-out data, and report failures as well as aggregate results. Account for repeated trials, overlapping windows and trading costs where a trading-performance claim is made. Until that work exists, agreement remains agreement."
    },
    {
      "kind": "p",
      "text": "Past results do not predict future results. No probability calibration, extra live detectors or performance improvement is claimed by this method note. It is not investment advice."
    }
  ],
  "sources": [
    {
      "title": "Current detector orchestration source",
      "href": "https://raw.githubusercontent.com/adamaslan/signals-app/d9cb9738dead78ea8e318f566ff6790d2590045b/src/signals_app/detection/orchestrator.py"
    },
    {
      "title": "Offline context implementation and status",
      "href": "https://github.com/adamaslan/nuwrrrld-portal/pull/361"
    }
  ],
  "date": "2026-11-11",
  "kind": "method"
},
{
  "slug": "reading-a-single-stock-scan",
  "title": "How to read a broad scan of one stock",
  "description": "Detector evaluations, observations and state changes are different counts. A useful scan shows all of them without manufacturing a target.",
  "feature": "Research",
  "blocks": [
    {
      "kind": "p",
      "text": "Running many checks against one stock can produce a useful research dossier. The first question should be what actually executed, not whether the output reached an impressive target number."
    },
    {
      "kind": "h2",
      "text": "Start with a real input snapshot"
    },
    {
      "kind": "p",
      "text": "Keep the symbol, source, completed-session dates, adjustment convention and input hash with the result. Indicators need earlier bars before the evaluation window begins. A short history should not masquerade as a full warmup, and a provider failure should not look like a clean zero-hit scan."
    },
    {
      "kind": "h2",
      "text": "Keep these counts distinct"
    },
    {
      "kind": "list",
      "items": [
        "Detector evaluations count the checks that ran on each historical bar. They are not all successful signals.",
        "Observations count emitted states or events, including neutral context. A repeated state can appear on several days.",
        "State transitions record an observed change under a stated rule. First-row initialization is not proof that a new market event occurred then.",
        "Source coverage records what was available, missing or failed. An unavailable options or news feed does not become zero evidence against a stock."
      ]
    },
    {
      "kind": "h2",
      "text": "Do not add overlapping windows"
    },
    {
      "kind": "p",
      "text": "A 21-bar summary can sit inside a 63-bar summary, which can sit inside a longer one. Adding their totals counts the same observations again. Use the windows to compare recent and longer context, not to inflate one grand total."
    },
    {
      "kind": "h2",
      "text": "What the new runner actually does"
    },
    {
      "kind": "p",
      "text": "A new unmerged signals-app runner accepts one explicit stock symbol and a local daily-price CSV. It executes the 19 currently registered detector classes on each historical prefix, keeps neutral observations and reports failures separately. A synthetic run verifies execution and accounting. It is not a real-stock result, 500 newly activated detectors or a completed 100-source research system."
    },
    {
      "kind": "h2",
      "text": "A replay must not know the future"
    },
    {
      "kind": "p",
      "text": "For each historical decision, recompute indicators using only rows available through that decision date. A useful negative control changes later prices and checks that earlier decisions stay identical. Even that test does not prove the original data was available then: provider restatements, retrospective adjustments and universe selection still need their own checks."
    },
    {
      "kind": "p",
      "text": "Past results do not predict future results. A detector occurrence is not trade profit, and this method note reports no new backtest performance or app activation. It is not investment advice."
    }
  ],
  "sources": [
    {
      "title": "Single-stock runner, tests and current review status",
      "href": "https://github.com/adamaslan/signals-app/pull/53"
    }
  ],
  "date": "2026-11-11",
  "kind": "method"
},
  {
    slug: "3019-backtest-trades",
    title: "We ran 3,019 backtest trades through our own engine",
    description:
      "Five years of daily data, 25 tickers, 3,019 trades. What the NWF lab engine did, measured end to end.",
    date: "2026-11-01",
    feature: "Hold/Fold",
    blocks: [
      {
        kind: "p",
        text: "Most trading apps ask you to trust their calls. We would rather show you the numbers. So we pointed the NuWrrrld Financial scoring engine at five years of market history and let it trade: 25 tickers, 3,019 trades, every one scored against what the market actually did next.",
      },
      {
        kind: "stats",
        items: [
          { value: "3,019", label: "trades replayed" },
          { value: "54.2%", label: "hit rate" },
          { value: "+0.47%", label: "average return per trade" },
          { value: "21 of 25", label: "tickers with a positive total" },
        ],
      },
      { kind: "h2", text: "What we ran" },
      {
        kind: "p",
        text: "The test set was 25 tickers: 10 mega-cap tech names, 10 other large companies, and 5 ETFs. We used five years of daily bars, from November 1, 2021 through the close on October 30, 2026. The rule was the engine's own: buy when the score reaches 70, hold for five trading days, and never run two trades in the same ticker at the same time.",
      },
      {
        kind: "p",
        text: "No fees, no slippage, price-only returns. We will keep saying that, because it matters: this is a clean replay, not a brokerage statement.",
      },
      { kind: "h2", text: "What happened" },
      {
        kind: "p",
        text: "54.2% of the engine's trades closed higher than they opened, with an average return of +0.47% per five-day trade. The strategy had a positive total return on 21 of the 25 tickers; it outperformed buy-and-hold on 8. One caution before anyone quotes that 54.2%: a trade hit rate has no coin-flip baseline. The chance rate for a five-day hold is not 50%, and this run did not compute a random-entry comparison, so we report the hit rate next to its average return and the buy-and-hold benchmark rather than as an edge claim.",
      },
      {
        kind: "p",
        text: "Here is the honest part. Buy and hold beat the strategy on 17 of the 25 tickers. The five years we tested were mostly a rising market, which makes simply holding a hard benchmark. Where the engine earned its keep was in names that chopped or fell: it made +159.7% on TSLA while holding lost 1%, and +83.1% on DIS while holding lost 35%.",
      },
      { kind: "h2", text: "Why we are publishing this" },
      {
        kind: "p",
        text: "Every Hold/Fold card in the app carries a score from 0 to 100. A score with no measured history is an opinion. This run is our first step toward putting a record behind it: a replay we will point to when the number helps, and when it does not.",
      },
      {
        kind: "p",
        text: "One precision worth keeping: these numbers come from an offline run of the lab engine in the NWF repo, not from the live site. We have not yet verified that the lab engine scores tickers identically to the deployed Hold/Fold path, and we will keep saying so until we have.",
      },
      { kind: "list", items: [RUN_NOTE] },
    ],
  },
  {
    slug: "hit-rate-vs-chance",
    title: "A hit rate means nothing without a chance rate",
    description:
      "Detector hit rate versus the recorded direction baseline. Why this is not a random-entry strategy test.",
    date: "2026-11-01",
    feature: "Signals",
    blocks: [
      {
        kind: "p",
        text: "Imagine a forecaster who says \"up\" every single day. In the five years we tested, that forecaster would be right about 54% of the time, because 54.2% of the daily bars across our 25 tickers rose. Impressive? No. That is just the market's base rate.",
      },
      {
        kind: "p",
        text: "One coincidence to flag, because it trips people: our strategy engine's trade hit rate in this same run was also 54.2% - but that is a different quantity, measured over five-day trades rather than daily bars. The daily-bar base rate is not its chance rate, and we do not quote a chance rate for the trade engine because this run did not compute a random-entry baseline for five-day holds.",
      },
      {
        kind: "p",
        text: "That is why a raw hit rate is the wrong question. The right question is: how much better than chance is this? The gap between a signal's hit rate and its chance rate is its edge, and edge is the only part you cannot get from a coin.",
      },
      { kind: "h2", text: "Grading our own signals engine" },
      {
        kind: "p",
        text: "We ran the signals-app engine across the same 25 tickers and five years. It replayed every detector on every daily bar and scored each directional call against the realized five-day return: 258,932 calls in total. The result: a 50.4% hit rate against a 50.4% chance rate. Edge: about zero.",
      },
      {
        kind: "p",
        text: "The plain bullish bucket hit 54.4% versus a 54.2% chance rate. The plain bearish bucket hit 45.6% versus 45.8%. Both sit close enough to chance that the honest read is this: the aggregate rounded rate was close to the recorded baseline in this window. This is not a statistical significance test.",
      },
      { kind: "h2", text: "What we do with that" },
      {
        kind: "p",
        text: "Two things. First, the backtest client behind our signals always reports the chance rate alongside the hit rate, bucket by bucket, so an impressive-looking number can never hide the base rate. Second, we treat detector output as a lead, not proof. The engine's own notes warn that overlapping windows make detector hit rates look optimistic, and this run is exactly what that warning looks like in numbers.",
      },
      {
        kind: "p",
        text: "None of this makes signals useless. It means the value has to come from how they combine, filter, and size up, not from any single detector being magic. That is what the strategy layer is for, and we measure it separately.",
      },
      { kind: "list", items: [RUN_NOTE] },
    ],
  },
  {
    slug: "buy-and-hold-benchmark",
    title: "The hardest benchmark to beat is doing nothing",
    description:
      "Our engine beat buy and hold on 8 of 25 tickers. On the other 17, holding won. Both facts belong on the label.",
    date: "2026-11-01",
    feature: "Portfolio",
    blocks: [
      {
        kind: "p",
        text: "Every backtest needs a benchmark, and ours is the most uncomfortable one available: buy the ticker on day one and do nothing for five years.",
      },
      {
        kind: "p",
        text: "The NWF strategy beat that benchmark on 8 of 25 tickers. We are printing that number up front because it is the one most apps would rather you not ask about.",
      },
      { kind: "h2", text: "Where holding won" },
      {
        kind: "p",
        text: "NVDA is the clearest case. The strategy's trades compounded to +198.6% over five years, and it won 56.7% of its trades. Buy and hold returned +692%. When a name trends up for years, stepping out every five days leaves money on the table, and no hit rate fixes that.",
      },
      {
        kind: "p",
        text: "The same pattern shows up in AMD (+186.7% for the strategy, +303% for holding), AAPL (+53.1% versus +131%), and GLD (+79.5% versus +112%).",
      },
      { kind: "h2", text: "Where the engine won" },
      {
        kind: "p",
        text: "The strategy's edge appeared where holding hurt. It made +159.7% on TSLA while holding lost 1%. It made +83.1% on DIS and +80.8% on NFLX while holding lost 35% and 9%. On TLT it lost 16.3%, but holding lost 44%.",
      },
      {
        kind: "p",
        text: "Eight wins out of 25 is not a victory lap. It is a map: the saved sample includes outperformance in some falling names and underperformance in several strong gainers. It does not establish a general market-regime rule.",
      },
      { kind: "h2", text: "Why show both numbers" },
      {
        kind: "p",
        text: "Because you will run this comparison yourself the first time a ticker you sold rallies without you. A tool that only shows its wins is marketing. The point of tracking a portfolio honestly is knowing when the tool is helping and when it is in the way.",
      },
      {
        kind: "list",
        items: [
          "One five-year window, mostly a rising market. A different window could flip these comparisons.",
          "Strategy totals compound non-overlapping five-day trades with no capital constraint. Real accounts have limits.",
          RUN_NOTE,
        ],
      },
    ],
  },
  {
    slug: "where-the-engine-lost",
    title: "Where the engine lost money",
    description:
      "PFE, META, TLT, MSFT: the four losers in our 25-ticker backtest, and what each one teaches.",
    date: "2026-11-01",
    feature: "Risk",
    blocks: [
      {
        kind: "p",
        text: "The engine had a positive total return on 21 of 25 tickers, not 21 benchmark wins. This article is about the other four, because losses teach more than wins.",
      },
      { kind: "h2", text: "PFE: the worst hit rate" },
      {
        kind: "p",
        text: "43.1% of PFE trades worked. The average trade lost 0.35%, and the strategy ended down 34.1%, worse than holding, which lost 30%. When a signal keeps buying dips in a name that keeps falling, a five-day hold does not save you. It gets run over in installments.",
      },
      { kind: "h2", text: "META: the deepest drawdown" },
      {
        kind: "p",
        text: "META's strategy ended nearly flat at -2.6%, but the path was rough: a -58.7% maximum drawdown along the way. A result that looks fine at the end can be unlivable in the middle. That is why we report drawdown next to return.",
      },
      { kind: "h2", text: "MSFT and TLT: hit rate is not return" },
      {
        kind: "p",
        text: "MSFT won 56.1% of its trades and still lost 14.6%, because the average trade returned -0.03%: many small wins, a few larger losses. TLT won only 46.5% of the time and lost 16.3%, though holding was worse at -44%. Win frequency and win size are different things, and a strategy needs both.",
      },
      { kind: "h2", text: "What this changes in the product" },
      {
        kind: "p",
        text: "This is why the AI council includes a seat whose whole job is to argue against the trade, and why a useful verdict should name what would prove it wrong. A backtest cannot feel pain. Your account can. The losses in this table are the case for building the skeptic in from the start.",
      },
      {
        kind: "list",
        items: [
          "PFE: 43.1% hit, -34.1% total, -43.9% max drawdown",
          "META: 53.7% hit, -2.6% total, -58.7% max drawdown",
          "TLT: 46.5% hit, -16.3% total, -17.4% max drawdown",
          "MSFT: 56.1% hit, -14.6% total, -33.6% max drawdown",
          RUN_NOTE,
        ],
      },
    ],
  },
  {
    slug: "etf-results",
    title: "What five years of ETF backtests showed",
    description:
      "SPY, QQQ, IWM, GLD, TLT: steadier tickers, steadier curves, and one clear weak spot.",
    date: "2026-11-01",
    feature: "Signals",
    blocks: [
      {
        kind: "p",
        text: "The app tracks 54 sector and industry ETFs, so we held the engine to that same standard: five of the most traded ETFs, five years, the same rules as the stocks.",
      },
      { kind: "h2", text: "The numbers" },
      {
        kind: "table",
        caption: "NWF lab engine replay, 2021-11-01 to 2026-10-30. No fees or slippage.",
        columns: ["Ticker", "Hit rate", "Strategy total", "Buy and hold", "Max drawdown"],
        rows: [
          ["QQQ", "62.4%", "+58.8%", "+78%", "-14.9%"],
          ["SPY", "58.5%", "+45.1%", "+64%", "-8.7%"],
          ["IWM", "52.1%", "+41.3%", "+19%", "-11.7%"],
          ["GLD", "54.2%", "+79.5%", "+112%", "-9.9%"],
          ["TLT", "46.5%", "-16.3%", "-44%", "-17.4%"],
        ],
      },
      { kind: "h2", text: "What stands out" },
      {
        kind: "p",
        text: "QQQ produced the best hit rate of all 25 tickers we tested, stocks included: 62.4%. That is a result for this chosen sample and window, not evidence that liquidity or headlines caused the difference.",
      },
      {
        kind: "p",
        text: "The drawdowns tell the same story. The worst equity-curve dip among these five ETFs was -17.4%. Among the 20 single stocks, the deepest drawdowns ran to -47%, -52%, and -59%. The strategy did not remove risk anywhere, and these five saved ETF drawdowns were smaller than the largest single-stock drawdowns.",
      },
      {
        kind: "p",
        text: "TLT was the weak spot. Bonds spent much of this window falling, holding lost 44%, and the engine limited the damage to -16.3%. Limiting damage is worth something. It is not the same as making money.",
      },
      { kind: "h2", text: "Why we care about the ETF layer" },
      {
        kind: "p",
        text: "The product includes sector and industry ETFs. This five-ETF sample offers a limited comparison of recorded hit rates and drawdowns; it does not establish that the scoring approach generalizes or that ETFs suit every investor.",
      },
      { kind: "list", items: [RUN_NOTE] },
    ],
  },
  {
    slug: "how-the-strategy-trades",
    title: "How the NWF backtest engine decides to trade",
    description:
      "Score 70 to buy, five days to hold, no overlapping trades. The exact rules behind our 3,019-trade replay.",
    date: "2026-11-01",
    feature: "Hold/Fold",
    blocks: [
      {
        kind: "p",
        text: "A backtest is only as trustworthy as its rules are boring. Here is the entire rulebook for the run behind these articles.",
      },
      { kind: "h2", text: "The setup" },
      {
        kind: "list",
        items: [
          "Universe: 25 tickers (10 mega-cap tech, 10 other large companies, 5 ETFs)",
          "Data: Yahoo Finance daily bars, 2021-11-01 through 2026-10-30, about 1,255 bars per ticker",
          "Warmup: the first 60 bars of each series only feed the indicators; no trades",
          "Costs: none modeled. No fees, no slippage, price-only returns",
        ],
      },
      { kind: "h2", text: "The rules" },
      {
        kind: "list",
        items: [
          "The engine scores each ticker from 0 to 100 on every bar",
          "Score reaches 70 or higher: buy at that close",
          "Hold exactly 5 trading days, then exit",
          "No overlapping trades: while a trade is open, new buy signals are ignored",
          "A trade is a hit if it closes higher than it opened",
        ],
      },
      { kind: "h2", text: "What the score is made of" },
      {
        kind: "p",
        text: "The score combines four inputs with equal weight. The repo's own documentation is blunt about the limits of this: the 0 to 100 score reaches only nine discrete values, and those four inputs were never fitted to outcomes. We are quoting that criticism because it is ours, written before this backtest, and it is why measurement work like this run exists.",
      },
      { kind: "h2", text: "What this design gets right and wrong" },
      {
        kind: "p",
        text: "Right: the rules are simple enough to audit, the declared design uses only information available by each bar, but no independent lookahead audit is established here, and no trade can hide inside another trade. Wrong: equal weights and nine discrete scores make a blunt instrument, and a five-day clock is a crude exit. A name that would keep running for a month still gets sold on day five.",
      },
      {
        kind: "p",
        text: "Both lists are the point. Before the engine gets smarter, it gets measured.",
      },
      { kind: "list", items: [RUN_NOTE] },
    ],
  },
  {
    slug: "what-backtests-leave-out",
    title: "What this backtest leaves out",
    description:
      "No fees, no slippage, one market window, free data. The honest gaps in our own numbers.",
    date: "2026-11-01",
    feature: "Method",
    blocks: [
      {
        kind: "p",
        text: "Every backtest lies a little. The honest ones say where. Here is what our 25-ticker, five-year replay does not include.",
      },
      { kind: "h2", text: "Costs" },
      {
        kind: "p",
        text: "No fees, no slippage, no taxes. The strategy traded 3,019 times, and in the real world each of those trades costs something. With an average gross return of +0.47% per trade, even small costs take a real bite.",
      },
      { kind: "h2", text: "One window, one regime" },
      {
        kind: "p",
        text: "We tested November 2021 through October 2026, a stretch that was mostly a rising market. That flatters buy and hold as a benchmark and tells us little about a long bear market or a sideways decade. One window is a starting point, not a verdict.",
      },
      { kind: "h2", text: "Compounding without constraints" },
      {
        kind: "p",
        text: "The strategy totals compound non-overlapping five-day trades with no capital constraint. Real accounts have one pile of money, position limits, and days when two good signals fight for the same dollars.",
      },
      { kind: "h2", text: "Data quirks" },
      {
        kind: "p",
        text: "Both engines read Yahoo Finance daily bars, and Yahoo's adjustment can differ slightly between code paths. We also saw a nine-call difference between two runs of the same data fetched minutes apart: 258,941 calls in one run, 258,932 in the other, with hits at 130,507 vs 130,501. Small, but worth knowing before you worship a decimal.",
      },
      { kind: "h2", text: "The biggest gap" },
      {
        kind: "p",
        text: "These numbers come from the lab engine in the repo, run offline. We have not verified that it scores tickers identically to the live site's deployed path, so treat these as the repo engine's results, not the site's. And the standing rule applies: past results do not predict future results.",
      },
      { kind: "list", items: [RUN_NOTE] },
    ],
  },
  {
    slug: "why-track-record-is-dark",
    title: "Why the live site does not show a track record yet",
    description:
      "The Track Record badge exists and the backtest route answers, and we still keep it dark. On purpose.",
    date: "2026-11-01",
    feature: "Track Record",
    blocks: [
      {
        kind: "p",
        text: "If you have clicked around the app's Hold/Fold pages, you may have noticed there is no track record shown. That is not a bug and it is not an oversight. It is a decision.",
      },
      { kind: "h2", text: "What we verified on November 1" },
      {
        kind: "p",
        text: "Signed in, we asked the live site for Apple's backtest data. The route answered 204, its documented way of saying there is no data to show. The track record section on the page was empty. In the repo, the backtest hit-rate flag is set to off by default.",
      },
      {
        kind: "p",
        text: "We cannot tell from the outside which of these is the specific cause on the deployed site, and we are not going to guess. What is observed: no backtest data is shown on the live site today.",
      },
      { kind: "h2", text: "Why dark is the default" },
      {
        kind: "p",
        text: "The backtest client in the repo refuses to hardcode an engine address it has not confirmed is live. If the engine is unset, unreachable, slow, or answers in a shape the code does not recognize, the badge simply does not render. Every failure collapses to the same quiet nothing instead of a wrong number.",
      },
      {
        kind: "p",
        text: "The alternative, showing hit rates from an unverified engine, is worse than showing nothing. The repo's own documentation puts it sharply: while the validation surface is dark, no score anywhere has a measured hit rate behind it. We would rather tell you that than decorate it.",
      },
      { kind: "h2", text: "What happens next" },
      {
        kind: "p",
        text: "The run behind these articles is the first step: real numbers from the repo's lab engine, published with their method and their caveats. Next is verifying whether the lab engine matches the live scoring path. Only then does a track record earn its place on the page.",
      },
      { kind: "list", items: [RUN_NOTE] },
    ],
  },
  {
    slug: "signals-vs-strategies",
    title: "Two engines, two questions",
    description:
      "Our signals engine scored 258,932 detector calls. Our strategy engine placed 3,019 trades. Why the numbers cannot be compared directly.",
    date: "2026-11-01",
    feature: "Signals",
    blocks: [
      {
        kind: "p",
        text: "We ran two backtests on the same 25 tickers and the same five years, and they answered different questions. Mixing them up is the easiest way to fool yourself with a backtest.",
      },
      { kind: "h2", text: "The signals engine asks: was this call right?" },
      {
        kind: "p",
        text: "The signals engine replays every detector on every daily bar and grades each directional call against the next five days. It made 258,932 calls and hit 50.4%, against a chance rate of 50.4%. Its unit of measurement is the call, and calls overlap: the same price move gets scored many times through different windows.",
      },
      { kind: "h2", text: "The strategy engine asks: would this trade have made money?" },
      {
        kind: "p",
        text: "The NWF engine places sparse, sequential trades: buy at a score of 70, hold five days, one trade at a time. It placed 3,019 trades and hit 54.2%, with an average return of +0.47% per trade. Its unit of measurement is the trade, with an entry, an exit, and an equity curve.",
      },
      { kind: "h2", text: "Why 50.4% and 54.2% are not a fair fight" },
      {
        kind: "list",
        items: [
          "Detector calls overlap, so their hit rate counts correlated windows as independent results. The engine's own notes call this optimistic.",
          "The strategy only counts realized trades, each with capital committed and time at risk.",
          "The fair reads are edge versus chance for detectors, and return versus buy and hold for the strategy. Comparing the two hit rates head to head is apples to orchards.",
        ],
      },
      { kind: "h2", text: "Why we run both anyway" },
      {
        kind: "p",
        text: "Because they catch different failures. Detectors that cannot beat chance need better filters, not better marketing. A strategy that cannot beat holding needs a different job, like risk control in falling markets, where this one happened to earn its keep. Each engine keeps the other honest.",
      },
      { kind: "list", items: [RUN_NOTE] },
    ],
  },
  {
    slug: "reproduce-this-backtest",
    title: "Check these saved backtest numbers",
    description:
      "The engines are public. Check the saved per-ticker arithmetic and read the method and reproduction limits.",
    date: "2026-11-01",
    feature: "Open source",
    blocks: [
      {
        kind: "p",
        text: "Every historical backtest number in this article comes from one recorded run on November 1, 2026. The two engines are public repos and the price data is free, but the exact comparison script and raw output files currently live in a private documentation repo. We would rather say that plainly than promise a one-command replay that does not exist today. The linked public evidence file contains the saved per-ticker aggregates used by the headline checks. The method below describes the intended run, but it is not a verified one-command reproduction.",
      },
      { kind: "h2", text: "The method, precisely" },
      {
        kind: "list",
        items: [
          "Data: Yahoo Finance daily bars for 25 tickers, 2021-11-01 through the 2026-10-30 close. Free to download.",
          "Strategy engine (in the public nuwrrrld-portal repo, tools/nwf-lab): buy when the score reaches 70, hold five trading days, never two trades in the same ticker at once, 60-bar warmup before the first score. No fees, no slippage, price-only returns.",
          "Signals engine (public signals-app repo): replay every detector on every daily bar, grade each directional call against the realized five-day return, and report the chance rate as the base rate of the same bucket.",
          "Our exact harness (run_backtests.py) and raw outputs (results.json, signals_api_run.json) are in a private docs repo today; if they get published we will link them here.",
        ],
      },
      { kind: "h2", text: "The full results" },
      {
        kind: "table",
        caption: "NWF lab engine replay, 25 tickers, 2021-11-01 to 2026-10-30. No fees or slippage, price-only returns.",
        columns: ["Ticker", "Trades", "Hit rate", "Avg per trade", "Strategy total", "Max drawdown", "Buy and hold"],
        rows: [
          ["AAPL", "129", "57.4%", "+0.40%", "+53.1%", "-30.6%", "+131%"],
          ["MSFT", "123", "56.1%", "-0.03%", "-14.6%", "-33.6%", "+58%"],
          ["NVDA", "134", "56.7%", "+1.04%", "+198.6%", "-44.2%", "+692%"],
          ["GOOGL", "123", "54.5%", "+0.61%", "+84.2%", "-29.5%", "+95%"],
          ["AMZN", "123", "54.5%", "+0.37%", "+34.5%", "-28.5%", "+45%"],
          ["TSLA", "118", "50.0%", "+1.08%", "+159.7%", "-36.9%", "-1%"],
          ["META", "123", "53.7%", "+0.21%", "-2.6%", "-58.7%", "+86%"],
          ["JPM", "133", "60.2%", "+0.56%", "+96.3%", "-24.2%", "+98%"],
          ["XOM", "133", "52.6%", "+0.09%", "+2.9%", "-41.6%", "+185%"],
          ["JNJ", "118", "53.4%", "+0.17%", "+17.3%", "-20.5%", "+68%"],
          ["WMT", "137", "55.5%", "+0.31%", "+45.2%", "-23.4%", "+147%"],
          ["KO", "126", "52.4%", "+0.16%", "+19.6%", "-14.4%", "+67%"],
          ["PFE", "102", "43.1%", "-0.35%", "-34.1%", "-43.9%", "-30%"],
          ["CAT", "125", "58.4%", "+0.82%", "+143.2%", "-21.3%", "+203%"],
          ["BA", "109", "51.4%", "+0.20%", "+10.3%", "-36.5%", "-20%"],
          ["DIS", "96", "50.0%", "+0.73%", "+83.1%", "-27.4%", "-35%"],
          ["NFLX", "114", "56.1%", "+0.68%", "+80.8%", "-32.7%", "-9%"],
          ["AMD", "124", "55.6%", "+1.26%", "+186.7%", "-51.7%", "+303%"],
          ["INTC", "109", "47.7%", "+1.35%", "+193.7%", "-47.4%", "+33%"],
          ["T", "114", "55.3%", "+0.54%", "+71.8%", "-18.5%", "+12%"],
          ["SPY", "135", "58.5%", "+0.29%", "+45.1%", "-8.7%", "+64%"],
          ["QQQ", "133", "62.4%", "+0.38%", "+58.8%", "-14.9%", "+78%"],
          ["IWM", "119", "52.1%", "+0.33%", "+41.3%", "-11.7%", "+19%"],
          ["GLD", "120", "54.2%", "+0.52%", "+79.5%", "-9.9%", "+112%"],
          ["TLT", "99", "46.5%", "-0.16%", "-16.3%", "-17.4%", "-44%"],
        ],
      },
      { kind: "h2", text: "Expect small differences" },
      {
        kind: "p",
        text: "Yahoo's data can shift slightly between runs, and our own two runs differed by nine calls out of roughly 259,000 (258,941 vs 258,932). The engine repos are public, so the scoring and detector logic behind every number here can be read directly - that is the part we will always keep inspectable.",
      },
      { kind: "list", items: [RUN_NOTE] },
    ],
  },
];

export function getBlogArticle(slug: string): BlogArticle | undefined {
  return BLOG_ARTICLES.find((a) => a.slug === slug);
}
