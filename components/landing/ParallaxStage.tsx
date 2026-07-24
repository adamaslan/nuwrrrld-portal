"use client";

import { createContext, useContext, useRef } from "react";
import { motion, useMotionValue, useSpring, useTransform, useReducedMotion, type MotionValue } from "framer-motion";
import type { ReactNode } from "react";

const ParallaxContext = createContext<{ x: MotionValue<number>; y: MotionValue<number> } | null>(null);

interface ParallaxStageProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/**
 * Mouse-follow parallax stage for the hero's three-phone product mockup.
 * Tracks normalized (-1..1) cursor position and exposes it via context; each
 * <ParallaxLayer depth={n}> child derives its own offset from that shared
 * value, so the near "main" phone drifts more than the far "side" phones.
 * No-op under prefers-reduced-motion — layers simply hold still.
 */
export function ParallaxStage({ children, className, ...rest }: ParallaxStageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const x = useSpring(rawX, { stiffness: 60, damping: 18 });
  const y = useSpring(rawY, { stiffness: 60, damping: 18 });

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (reduceMotion || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    rawX.set(((e.clientX - rect.left) / rect.width - 0.5) * 2);
    rawY.set(((e.clientY - rect.top) / rect.height - 0.5) * 2);
  }

  function handleMouseLeave() {
    rawX.set(0);
    rawY.set(0);
  }

  return (
    <ParallaxContext.Provider value={{ x, y }}>
      <div ref={ref} className={className} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} {...rest}>
        {children}
      </div>
    </ParallaxContext.Provider>
  );
}

/** Wraps one phone mockup; `depth` scales how far it drifts (higher = more). */
export function ParallaxLayer({ depth, className, children }: { depth: number; className?: string; children: ReactNode }) {
  const ctx = useContext(ParallaxContext);
  const reduceMotion = useReducedMotion();
  const fallbackX = useMotionValue(0);
  const fallbackY = useMotionValue(0);
  const sourceX = ctx?.x ?? fallbackX;
  const sourceY = ctx?.y ?? fallbackY;
  const x = useTransform(sourceX, (v) => v * depth);
  const y = useTransform(sourceY, (v) => v * depth * 0.6);

  if (reduceMotion || !ctx) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div className={className} style={{ x, y }}>
      {children}
    </motion.div>
  );
}
