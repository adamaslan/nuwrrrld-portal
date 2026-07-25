import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { adaptLiveSignals } from "@/lib/digest";
import { getAggregateTrackRecord } from "@/lib/track-record";
import { SmoothScroll } from "@/components/landing/SmoothScroll";
import { Reveal } from "@/components/landing/Reveal";
import { StatCounter } from "@/components/landing/StatCounter";
import { MagneticCTA } from "@/components/landing/MagneticCTA";
import { ParallaxStage, ParallaxLayer } from "@/components/landing/ParallaxStage";
import { CouncilScrollDebate } from "@/components/landing/CouncilScrollDebate";
import { RiskSpotlight } from "@/components/landing/RiskSpotlight";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { PublicCouncilDemo } from "@/components/landing/PublicCouncilDemo";
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

interface IndexEntry {
  symbol?: string;
  price?: number;
  change_pct?: number;
}

interface MarketOverviewResponse {
  brief?: {
    summary?: string;
    indices?: Record<string, IndexEntry>;
  };
}

/**
 * The backend nests index quotes under `brief.indices`, keyed by display name
 * ("S&P 500"), not ticker. Re-key by `.symbol` so the rest of the page can look
 * up `bySymbol.SPY` the way it always assumed it could.
 */
function indexBySymbol(market: MarketOverviewResponse | null): Record<string, IndexEntry> {
  const indices = market?.brief?.indices;
  if (!indices) return {};
  const out: Record<string, IndexEntry> = {};
  for (const entry of Object.values(indices)) {
    if (entry?.symbol) out[entry.symbol] = entry;
  }
  return out;
}

