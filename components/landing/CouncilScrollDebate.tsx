"use client";

import { useRef, useState } from "react";
import { useScroll, useMotionValueEvent, useReducedMotion } from "framer-motion";

interface DebateSeat {
  tag: string;
  tagClass: string;
  label: string;
  line: string;
}

const SEATS: DebateSeat[] = [
  { tag: "T1", tagClass: "t1", label: "Short-term trader", line: "XLE is up on the day and the week together, so near-term buying looks sustained. I'd take this long above 91." },
  { tag: "T2", tagClass: "t2", label: "Long-term investor", line: "The 1-year and 3-month trends both point the same way. That's a position to add to on a pullback, not a trade to chase." },
  { tag: "RISK", tagClass: "risk", label: "The skeptic", line: "Relative strength is doing most of the work here, and it's the fastest thing to reverse. If energy stops leading, this whole case is one week old. I want a stop, not a story." },
  { tag: "MACRO", tagClass: "macro", label: "Big-picture watcher", line: "Rates and the dollar are steady, so the sector is not fighting the macro wind — but nothing here is a tailwind either." },
  { tag: "QUANT", tagClass: "quant", label: "Numbers only", line: "Confluence +0.91, labelled HIGH. Momentum, trend and relative strength all read bullish; mean reversion is the lone abstain." },
  { tag: "CHAIR", tagClass: "chair-tag", label: "Final call", line: "The council leans bullish, but RISK's point about leadership fading is real. Verdict: bullish, medium confidence, invalidation below 91." },
];

const VH_PER_SEAT = 55;

/**
 * Sticky scrollytelling demonstration of one full council debate (illustrative
 * ticker XLE — a real member of the tracked ETF universe, and the same one used
 * in the signal matrix above). Pins a viewport while the user scrolls;
 * each seat's line reveals in turn. Falls back to a plain, fully-revealed
 * static list under prefers-reduced-motion (no pinning, no scroll-driving).
 */
export function CouncilScrollDebate() {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"],
  });

  useMotionValueEvent(scrollYProgress, "change", (v) => {
    setStep(Math.min(SEATS.length - 1, Math.max(0, Math.floor(v * SEATS.length))));
  });

  if (reduceMotion) {
    return (
      <div className="council-debate council-debate--static">
        <div className="council-debate-sticky">
          <p className="council-debate-ticker">Example — NVDA</p>
          {SEATS.map((seat) => (
            <DebateLine key={seat.tag} seat={seat} revealed />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="council-debate" style={{ height: `${SEATS.length * VH_PER_SEAT}vh` }}>
      <div className="council-debate-sticky">
        <p className="council-debate-ticker">Example — NVDA</p>
        {SEATS.map((seat, i) => (
          <DebateLine key={seat.tag} seat={seat} revealed={i <= step} active={i === step} />
        ))}
      </div>
    </div>
  );
}

function DebateLine({ seat, revealed, active }: { seat: DebateSeat; revealed: boolean; active?: boolean }) {
  return (
    <div
      className={`council-debate-line${revealed ? " is-revealed" : ""}${active ? " is-active" : ""}`}
    >
      <span className={`seat-tag ${seat.tagClass}`}>{seat.tag}</span>
      <div>
        <p className="council-debate-label">{seat.label}</p>
        <p className="council-debate-text">{seat.line}</p>
      </div>
    </div>
  );
}
