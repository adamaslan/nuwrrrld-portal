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
  { tag: "T1", tagClass: "t1", label: "Short-term trader", line: "NVDA is breaking out on volume. I'd take this long above 462." },
  { tag: "T2", tagClass: "t2", label: "Long-term investor", line: "The secular AI-compute thesis is intact. This is a long-term add on any real pullback, not a reason to avoid it." },
  { tag: "RISK", tagClass: "risk", label: "The skeptic", line: "Short interest is climbing into earnings in 9 days. If guidance disappoints, this breakout reverses in one session. I want a stop, not a story." },
  { tag: "MACRO", tagClass: "macro", label: "Big-picture watcher", line: "Rate-cut odds are firming, which usually helps growth names like this one hold a breakout instead of fading it." },
  { tag: "QUANT", tagClass: "quant", label: "Numbers only", line: "Confluence score 0.91. Five of five independent checks agree bullish, but historical hit-rate into earnings drops to 69%." },
  { tag: "CHAIR", tagClass: "chair-tag", label: "Final call", line: "The council leans bullish, but RISK's earnings-timing concern is real. Verdict: bullish, medium confidence, invalidation below 462." },
];

const VH_PER_SEAT = 55;

/**
 * Sticky scrollytelling demonstration of one full council debate (example
 * ticker NVDA — the same one used in the static seat grid and signal matrix
 * above). Pins a viewport while the user scrolls through a tall container;
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
