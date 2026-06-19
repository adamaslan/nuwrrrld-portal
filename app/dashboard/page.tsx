import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import "./dashboard.css";

// Web tooling shell — the browser counterpart of the Expo app's three tabs
// (Briefing / HoldFold / Chat). Panels show representative shapes until the
// backend clients from gcp3-mobile/lib/clients are ported (see wiring note).
export default async function Dashboard() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  const firstName = user?.firstName ?? "investor";

  return (
    <div className="nwf-dash">
      <nav className="topbar" aria-label="Dashboard navigation">
        <Link className="brand" href="/dashboard">
          <span className="brand-mark" aria-hidden="true">NWF</span>
          <span>NuWrrrld Financial</span>
        </Link>
        <div className="topnav">
          <Link href="/dashboard/signals">Signals</Link>
          <Link href="/dashboard/nuai">Nu AI</Link>
          <Link href="/dashboard/billing">Billing</Link>
          <Link href="/dashboard/beta">Founders</Link>
          <UserButton />
        </div>
      </nav>

      <main>
        <div className="greeting">
          <h1>Good morning, {firstName}.</h1>
          <span>One account · web tools + mobile app</span>
        </div>

        <div className="tool-grid">
          <section className="tool" id="briefing" aria-label="Market briefing">
            <div className="tool-head">
              <h2>Market Briefing</h2>
              <span className="pill soon">Wiring up</span>
            </div>
            <p>Index levels, macro regime, sector leadership, and an AI-written brief grounded in live backend data.</p>
            <div className="stat-row">
              <div className="stat"><b className="up">+0.42</b><span>Regime score</span></div>
              <div className="stat"><b>Risk-on tilt</b><span>Macro</span></div>
              <div className="stat"><b className="up">72%</b><span>Breadth</span></div>
              <div className="stat"><b>AI infra, chips</b><span>Leaders</span></div>
            </div>
          </section>

          <section className="tool" id="signals" aria-label="Signal feed">
            <div className="tool-head">
              <h2>Signal Feed</h2>
              <span className="pill soon">Wiring up</span>
            </div>
            <p>Ranked buy / sell / hold outputs with confidence — five independent evidence families per read.</p>
            <div>
              <div className="signal-row"><b>NVDA</b><div className="bar"><span style={{ width: "91%" }} /></div><span className="up">BUY</span></div>
              <div className="signal-row"><b>MSFT</b><div className="bar"><span style={{ width: "74%" }} /></div><span className="up">BUY</span></div>
              <div className="signal-row"><b>TSLA</b><div className="bar"><span style={{ width: "58%" }} /></div><span className="flat">HOLD</span></div>
              <div className="signal-row"><b>XLE</b><div className="bar"><span style={{ width: "36%" }} /></div><span className="down">SELL</span></div>
            </div>
          </section>

          <section className="tool" id="holdfold" aria-label="Hold or fold verdicts">
            <div className="tool-head">
              <h2>Hold/Fold</h2>
              <span className="pill soon">Wiring up</span>
            </div>
            <p>Tactical trade verdicts with bias, risk, volatility regime, and the exact indicator readings behind them.</p>
            <div className="stat-row">
              <div className="stat"><b className="up">HOLD · 78%</b><span>Verdict · confidence</span></div>
              <div className="stat"><b>Moderate</b><span>Risk level</span></div>
              <div className="stat"><b>RSI 61.4 · ADX 28</b><span>Momentum / trend</span></div>
              <div className="stat"><b>Expanding</b><span>Volatility regime</span></div>
            </div>
          </section>

          <section className="tool" id="council" aria-label="AI council">
            <div className="tool-head">
              <h2>AI Council</h2>
              <span className="pill soon">Wiring up</span>
            </div>
            <p>Tap-to-ask, never automatic — short-term and long-term councils that must cite data and name invalidation levels.</p>
            <div className="council-bubble">
              Short-term: wait for ATR-defined entry. Long-term: add gradually if semis remain leadership.
              Conflict: price extension versus earnings durability.
            </div>
          </section>
        </div>

        <div className="wiring">
          <strong>Wiring plan:</strong> port <code>gcp3-mobile/lib/clients/</code> (gcp3, holdfold, aitext, council)
          into this app behind Next.js route handlers, so backend URLs stay server-side
          (<code>GCP3_BACKEND_URL</code>, <code>AITEXT_BACKEND_URL</code> — no <code>NEXT_PUBLIC_</code> exposure)
          and every request is gated by the Clerk session. The council choke point (<code>askCouncil()</code>)
          stays the single LLM entry — same cost guard and future metering as mobile.
        </div>
      </main>
    </div>
  );
}
