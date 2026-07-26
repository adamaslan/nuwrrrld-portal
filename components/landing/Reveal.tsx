"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useInView } from "react-intersection-observer";
import type { ReactNode } from "react";

interface RevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
  /** Underlying element — keep semantic HTML (e.g. "article" for cards). */
  as?: "div" | "article";
  role?: string;
  "aria-label"?: string;
}

/**
 * Fade + rise into view once, on first intersection. Used to reveal sections
 * and cards as the visitor scrolls, without re-triggering on scroll-up.
 * Collapses to a plain, static element under prefers-reduced-motion.
 */
export function Reveal({ children, delay = 0, className, as = "div", ...rest }: RevealProps) {
  const reduceMotion = useReducedMotion();
  const { ref, inView } = useInView({ triggerOnce: true, threshold: 0.15 });
  const MotionTag = as === "article" ? motion.article : motion.div;
  const StaticTag = as;

  if (reduceMotion) {
    return (
      <StaticTag className={className} {...rest}>
        {children}
      </StaticTag>
    );
  }

  return (
    <MotionTag
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      {...rest}
    >
      {children}
    </MotionTag>
  );
}
