import { Suspense } from "react";
import { LandingBlogArticles } from "@/components/landing/LandingBlogArticles";
import { getStoredSignals } from "@/app/dashboard/holdfold/stored-signals";
import { getCouncilSample } from "@/app/dashboard/holdfold/council-sample";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { adaptLiveSignals } from "@/lib/digest";
import { flagLive } from "@/lib/flags";
import { getAggregateTrackRecord } from "@/lib/track-record";
import { SmoothScroll } from "@/components/landing/SmoothScroll";
import { Reveal } from "@/components/landing/Reveal";
import { StatCounter } from "@/components/landing/StatCounter";
import { MagneticCTA } from "@/components/landing/MagneticCTA";
import { CouncilScrollDebate } from "@/components/landing/CouncilScrollDebate";
import { RiskSpotlight } from "@/components/landing/RiskSpotlight";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { PublicCouncilDemo } from "@/components/landing/PublicCouncilDemo";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import TwoAudiences from "@/components/landing/TwoAudiences";
import "./landing.css";

async function fetchLandingData() {
  // The track record is hidden during the dark launch, so skip its query too.
  const [signals, council] = await Promise.allSettled([
    getStoredSignals(), getCouncilSample(),
    flagLive("backtest_hit_rates") ? getAggregateTrackRecord() : Promise.resolve(null),
  ]);
  const digest = signals.status === "fulfilled" ? adaptLiveSignals(signals.value) : null;
  return {
    topSignals: digest?.signals.slice(0, 4) ?? null,
    council: council.status === "fulfilled" ? council.value : null,

    coverage: coverageFromDigest(digest),
  };
}

/**
 * The "things we check" stat, measured rather than asserted: every ranked
 * symbol carries a `signal_count` (surfaced as `signalCounts.total`), and the
 * backend's own `signal_summary.total_signals` is the sum of them. Deriving it
 * here keeps the landing page honest on days the tracked universe changes size,
 * instead of hardcoding a number that quietly drifts away from the engine.
 */
function coverageFromDigest(digest: ReturnType<typeof adaptLiveSignals> | null) {
  if (!digest || digest.signals.length === 0) return null;
  const checks = digest.signals.reduce(
    (sum, s) => sum + (s.signalCounts?.total ?? s.indicators.length),
    0,
  );
  return { tickers: digest.signals.length, checks };
}

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return <Suspense fallback={<div className="nwf-landing"><header className="hero"><div className="hero-inner"><h1>Understand the market. See how the ideas hold up.</h1><p>Market research. Simulated strategies. Recorded outcomes.</p><Link href="/sign-up">Start free →</Link></div></header></div>}><LandingContent /></Suspense>;
}

