import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { adaptLiveSignals } from "@/lib/digest";
import "./landing.css";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";

interface CouncilSample {
  shortTerm?: { answer?: string };
  longTerm?: { answer?: string };
  generatedAt?: string;
}

async function fetchCouncilSample(): Promise<CouncilSample | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  try {
    const { callCouncilSeat } = await import("@/lib/openrouter");
    const [t1, t2] = await Promise.all([
      callCouncilSeat("T1", "Analyze SPY for current market conditions. Provide a concise, grounded assessment.", apiKey),
      callCouncilSeat("T2", "Analyze SPY for current market conditions. Provide a concise, grounded assessment.", apiKey),
    ]);
    return { shortTerm: t1, longTerm: t2, generatedAt: new Date().toISOString() };
  } catch { return null; }
}

async function fetchLandingData() {
  const fetchWithTimeout = async (url: string, cache: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      return await fetch(url, { signal: controller.signal, next: { revalidate: cache } });
    } finally { clearTimeout(timer); }
  };

  const [mktRes, sigRes, council] = await Promise.allSettled([
    fetchWithTimeout(`${MCP_URL}/market-overview`, 3600),
    fetchWithTimeout(`${MCP_URL}/signals`, 3600),
    fetchCouncilSample(),
  ]);
  const market = mktRes.status === "fulfilled" && mktRes.value.ok
    ? await mktRes.value.json().catch(() => null)
    : null;
  const sigRaw = sigRes.status === "fulfilled" && sigRes.value.ok
    ? await sigRes.value.json().catch(() => null)
    : null;
  const digest = sigRaw ? adaptLiveSignals(sigRaw) : null;
  const topSignals = digest
    ? [...digest.signals].sort((a, b) => {
        const score = (s: typeof a) => s.confidence === "high" ? 3 : s.confidence === "medium" ? 2 : 1;
        return score(b) - score(a);
      }).slice(0, 4)
    : null;
  const councilData: CouncilSample | null = council.status === "fulfilled" ? council.value : null;
  return { market, topSignals, council: councilData };
}

