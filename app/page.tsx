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
  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://financial.nuwrrrld.com";
    const res = await fetch(`${base}/api/council/sample`, {
      next: { revalidate: 21600 },
    });
    if (!res.ok) return null;
    return await res.json() as CouncilSample;
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
          <Link href="/ai-assistant">Nu AI</Link>
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
            The caring command center for active investors — live market briefings, macro regime reads,
            signal matrices with data quality scores, per-signal Ask Anything chat, and a six-seat AI council
            that reasons across every horizon from one day to five years.
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
                      <p className="sample-data-tag">Sample data — live backend unavailable</p>
                      <div className="signal-row"><b>NVDA</b><div className="bar"><span style={{ width: "91%" }} /></div><span className="up">BUY</span></div>
                      <div className="signal-row"><b>MSFT</b><div className="bar"><span style={{ width: "74%" }} /></div><span className="up">BUY</span></div>
                      <div className="signal-row"><b>TSLA</b><div className="bar"><span style={{ width: "58%" }} /></div><span className="flat">HOLD</span></div>
                      <div className="signal-row"><b>XLE</b><div className="bar"><span style={{ width: "36%" }} /></div><span className="down">SELL</span></div>
                    </>
                  )}
                </div>
                <div className="council-bubble">Signal quality scores compress technical, macro, sector, sentiment, and event evidence into a single 0–1 read.</div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="peek-band" aria-label="Key platform metrics">
        <div className="metric"><strong>6</strong><span>AI council seats — T1, T2, Risk, Macro, Quant, Chair.</span></div>
        <div className="metric"><strong>138</strong><span>Signal outputs normalized into scored decisions.</span></div>
        <div className="metric"><strong>380+</strong><span>Data points compressed per symbol read.</span></div>
        <div className="metric"><strong>Live</strong><span>One account for web tools and the mobile app.</span></div>
      </div>

      {/* ── What's New banner ── */}
      <div className="whats-new-band">
        <div className="wrap whats-new-inner">
          <span className="whats-new-label">What&apos;s new</span>
          <div className="whats-new-items">
            <span className="wn-chip">Six-seat AI council</span>
            <span className="wn-chip">Ask Anything per signal</span>
            <span className="wn-chip">Data quality scores</span>
            <span className="wn-chip">Track-record &amp; backtest display</span>
            <span className="wn-chip">Free-tier model chain</span>
            <span className="wn-chip">Neon dark theme</span>
          </div>
        </div>
      </div>

      <section id="product">
        <div className="wrap">
          <div className="section-head">
            <div>
              <div className="kicker">One workflow, web and mobile</div>
              <h2>From market state to trade decision without leaving the app.</h2>
            </div>
            <p className="section-copy">
              Daily briefing, macro context, scored signals, Hold/Fold reads, per-signal Ask Anything chat,
              and full council deliberation — in the browser here, and in the NuWrrrld mobile app.
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
              <p>Ranked buy, sell, and hold outputs with confidence scores, data quality ratings, and rationale — backed by a rolling track record from the signals engine.</p>
              <ul className="feature-list">
                <li>Data quality score (0–1) on every signal.</li>
                <li>Backtest hit-rates from the signals-app engine.</li>
              </ul>
            </article>
            <article className="surface">
              <h3>Ask Anything</h3>
              <p className="new-badge-inline">New</p>
              <p>Expand any signal and ask it a question. A tool-using agent grounded in that signal&apos;s live data answers with citations — no context switching required.</p>
              <ul className="feature-list">
                <li>Per-signal streaming chat, abort-safe.</li>
                <li>Grounded in the signal&apos;s own data — not generic AI.</li>
              </ul>
            </article>
            <article className="surface wide">
              <h3>Six-Seat AI Council</h3>
              <p>The council expanded from two voices to six specialized seats. Each seat is required to cite exact data and name its invalidation point before a user can act on the synthesis.</p>
              <ul className="feature-list">
                <li>T1 (short-term) · T2 (long-term) · RISK (devil&apos;s advocate) · MACRO (rates &amp; rotation) · QUANT (data-only) · CHAIR (synthesis &amp; verdict).</li>
                <li>Conflicts are named and resolved into a structured JSON verdict with direction, confidence, and invalidation level.</li>
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
              <strong>Signal Matrix — NVDA</strong>
              <span className="pill">380+ inputs · quality score: 0.91</span>
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
              <p>138 signal outputs from 380+ data points per symbol, each carrying a data quality score (0–1), confidence, horizon fit, and an explicit invalidation level. Backtest hit-rates surface directly on every signal card.</p>
              <ul className="feature-list">
                <li>Five independent evidence families per decision.</li>
                <li>Council answers must cite exact data before you act.</li>
              </ul>
            </div>
            <div className="moat-card">
              <h3>A dataset nobody else has</h3>
              <p>Every verdict, council reasoning chain, daily regime score, and data quality rating is logged into an append-only proprietary dataset that compounds with every market day.</p>
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
              <div className="kicker">Six-seat AI council</div>
              <h2>One question. Six specialized perspectives. One structured verdict.</h2>
            </div>
            <p className="section-copy">
              The council does not summarize — it forces every seat to cite data, name its invalidation point,
              and reconcile conflicts before the Chair issues a JSON verdict with direction, confidence, and horizon.
            </p>
          </div>

          <div className="seat-grid">
            <article className="seat-card">
              <div className="seat-tag t1">T1</div>
              <h3>Short-Term Trader</h3>
              <p>Tactical trades, 1-day to 60-day horizons. Delivers outlook, key driver, entry/exit, and stop with exact data citations.</p>
            </article>
            <article className="seat-card">
              <div className="seat-tag t2">T2</div>
              <h3>Long-Term Investor</h3>
              <p>Strategic positions, 2 months to 5 years. Secular thesis, risk/reward over 6–12m, key catalyst and invalidation.</p>
            </article>
            <article className="seat-card">
              <div className="seat-tag risk">RISK</div>
              <h3>Devil&apos;s Advocate</h3>
              <p>Argues the case against the prevailing direction. Names failure modes, downside scenario, and how a position would be sized to survive being wrong.</p>
            </article>
            <article className="seat-card">
              <div className="seat-tag macro">MACRO</div>
              <h3>Macro Context</h3>
              <p>Rates, dollar, liquidity, and sector rotation. Is the macro wind at this trade&apos;s back or in its face? What macro event would invalidate it?</p>
            </article>
            <article className="seat-card">
              <div className="seat-tag quant">QUANT</div>
              <h3>Quantitative</h3>
              <p>Interprets only the numeric data — confluence score, per-indicator signals, historical hit-rates. No narrative; no outside knowledge.</p>
            </article>
            <article className="seat-card chair">
              <div className="seat-tag chair-tag">CHAIR</div>
              <h3>Chair — Synthesis</h3>
              <p>Reads all five seats. States whether the council is in consensus or split, the strongest argument on each side, then issues a structured JSON verdict.</p>
              <div className="verdict-example mono">
                {`{"direction":"bullish","confidence":"high","horizon":"5-15d","invalidation":"<462"}`}
              </div>
            </article>
          </div>

          {(council?.shortTerm?.answer || council?.longTerm?.answer) && (
            <div className="council-layout" style={{ marginTop: "2rem" }}>
              {[
                { seat: "T1", horizon: "Short-term", answer: council?.shortTerm?.answer },
                { seat: "T2", horizon: "Long-term",  answer: council?.longTerm?.answer },
              ].map(({ seat, horizon, answer }) => answer && (
                <article className="council-panel" key={seat}>
                  <h3>{seat} · {horizon} · live sample</h3>
                  <p className="section-copy">SPY · council in session</p>
                  <div className="council-live-output">
                    <div className="council-live-label">{seat} seat · live</div>
                    <p>{answer}</p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      <section id="access" className="cta">
        <div className="wrap">
          <div className="kicker">Start today</div>
          <h2>Give every market question a council, not just a chart.</h2>
          <p>
            One account unlocks the web tools here and the NuWrrrld Financial mobile app — a repeatable
            decision workflow with signal quality scores, per-signal Ask Anything chat, six-seat council
            deliberation, and a rolling verdict track record you can revisit.
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