async function LandingContent() {
  const { council, coverage } = await fetchLandingData();

  return (
    <div className="nwf-landing">
      <SmoothScroll />
      <PreLoginNav />


      <header className="hero">
        <div className="market-wall" aria-hidden="true" />
        <div className="hero-inner">
          <div className="eyebrow">Market research. Simulated strategies. Recorded outcomes.</div>
          <h1>
            <span>Understand the market.</span> <span>See how the ideas hold up.</span>
          </h1>
          <p className="hero-copy">
            Read the market, compare signals and examine your portfolio. Ask AI about the evidence, follow its simulated portfolios, and check recorded calls against what happened next. <a href="#product">Explore the platform →</a>
          </p>
          <div className="hero-actions">
            <MagneticCTA className="btn primary" href="/sign-up">Start free →</MagneticCTA>

          </div>
          <p className="hero-subtext">Free to start · no card required</p>

          <figure className="editorial-product" aria-labelledby="product-example-title">
            <figcaption>Illustrative interface example. Not a live signal or investment recommendation.</figcaption>
            <div className="editorial-example">
              <div className="example-heading"><strong>ILLUSTRATIVE</strong><span>Not a live call</span></div>
              <h2 id="product-example-title">A call you can question.</h2>
              <dl><div><dt>Direction</dt><dd>Bullish</dd></div><div><dt>Confidence</dt><dd>Medium</dd></div><div><dt>Invalidation</dt><dd>When the original thesis no longer holds</dd></div></dl>
              <p>A recorded call is a starting point for research, not a promise of a return.</p>
              <Link href="/verdict/MOO">Explore a recorded verdict →</Link>
            </div>
          </figure>
        </div>
      </header>

      <div className="peek-band" role="group" aria-label="Key platform metrics">
        <div className="metric"><StatCounter value={5} /><span>Specialist AI seats in the council — including one built to argue against you.</span></div>
        <div className="metric">
          {coverage ? <StatCounter value={coverage.checks} /> : <strong>—</strong>}
          <span>Stored signal checks in this preview.</span>
        </div>
        <div className="metric">
          {coverage ? <StatCounter value={coverage.tickers} /> : <strong>—</strong>}
          <span>Stocks in this stored signal preview.</span>
        </div>
        <div className="metric"><strong>Live</strong><span>One account for the web and the mobile app.</span></div>
      </div>

      {/* ── What's New banner ── */}
      <div className="whats-new-band">
        <div className="wrap whats-new-inner">
          <span className="whats-new-label">What&apos;s new</span>
          <div className="whats-new-items">
            <span className="wn-chip">Council design: five seats, one Chair</span>
            <span className="wn-chip">Ask Anything, per ticker</span>
            <span className="wn-chip">Confidence on every signal</span>
            <span className="wn-chip">Public verdict pages</span>
            <span className="wn-chip">Free to start</span>

          </div>
        </div>
      </div>

      <section id="open-two-ways">
        <Reveal className="wrap">
          <TwoAudiences
            kicker="Wherever you're starting from"
            title="Built for the curious and the committed."
            beginner={{
              heading: "Learn the market in plain English",
              paragraphs: [
                "Everything starts in words you already know: what moved today, why it matters, and what a specialist AI analyst makes of the names everyone is talking about. No jargon, no homework.",
              ],
            }}
            trader={{
              heading: "Depth you can check, not a pitch",
              paragraphs: [
                "Ranked, explained calls you can actually check: recorded council verdicts sit on public pages with direction, confidence, and an invalidation level when one was set - readable without an account.",
              ],
            }}
          />
        </Reveal>
      </section>

      <section id="product">
        <div className="wrap">
          <Reveal className="section-head">
            <div>
              <div className="kicker">One workflow, web and mobile</div>
              <h2>Understand. Investigate. Compare. Check.</h2>
            </div>
            <p className="section-copy">
              A research workflow, not a single stock tip. Start with market context, inspect the
              evidence behind a signal, examine portfolio exposures and follow recorded outcomes.
              The overview and public verdict pages are free; Pro adds deeper research and tracked-strategy views.
            </p>
          </Reveal>

          <div className="surface-grid">
            <Reveal as="article" className="surface wide">
              <h3>Understand the day</h3>
              <p>Start with the market overview, then go deeper with a briefing and explained signals. See the context before focusing on a single stock.</p>
              <ul className="feature-list"><li>New to markets: a readable starting point, without chart jargon.</li><li>Trade actively: compare market tone, sectors and the indicators behind a call.</li></ul>
            </Reveal>
            <Reveal as="article" className="surface">
              <h3>Investigate the idea</h3>
              <p>Inspect Hold/Fold analysis, ask a short- or long-term specialist, or question Nu AI using portfolio, watchlist and signal context.</p>
              <ul className="feature-list"><li>New to markets: ask what a signal means and what might change it.</li><li>Trade actively: examine the thesis, risk and timeframe rather than accept a label.</li></ul>
            </Reveal>
            <Reveal as="article" className="surface">
              <h3>See the portfolio</h3>
              <p>Keep a watchlist, review sector movement and inspect portfolio health factors and suggested changes.</p>
              <ul className="feature-list"><li>New to markets: understand concentration and balance.</li><li>Trade actively: inspect exposures, factor breakdowns and position context.</li></ul>
            </Reveal>
            <Reveal as="article" className="surface wide">
              <h3>Check what happened</h3>
              <p>Follow AI-managed paper portfolios, compare their holdings in the arena, and review frozen monthly stock calls as recorded outcomes arrive.</p>
              <ul className="feature-list"><li>New to markets: learn from simulated strategies without placing a trade through the app.</li><li>Trade actively: separate paper-book construction from individual call outcomes. Neither guarantees future returns.</li></ul>
              <Link className="feature-more" href="/track-record">Explore the track record →</Link>
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
              Five independent families of check back every call — momentum, trend, relative strength,
              market structure, and mean reversion — scored and weighted together, so one bad signal
              can&apos;t fool the whole system.
            </p>
          </Reveal>

          <Reveal className="matrix">
            <div className="matrix-head">
              <strong>Illustrative signal matrix - XLE</strong>
              <span className="pill">Example data, not a live recommendation</span>
            </div>
            <table className="signal-comparison">
              <caption>Five signal families across five time horizons. All values are illustrative.</caption>
              <thead><tr>{["Signal", "1D", "1W", "1M", "3M", "1Y", "Confidence"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{[
                ["Momentum", "BUY", "BUY", "HOLD", "BUY", "HOLD", "0.87"],
                ["Trend", "BUY", "BUY", "BUY", "HOLD", "HOLD", "0.91"],
                ["Relative strength", "HOLD", "BUY", "BUY", "BUY", "BUY", "0.82"],
                ["Market structure", "HOLD", "HOLD", "BUY", "BUY", "BUY", "0.74"],
                ["Mean reversion", "SELL", "HOLD", "BUY", "BUY", "HOLD", "0.69"],
              ].map(([name, ...values]) => <tr key={name}><th scope="row">{name}</th>{values.map((value, index) => <td key={index} data-label={["1D", "1W", "1M", "3M", "1Y", "Confidence"][index]}>{value}</td>)}</tr>)}</tbody>
            </table>
          </Reveal>

          <div className="moat-grid">
            <Reveal delay={0} className="moat-card">
              <h3>Built to catch its own mistakes</h3>
              <p>Signals carry a confidence level, and council calls carry an invalidation level when one was set - so you can see both the call and where it breaks.</p>
              <ul className="feature-list">
                <li>Five independent signal families, weighted into one score.</li>
                <li>Each signal names the indicators that fired, and the timeframe.</li>
              </ul>
            </Reveal>
            <Reveal delay={0.08} className="moat-card">
              <h3>A public record of calls</h3>
              <p>Recorded council calls publish to public verdict pages - direction, confidence, horizon and invalidation as they were set.</p>
              <ul className="feature-list">
                <li>Recorded calls on public pages - readable without an account.</li>
                <li>An archive of market days and recorded calls.</li>
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
              <div className="kicker">The council design</div>
              <h2>One question. Five arguments. One answer.</h2>
            </div>
            <p className="section-copy">
              The council doesn&apos;t just summarize — every seat has to point to real data and say exactly
              what would change its mind, before the Chair gives you one clear, final call.
            </p>
          </Reveal>

          <CouncilScrollDebate />

          <div className="seat-grid">
            <Reveal delay={0} as="article" className="seat-card seat-card--risk">
              <div className="seat-tag risk">RISK</div>
              <h3>The one who argues against you</h3>
              <p>Its whole job is to talk you out of the trade — naming exactly how it could go wrong, and how bad it could get, before anyone gets to say &quot;buy.&quot;</p>
            </Reveal>
            <Reveal delay={0.05} as="article" className="seat-card">
              <div className="seat-tag t1">T1</div>
              <h3>The short-term trader</h3>
              <p>Thinks in days and weeks. Gives you a clear entry, exit, and stop — with the real data behind each one.</p>
            </Reveal>
            <Reveal delay={0.1} as="article" className="seat-card">
              <div className="seat-tag t2">T2</div>
              <h3>The long-term investor</h3>
              <p>Thinks in months and years. What&apos;s the case for holding this for the long haul, and what would break it?</p>
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
              <div className="verdict-badge" role="group" aria-label="Illustrative verdict example">
                <span className="verdict-badge-call buy">BUY</span>
                <span className="verdict-badge-meta">High confidence · 5-15 day horizon</span>
                <span className="verdict-badge-inv">Wrong if it falls under $91</span>
                <span className="verdict-badge-note">Illustrative example of the verdict format</span>
              </div>
            </Reveal>
          </div>

          {(council?.shortTerm?.answer || council?.longTerm?.answer) && (
            <div className="council-layout" style={{ marginTop: "2rem" }}>
              {council?.ticker && council?.simulatedCapitalUsd && (
                <p className="section-copy" style={{ marginBottom: "0.75rem" }}>
                  Stored sample: ${council.simulatedCapitalUsd.toLocaleString()} into {council.ticker}
                  {council.fundName ? ` (${council.fundName})` : ""}.
                </p>
              )}
              {[
                { seat: "T1", horizon: "Short-term", answer: council?.shortTerm?.answer },
                { seat: "T2", horizon: "Long-term",  answer: council?.longTerm?.answer },
              ].map(({ seat, horizon, answer }) => answer && (
                <article className="council-panel" key={seat}>
                  <h3>{seat} · {horizon} · stored sample</h3>
                  <p className="section-copy">{council?.ticker ?? "MOO"} · stored commentary</p>
                  <div className="council-live-output">
                    <div className="council-live-label">{seat} seat · stored</div>
                    <p>{answer}</p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      <HowItWorks />

      <section id="who">
        <Reveal className="wrap">
          <div className="section-head">
            <div className="kicker">Who it&rsquo;s for</div>
            <h2>Two ways in.</h2>
          </div>
          <div className="editorial-directory">
            <article className="editorial-entry">
              <h3>New to markets?</h3>
              <p className="section-copy">
                You don&rsquo;t need to speak finance to follow your money. We turn the flood of
                market news into a short, plain-English read: what moved, why it matters, and
                what a specialist AI analyst says about the names everyone is talking about.
              </p>
              <p className="section-copy" style={{ fontSize: "0.85rem", opacity: 0.8 }}>
                Free: market overview dashboard · public verdict pages · no card required<br />
                Pro adds: the plain-English daily digest and morning briefing
              </p>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.6rem" }}>
                <Link className="btn primary" href="/sign-up">Start free →</Link>
                <Link href="/#council" style={{ fontSize: "0.85rem" }}>See how the council works ↓</Link>
              </div>
            </article>
            <article className="editorial-entry">
              <h3>Trade actively?</h3>
              <p className="section-copy">
                Start the day briefed. Overnight we score and rank signals across the stocks
                and ETFs we track, and Pro adds the morning briefing and daily digest by email.
                Ask Nu AI questions grounded in your holdings and watchlist, and weigh our
                published calls on their public verdict pages.
              </p>
              <p className="section-copy" style={{ fontSize: "0.85rem", opacity: 0.8 }}>
                Free: market overview dashboard · public verdict pages<br />
                Pro adds: morning briefing · daily digest · Nu AI
              </p>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.6rem" }}>
                <Link className="btn primary" href="/pricing">Start your 7-day Pro trial →</Link>
                <Link href="/signals" style={{ fontSize: "0.85rem" }}>Browse the signals</Link>
              </div>
            </article>
          </div>
        </Reveal>
      </section>

      <section id="features-twoway">
        <Reveal className="wrap">
          <div className="section-head section-head--solo">
            <div>
              <div className="kicker">Explore the product, two ways to read it</div>
              <h2>Same product. Your depth.</h2>
            </div>
          </div>
          <div className="editorial-directory">
            {[
              { name: "Market overview", tag: "Free",
                b: "One calm screen: what moved today and why it matters, in words you already know.",
                t: "Indices, sectors and volatility at a glance, with the day's signals alongside." },
              { name: "Signals", tag: "Public preview",
                b: "A short list of stocks worth a closer look, each with a plain-English reason and a confidence level.",
                t: "Five signal families, ranked by confidence and refreshed every trading day, each naming the indicators that fired." },
              { name: "Council verdicts", tag: "Public pages",
                b: "Ask about a stock we track and a specialist AI analyst answers: the direction it leans, its confidence, and - when it sets one - the exact price that would prove it wrong.",
                t: "Recorded council calls sit on public verdict pages - direction, confidence, horizon and invalidation as they were set, gaps included." },
              { name: "Nu AI", tag: "Pro",
                b: "Ask anything in plain English and get an answer grounded in your own holdings, not generic commentary.",
                t: "Interrogate any position or signal with your portfolio, watchlist and the latest signals as context." },
              { name: "Briefing and digest", tag: "Pro",
                b: "A short morning read: what happened overnight and what to watch today.",
                t: "Signals scored and ranked overnight, delivered in the morning briefing and the daily digest." },
              { name: "Portfolio health", tag: "In the app",
                b: "Your holdings get an A-to-F health grade, with plain-English reasons and the fixes that would help most.",
                t: "Concentration, sector balance, momentum and volatility regime - with the factor behind every suggested fix." },
              { name: "Paper trading", tag: "Pro · Simulated", href: "/paper-trading",
                b: "Watch AI-managed practice portfolios use simulated money. Follow their holdings and trades without risking your savings.",
                t: "Six council-seat books and two controls, with holdings, order history, portfolio value and drawdown. These are simulated strategies, not a personal trade-entry tool." },
              { name: "Top performers and track record", tag: "Pro", href: "/track-record",
                b: "See which simulated AI portfolios lead, and follow the app's strongest monthly stock calls as their results come in.",
                t: "Two distinct views: a paper-book leaderboard, and frozen bullish/bearish monthly picks scored across seven horizons. Strongest calls are not guaranteed winners." },
              { name: "Web and mobile", tag: "One account",
                b: "One account across the web and the mobile app.",
                t: "Signals and briefings where you are - web at your desk, phone everywhere else." },
            ].map(f => (
              <article key={f.name} className="editorial-entry">
                <h3>{f.name} <span style={{ fontSize: "0.7rem", fontWeight: 600, opacity: 0.7, verticalAlign: "middle" }}>{f.tag}</span></h3>
                <p className="section-copy"><strong>New to markets:</strong> {f.b}</p>
                <p className="section-copy" style={{ fontSize: "0.85rem", opacity: 0.8 }}><strong>Trade actively:</strong> {f.t}</p>
                {"href" in f && <Link className="feature-more" href={f.href!}>Explore {f.name.toLowerCase()} →</Link>}
              </article>
            ))}
          </div>
        </Reveal>
      </section>

      <section id="nvidia-research" className="editorial-section" aria-labelledby="nvidia-research-title">
        <div className="wrap">
          <p className="kicker">Research note · November 13, 2026</p>
          <h2 id="nvidia-research-title">NVIDIA: six forward-looking checkpoints</h2>
          <p className="section-copy">One week and 1, 3, 6, 9 and 12 months: upside, continuity and downside paths, with the evidence that would change each view.</p>
          <p className="section-copy">Conditional scenarios, not predictions, probabilities or investment advice. Historical scan inputs stop on November 12, 2026; this is not a live quote or signal.</p>
          <Link className="feature-more" href="/research/nvidia-forward-scenarios">Read the NVIDIA scenario article →</Link>
        </div>
      </section>

      <LandingBlogArticles />

      <section id="access" className="cta">
        <Reveal className="wrap">
          <div className="kicker">Start today</div>
          <h2>Make the evidence part of your process.</h2>
          <p>
            New to markets? Start free - the market overview dashboard and public verdict pages
            are yours while you learn, no card required.
          </p>
          <p>
            Trade actively? Watch recorded calls land on the public verdict pages, and use the
            7-day Pro trial for the morning briefing, daily digest and Nu AI.
          </p>
          <div className="hero-actions">
            <MagneticCTA className="btn primary" href="/sign-up">Start free →</MagneticCTA>
            <Link className="btn secondary" href="/sign-in">Sign in</Link>
          </div>
          <p className="hero-subtext">Free to start · no card required</p>

          {flagLive("council_public_demo") && <PublicCouncilDemo />}
        </Reveal>
      </section>

      <PreLoginFooter />
    </div>
  );
}