// Signed-out visitors get the marketing landing (mirrors
// gcp3-mobile/landing/index3.html); signed-in users go straight to the tooling.
export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  const { market, topSignals, council } = await fetchLandingData();

  return (
    <div className="nwf-landing">
      <nav className="topbar" aria-label="Primary navigation">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">NWF</span>
          <span>NuWrrrld Financial</span>
        </Link>
        <div className="navlinks">
          <a href="#product">Product</a>
          <Link href="/signals">Signals</Link>
          <Link href="/portfolio-intelligence">Portfolio</Link>
          <a href="#council">Council</a>
          <Link className="nav-keep" href="/sign-in">Sign in</Link>
          <Link className="nav-action" href="/sign-up">Create account</Link>
        </div>
      </nav>

      <header className="hero">
        <div className="market-wall" aria-hidden="true" />
        <div className="hero-inner">
          <div className="eyebrow">Advanced AI-Native Financial Tools</div>
          <h1>
            <span>NuWrrrld</span> <span>Financial</span>
          </h1>
          <p className="hero-copy">
            The caring command center for active investors — market briefings, macro regime reads,
            signal matrices, Hold/Fold trade verdicts, and an AI council that reasons across every
            horizon from one day to five years.
          </p>
          <div className="hero-actions">
            <Link className="btn primary" href="/sign-up">Create your account</Link>
            <a className="btn secondary" href="#engine">Explore the engine</a>
          </div>

          <div className="product-stage" aria-label="NuWrrrld Financial product preview">
            <div className="phone side">
              <div className="screen">
                <div className="statusbar"><span>9:41</span><span>Briefing</span></div>
                <div className="app-title"><strong>Macro Pulse</strong><span className="pill">Bullish</span></div>
                <div className="brief-card">
                  <div className="label">Regime score</div>
                  <div className="big-number up">+0.42</div>
                  <p className="brief-text">Risk appetite is improving as breadth expands and volatility cools.</p>
                </div>
                <div className="mini-grid">
                  <div className="mini-card"><strong className="up">72%</strong><span>Breadth</span></div>
                  <div className="mini-card"><strong className="down">-3.1%</strong><span>VIX</span></div>
                  <div className="mini-card"><strong className="up">+18</strong><span>McClellan</span></div>
                  <div className="mini-card"><strong className="flat">Neutral</strong><span>Rates</span></div>
                </div>
              </div>
            </div>

            <div className="phone main">
              <div className="screen">
                <div className="statusbar"><span>9:41</span><span>NuWrrrld Financial</span></div>
                <div className="app-title"><strong>Market Briefing</strong><span className="pill">Live</span></div>
                {market?.indices?.SPY != null ? (
                  <>
                    <div className="brief-card">
                      <div className="label">S&P 500</div>
                      <div className={`big-number ${(market.indices.SPY.change_pct ?? 0) >= 0 ? "up" : "down"}`}>
                        {market.indices.SPY.price?.toLocaleString() ?? "—"}
                      </div>
                      {market?.brief?.summary && (
                        <p className="brief-text">{market.brief.summary}</p>
                      )}
                    </div>
                    <div className="mini-grid">
                      {["QQQ", "DIA", "IWM"].map((sym) => {
                        const idx = market?.indices?.[sym];
                        return (
                          <div key={sym} className="mini-card">
                            <strong>{sym}</strong>
                            <span className={idx?.change_pct != null && idx.change_pct >= 0 ? "up" : "down"}>
                              {idx?.change_pct != null
                                ? `${idx.change_pct >= 0 ? "+" : ""}${idx.change_pct.toFixed(2)}%`
                                : "—"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="brief-card">
                    <p className="brief-text">Market data loading…</p>
                  </div>
                )}
              </div>
            </div>

            <div className="phone side right">
              <div className="screen">
                <div className="statusbar"><span>9:41</span><span>Signals</span></div>
                <div className="app-title">
                  <strong>Today</strong>
                  <span className="pill">{topSignals ? `${topSignals.length} reads` : "Live"}</span>
                </div>
                <div className="brief-card">
                  {topSignals ? topSignals.map((sig) => {
                    const pct = sig.confidence === "high" ? 91 : sig.confidence === "medium" ? 65 : 40;
                    const cls = sig.direction === "bullish" ? "up" : sig.direction === "bearish" ? "down" : "flat";
                    const label = sig.direction === "bullish" ? "BUY" : sig.direction === "bearish" ? "SELL" : "HOLD";
                    return (
                      <div key={sig.id} className="signal-row">
                        <b>{sig.ticker}</b>
                        <div className="bar"><span style={{ width: `${pct}%` }} /></div>
                        <span className={cls}>{label}</span>
                      </div>
                    );
                  }) : (
                    <>
                      <div className="signal-row"><b>NVDA</b><div className="bar"><span style={{ width: "91%" }} /></div><span className="up">BUY</span></div>
                      <div className="signal-row"><b>MSFT</b><div className="bar"><span style={{ width: "74%" }} /></div><span className="up">BUY</span></div>
                      <div className="signal-row"><b>TSLA</b><div className="bar"><span style={{ width: "58%" }} /></div><span className="flat">HOLD</span></div>
                      <div className="signal-row"><b>XLE</b><div className="bar"><span style={{ width: "36%" }} /></div><span className="down">SELL</span></div>
                    </>
                  )}
                </div>
                <div className="council-bubble">Signal confidence compresses technical, macro, sector, sentiment, and event evidence.</div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="peek-band" aria-label="Key platform metrics">
        <div className="metric"><strong>6</strong><span>AI council modes across short and long horizons.</span></div>
        <div className="metric"><strong>138</strong><span>Signal outputs normalized into decisions.</span></div>
        <div className="metric"><strong>380+</strong><span>Data points compressed per symbol read.</span></div>
        <div className="metric"><strong>Live</strong><span>One account for web tools and the mobile app.</span></div>
      </div>

      <section id="product">
        <div className="wrap">
          <div className="section-head">
            <div>
              <div className="kicker">One workflow, web and mobile</div>
              <h2>From market state to trade decision without leaving the app.</h2>
            </div>
            <p className="section-copy">
              One caring workflow for active investors: daily briefing, macro context, tactical signals,
              Hold/Fold reads, and council chat — in the browser here, and in the NuWrrrld mobile app.
            </p>
          </div>

          <div className="surface-grid">
            <article className="surface wide">
              <h3>Market Briefing</h3>
              <p>Start with the state of the tape: index levels, macro regime, sector leadership, sentiment, and an AI-written briefing grounded in live backend data.</p>
              <ul className="feature-list">
                <li>Regime score and AI summary before the open.</li>
                <li>Sector leadership and breadth at a glance.</li>
              </ul>
            </article>
            <article className="surface">
              <h3>Signal Feed</h3>
              <p>Ranked buy, sell, and hold outputs with confidence and rationale — the first pass before deeper analysis.</p>
              <ul className="feature-list">
                <li>Normalized ticker decisions.</li>
                <li>Confidence scores and reason snippets.</li>
              </ul>
            </article>
            <article className="surface">
              <h3>Hold/Fold</h3>
              <p>Tactical verdicts for trades: bias, risk, volatility regime, primary signal, and supporting evidence.</p>
              <ul className="feature-list">
                <li>Verdict, confidence, and risk.</li>
                <li>ATR, RSI, MACD, ADX context.</li>
              </ul>
            </article>
            <article className="surface wide">
              <h3>AI Council Chat</h3>
              <p>Ask the app to reason like a council: short-term trader, long-term investor, or agreement synthesis across both — with exact data citations and horizon-specific invalidation levels required.</p>
              <ul className="feature-list">
                <li>Short term: 1 day to 60 days. Long term: 2 months to 5 years.</li>
                <li>Conflicts named and resolved into sizing logic.</li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      <section id="engine" className="engine">
        <div className="wrap">
          <div className="section-head">
            <div>
              <div className="kicker">Robust signals · proprietary data</div>
              <h2>A decision layer built from many independent reads, not one loud indicator.</h2>
            </div>
            <p className="section-copy">
              Five independent evidence families back every verdict — technicals, volatility, macro regime,
              sector rotation, and events — so any single read can fail and the decision still holds.
            </p>
          </div>

          <div className="matrix" role="img" aria-label="Example signal matrix with decisions across time horizons">
            <div className="matrix-head">
              <strong>Signal Matrix - NVDA</strong>
              <span className="pill">380+ inputs</span>
            </div>
            <div className="matrix-scroll">
              <div className="matrix-grid">
                <div className="matrix-cell head">Signal</div>
                <div className="matrix-cell head">1D</div>
                <div className="matrix-cell head">5D</div>
                <div className="matrix-cell head">1M</div>
                <div className="matrix-cell head">3M</div>
                <div className="matrix-cell head">1Y</div>
                <div className="matrix-cell head">Conf</div>

                <div className="matrix-cell name">RSI + divergence</div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell mono">0.87</div>

                <div className="matrix-cell name">MACD cross state</div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell mono">0.91</div>

                <div className="matrix-cell name">Breadth and sector relative</div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell mono">0.82</div>

                <div className="matrix-cell name">Macro regime stress</div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell mono">0.74</div>

                <div className="matrix-cell name">Event and earnings drift</div>
                <div className="matrix-cell"><span className="verdict sell">SELL</span></div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict buy">BUY</span></div>
                <div className="matrix-cell"><span className="verdict hold">HOLD</span></div>
                <div className="matrix-cell mono">0.69</div>
              </div>
            </div>
          </div>

          <div className="moat-grid">
            <div className="moat-card">
              <h3>Robust by architecture</h3>
              <p>138 signal outputs from 380+ data points per symbol, with confidence, horizon fit, and an explicit invalidation level on every verdict.</p>
              <ul className="feature-list">
                <li>Five independent evidence families per decision.</li>
                <li>Council answers must cite exact data before you act.</li>
              </ul>
            </div>
            <div className="moat-card">
              <h3>A dataset nobody else has</h3>
              <p>Every verdict, council reasoning chain, and daily regime score is logged into an append-only proprietary dataset that compounds with every market day.</p>
              <ul className="feature-list">
                <li>Verdict ledger → publishable rolling hit-rates.</li>
                <li>Horizon-tagged council corpus and regime archive.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section id="council">
        <div className="wrap">
          <div className="section-head">
            <div>
              <div className="kicker">AI council</div>
              <h2>One question, multiple time horizons, explicit disagreement.</h2>
            </div>
            <p className="section-copy">
              The council does not just summarize. It forces the short-term and long-term views to cite data,
              name invalidation points, and reconcile conflicts before a user acts.
            </p>
          </div>

          <div className="council-layout">
            <article className="council-panel">
              <h3>Short-term council</h3>
              <p className="section-copy">For tactical trades: speed, range, catalyst timing, and technical invalidation.</p>
              {council?.shortTerm?.answer ? (
                <div className="council-live-output">
                  <div className="council-live-label">SPY · live sample</div>
                  <p>{council.shortTerm.answer}</p>
                </div>
              ) : (
                <div className="horizon-grid">
                  <div className="horizon"><b>1 day</b><span>Next-session momentum and range.</span></div>
                  <div className="horizon"><b>2-5 days</b><span>Swing setup and catalyst timing.</span></div>
                  <div className="horizon"><b>1-4 weeks</b><span>Trend strength and regime quality.</span></div>
                  <div className="horizon"><b>30-60 days</b><span>Durability, volatility, and macro risk.</span></div>
                </div>
              )}
            </article>

            <article className="council-panel">
              <h3>Long-term council</h3>
              <p className="section-copy">For allocation decisions: earnings, trend, cycle, and structural horizons.</p>
              {council?.longTerm?.answer ? (
                <div className="council-live-output">
                  <div className="council-live-label">SPY · live sample</div>
                  <p>{council.longTerm.answer}</p>
                </div>
              ) : (
                <div className="horizon-grid">
                  <div className="horizon"><b>2-3 months</b><span>Tactical and earnings-cycle read.</span></div>
                  <div className="horizon"><b>6-12 months</b><span>Sector rotation and trend regime.</span></div>
                  <div className="horizon"><b>1-3 years</b><span>Business cycle and macro phase.</span></div>
                  <div className="horizon"><b>3-5 years</b><span>Structural shift or cyclical noise.</span></div>
                </div>
              )}
            </article>
          </div>
        </div>
      </section>

      <section id="access" className="cta">
        <div className="wrap">
          <div className="kicker">Start today</div>
          <h2>Give every market question a council, not just a chart.</h2>
          <p>
            One account unlocks the web tools here and the NuWrrrld Financial mobile app — a repeatable
            decision workflow for market state, signal evidence, horizon conflict, and a plan you can revisit.
          </p>
          <div className="hero-actions">
            <Link className="btn primary" href="/sign-up">Create your account</Link>
            <Link className="btn secondary" href="/sign-in">Sign in</Link>
          </div>
        </div>
      </section>

      <footer>
        <span>NWF · NuWrrrld Financial</span>
        <span>Advanced AI-Native Financial Tools · Smart · Avant-garde · Caring</span>
      </footer>
    </div>
  );
}
