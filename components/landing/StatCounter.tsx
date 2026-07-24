"use client";

import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useReducedMotion } from "framer-motion";

interface StatCounterProps {
  /** Numeric value to count up to. */
  value: number;
  /** Text rendered before the number, e.g. "" or "+". */
  prefix?: string;
  /** Text rendered after the number, e.g. "+" or "%". */
  suffix?: string;
  durationMs?: number;
}

/** Counts up from 0 to `value` once it scrolls into view. Static under reduced-motion. */
export function StatCounter({ value, prefix = "", suffix = "", durationMs = 900 }: StatCounterProps) {
  const reduceMotion = useReducedMotion();
  const { ref, inView } = useInView({ triggerOnce: true, threshold: 0.6 });
  const [display, setDisplay] = useState(reduceMotion ? value : 0);

  useEffect(() => {
    if (reduceMotion || !inView) return;
    const start = performance.now();
    let frame: number;
    function tick(now: number) {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * value));
      if (progress < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, reduceMotion, value, durationMs]);

  return (
    <strong ref={ref}>
      {prefix}
      {display}
      {suffix}
    </strong>
  );
}