async function fetchLandingData() {
  const fetchWithTimeout = async (url: string, cache: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      return await fetch(url, { signal: controller.signal, next: { revalidate: cache } });
    } finally { clearTimeout(timer); }
  };

  const [mktRes, sigRes, council, trackRecord] = await Promise.allSettled([
    fetchWithTimeout(`${MCP_URL}/market-overview`, 3600),
    fetchWithTimeout(`${MCP_URL}/signals`, 3600),
    fetchCouncilSample(),
    getAggregateTrackRecord(),
  ]);
  const market: MarketOverviewResponse | null = mktRes.status === "fulfilled" && mktRes.value.ok
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
  const trackRecordData = trackRecord.status === "fulfilled" ? trackRecord.value : null;
  return {
    market,
    marketSummary: market?.brief?.summary,
    indices: indexBySymbol(market),
    topSignals,
    council: councilData,
    trackRecord: trackRecordData,
  };
}

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  const { marketSummary, indices, topSignals, council, trackRecord } = await fetchLandingData();

  return (
    <div className="nwf-landing">
      <SmoothScroll />
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
          <Link className="nav-action" href="/sign-up">Start free →</Link>
        </div>
      </nav>

      <header className="hero">
        <div className="market-wall" aria-hidden="true" />
        <div className="hero-inner">
          <div className="eyebrow">Six AI analysts. One straight answer.</div>
          <h1>
            <span>Should I buy it,</span> <span>or not?</span>
          </h1>
          <p className="hero-copy">
            Ask any ticker. Six AI analysts argue it out — including one whose whole job is to talk you
            out of the trade — until they agree on a call, and exactly what price would prove them wrong.
          </p>
          <div className="hero-actions">
            <MagneticCTA className="btn primary" href="/sign-up">Start free →</MagneticCTA>
            <a className="btn secondary" href="#council">See the council argue</a>
          </div>
          <p className="hero-subtext">Free to start · no card required</p>

          <ParallaxStage className="product-stage" aria-label="NuWrrrld Financial product preview">
            <ParallaxLayer depth={10} className="phone side">
              <div className="screen">
                <div className="statusbar"><span>9:41</span><span>Briefing</span></div>
                <div className="app-title"><strong>Market mood</strong><span className="pill">Risk-on</span></div>
                <div className="brief-card">
                  <div className="label">Today&apos;s read</div>
                  <div className="big-number up">Bullish</div>
                  <p className="brief-text">Stocks are broadly rising and volatility is cooling off.</p>
                </div>
                <div className="mini-grid">
                  <div className="mini-card"><strong className="up">72%</strong><span>Stocks rising</span></div>
                  <div className="mini-card"><strong className="down">-3.1%</strong><span>Fear index</span></div>
                  <div className="mini-card"><strong className="up">Calmer</strong><span>Volatility</span></div>
                  <div className="mini-card"><strong className="flat">Steady</strong><span>Interest rates</span></div>
                </div>
              </div>
            </ParallaxLayer>

            <ParallaxLayer depth={16} className="phone main">
              <div className="screen">
                <div className="statusbar"><span>9:41</span><span>NuWrrrld Financial</span></div>
                <div className="app-title"><strong>Market snapshot</strong><span className="pill">Live</span></div>
                {indices.SPY != null ? (
                  <>
                    <div className="brief-card">
                      <div className="label">S&amp;P 500</div>
                      <div className={`big-number ${(indices.SPY.change_pct ?? 0) >= 0 ? "up" : "down"}`}>
                        {indices.SPY.price?.toLocaleString() ?? "—"}
                      </div>
                      {marketSummary && (
                        <p className="brief-text">{marketSummary}</p>
                      )}
                    </div>
                    <div className="mini-grid">
                      {["QQQ", "DIA", "IWM"].map((sym) => {
                        const idx = indices[sym];
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
                    <p className="brief-text">Market snapshot loading…</p>
                  </div>
                )}
              </div>
            </ParallaxLayer>

            <ParallaxLayer depth={10} className="phone side right">
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
                <div className="council-bubble">Every call comes with a trust score, so you know how much to lean on it.</div>
              </div>
            </ParallaxLayer>
          </ParallaxStage>
        </div>
      </header>

      <div className="peek-band" aria-label="Key platform metrics">
        <div className="metric"><StatCounter value={6} /><span>AI analysts arguing every call — including one against you.</span></div>
        <div className="metric"><StatCounter value={138} /><span>Things we check before we tell you buy, sell, or hold.</span></div>
        <div className="metric"><StatCounter value={380} suffix="+" /><span>Data points behind every single ticker.</span></div>
        <div className="metric"><strong>Live</strong><span>One account for the web and the mobile app.</span></div>
      </div>

      {/* ── What's New banner ── */}
      <div className="whats-new-band">
        <div className="wrap whats-new-inner">
          <span className="whats-new-label">What&apos;s new</span>
          <div className="whats-new-items">
            <span className="wn-chip">Six-seat AI council</span>
            <span className="wn-chip">Ask Anything, per ticker</span>
            <span className="wn-chip">Trust score on every call</span>
            <span className="wn-chip">Checkable track record</span>
            <span className="wn-chip">Free to start</span>
            <span className="wn-chip">New dark theme</span>
          </div>
        </div>
      </div>

      <section id="product">
        <div className="wrap">
          <Reveal className="section-head">
            <div>
              <div className="kicker">One workflow, web and mobile</div>
              <h2>From &quot;what&apos;s happening&quot; to &quot;what should I do&quot; — without leaving the app.</h2>
            </div>
            <p className="section-copy">
              A daily briefing, ranked buy/sell/hold calls, a chat that knows the ticker you're
              looking at, and a full argument between six AI analysts — on the web here, and in
              the NuWrrrld mobile app.
            </p>
          </Reveal>

          <div className="surface-grid">
            <Reveal delay={0} as="article" className="surface wide">
              <h3>Morning Briefing</h3>
              <p>Start each day knowing the mood of the market in one glance — is it a good day to be aggressive, or a good day to sit on your hands.</p>
              <ul className="feature-list">
                <li>Plain-English summary before the open.</li>
                <li>Which sectors are leading, at a glance.</li>
              </ul>
            </Reveal>
            <Reveal delay={0.05} as="article" className="surface">
              <h3>Signal Feed</h3>
              <p>Ranked buy, sell, and hold calls with a trust score and the reasoning behind each one — backed by a track record you can check.</p>
              <ul className="feature-list">
                <li>A trust score on every single call.</li>
                <li>See how often this exact call has been right before.</li>
              </ul>
            </Reveal>
            <Reveal delay={0.1} as="article" className="surface">
              <h3>Ask Anything</h3>
              <p className="new-badge-inline">New</p>
              <p>Open any call and just ask it a question, like "why now?" or "what would change your mind?" — it answers using that ticker's real, live data.</p>
              <ul className="feature-list">
                <li>Live, streaming chat per ticker.</li>
                <li>Answers grounded in real data — not a generic chatbot.</li>
              </ul>
            </Reveal>
            <Reveal delay={0.15} as="article" className="surface wide">
              <h3>Six-Seat AI Council</h3>
              <p>Six specialists debate every call, and one of them — RISK — is built to argue against you. Nothing reaches you until they've named the exact price that would prove them wrong.</p>
              <ul className="feature-list">
                <li>Short-term trader · Long-term investor · The skeptic · Macro watcher · Pure numbers · The Chair, who calls it.</li>
                <li>Every disagreement gets named, not smoothed over, before you get a final answer.</li>
              </ul>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="engine" className="engine">
        <div className="wrap">
          <Reveal className="section-head">
            <div>
              <div className="kicker">Built to be wrong less often</div>
              <h2>No single indicator ever gets the final word.</h2>
            </div>
            <p className="section-copy">
              Five completely independent checks back every call — price action, volatility, the macro
              backdrop, sector rotation, and news events — so one bad signal can't fool the whole system.
            </p>
          </Reveal>

          <Reveal className="matrix" role="img" aria-label="Example signal matrix with decisions across time horizons">
            <div className="matrix-head">
              <strong>Example — NVDA</strong>
              <span className="pill">380+ inputs · trust score 0.91</span>
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
          </Reveal>

          <div className="moat-grid">
            <Reveal delay={0} className="moat-card">
              <h3>Built to catch its own mistakes</h3>
              <p>Every call carries a trust score, a confidence level, and the exact price that would prove it wrong — and we show you the track record, not just the pitch.</p>
              <ul className="feature-list">
                <li>Five independent checks behind every call.</li>
                <li>The council can't answer without pointing to real data.</li>
              </ul>
            </Reveal>
            <Reveal delay={0.08} className="moat-card">
              <h3>It gets smarter every day</h3>
              <p>Every call we make and every argument the council has is logged for good — so our track record only gets longer, and harder for anyone else to catch up to.</p>
              <ul className="feature-list">
                <li>
                  {trackRecord
                    ? `${trackRecord.hitRatePct}% rolling hit-rate across ${trackRecord.totalCalls.toLocaleString()} recorded calls.`
                    : "Building our public track record — check back soon."}
                </li>
                <li>A growing archive of market days and council arguments.</li>
              </ul>
            </Reveal>
          </div>
        </div>
      </section>

      <RiskSpotlight />

      <section id="council">
        <div className="wrap">
          <Reveal className="section-head">
            <div>
              <div className="kicker">Six-seat AI council</div>
              <h2>One question. Six arguments. One answer you can trust.</h2>
            </div>
            <p className="section-copy">
              The council doesn't just summarize — every seat has to point to real data and say exactly
              what would change its mind, before the Chair gives you one clear, final call.
            </p>
          </Reveal>

          <CouncilScrollDebate />

          <div className="seat-grid">
            <Reveal delay={0} as="article" className="seat-card seat-card--risk">
              <div className="seat-tag risk">RISK</div>
              <h3>The one who argues against you</h3>
              <p>Its whole job is to talk you out of the trade — naming exactly how it could go wrong, and how bad it could get, before anyone gets to say "buy."</p>
            </Reveal>
            <Reveal delay={0.05} as="article" className="seat-card">
              <div className="seat-tag t1">T1</div>
              <h3>The short-term trader</h3>
              <p>Thinks in days and weeks. Gives you a clear entry, exit, and stop — with the real data behind each one.</p>
            </Reveal>
            <Reveal delay={0.1} as="article" className="seat-card">
              <div className="seat-tag t2">T2</div>
              <h3>The long-term investor</h3>
              <p>Thinks in months and years. What's the case for holding this for the long haul, and what would break it?</p>
            </Reveal>
            <Reveal delay={0.15} as="article" className="seat-card">
              <div className="seat-tag macro">MACRO</div>
              <h3>The big-picture watcher</h3>
              <p>Is the wider economy helping this trade or fighting it? What headline would flip that overnight?</p>
            </Reveal>
            <Reveal delay={0.2} as="article" className="seat-card">
              <div className="seat-tag quant">QUANT</div>
              <h3>The numbers-only skeptic</h3>
              <p>Trusts nothing but the raw data — no story, no vibes, just what the numbers actually say.</p>
            </Reveal>
            <Reveal delay={0.25} as="article" className="seat-card chair">
              <div className="seat-tag chair-tag">CHAIR</div>
              <h3>The one who calls it</h3>
              <p>Weighs all five arguments, says plainly whether they agree or clash, and hands you one final call.</p>
              <div className="verdict-example mono">
                {`{"direction":"bullish","confidence":"high","horizon":"5-15d","invalidation":"<462"}`}
              </div>
            </Reveal>
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

      <HowItWorks />

      <section id="access" className="cta">
        <Reveal className="wrap">
          <div className="kicker">Start today</div>
          <h2>Stop asking a chart. Start asking a council.</h2>
          <p>
            One account gets you the daily briefing, ranked calls, Ask Anything chat, and the
            full six-seat council — on the web here and in the mobile app.
          </p>
          <div className="hero-actions">
            <MagneticCTA className="btn primary" href="/sign-up">Start free →</MagneticCTA>
            <Link className="btn secondary" href="/sign-in">Sign in</Link>
          </div>
          <p className="hero-subtext">Free to start · no card required</p>

          <PublicCouncilDemo />
        </Reveal>
      </section>

      <footer>
        <span>NWF · NuWrrrld Financial</span>
        <span>Six AI analysts. One straight answer.</span>
      </footer>
    </div>
  );
}
