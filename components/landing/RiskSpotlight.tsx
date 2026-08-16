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
              <p>XLE is up on the day and the week together. I&apos;d take this long above 91.</p>
            </div>
            <div className="risk-line risk-line--risk">
              <span className="risk-line-tag risk-line-tag--risk">RISK</span>
              <p>
                That&apos;s two momentum checks agreeing with each other, not two independent
                ones. Strip out relative strength and the case is a week old. If energy stops
                leading, this gives the move back in one session. I want a stop, not a story.
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
