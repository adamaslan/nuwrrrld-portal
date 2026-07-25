import { Reveal } from "@/components/landing/Reveal";

/**
 * Dedicated section for the RISK seat — the single most shareable idea on the
 * page ("the only AI whose job is to argue against your trade"). Server
 * component; only the fade-in wrapper (Reveal) is a client island.
 */
export function RiskSpotlight() {
  return (
    <section id="risk" className="risk-spotlight">
      <div className="wrap">
        <Reveal className="risk-spotlight-inner">
          <div className="kicker risk-kicker">Meet the skeptic</div>
          <h2>
            Five AI analysts can build a case for anything.
            <br />
            One is built to tear it down.
          </h2>
          <p className="section-copy risk-copy">
            RISK doesn&apos;t summarize, doesn&apos;t hedge, and doesn&apos;t care whose
            idea it was. Its only job is to find the way this trade goes wrong —
            and say so, in plain terms, before anyone gets to call it a buy.
          </p>

          <div className="risk-exchange" aria-label="Example council exchange">
            <div className="risk-line risk-line--t1">
              <span className="risk-line-tag">T1</span>
              <p>NVDA is breaking out on volume. I&apos;d take this long above 462.</p>
            </div>
            <div className="risk-line risk-line--risk">
              <span className="risk-line-tag risk-line-tag--risk">RISK</span>
              <p>
                Volume is up, but so is short interest into an earnings print in 9 days.
                If guidance disappoints, this gives back the whole breakout in one session.
                I want a stop, not a story.
              </p>
            </div>
          </div>

          <p className="risk-footer">
            Nothing reaches you until an argument like this one has already happened.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
