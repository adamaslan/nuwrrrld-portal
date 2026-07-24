"use client";

import { useRef } from "react";
import { motion, useMotionValue, useSpring, useReducedMotion } from "framer-motion";

interface MagneticCTAProps {
  href: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * CTA button that nudges toward the cursor on hover, with a spring settle.
 * A plain <a> (not next/link) — this always points to /sign-up or /sign-in,
 * a full page transition into Clerk's auth flow, so client-side prefetch
 * buys nothing here. No-op under prefers-reduced-motion.
 */
export function MagneticCTA({ href, className, children }: MagneticCTAProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  const reduceMotion = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 300, damping: 20 });
  const springY = useSpring(y, { stiffness: 300, damping: 20 });

  function handleMouseMove(e: React.MouseEvent<HTMLAnchorElement>) {
    if (reduceMotion || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const relX = e.clientX - rect.left - rect.width / 2;
    const relY = e.clientY - rect.top - rect.height / 2;
    x.set(relX * 0.25);
    y.set(relY * 0.4);
  }

  function handleMouseLeave() {
    x.set(0);
    y.set(0);
  }

  return (
    <motion.a
      ref={ref}
      href={href}
      className={className}
      style={reduceMotion ? undefined : { x: springX, y: springY }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      whileTap={reduceMotion ? undefined : { scale: 0.96 }}
    >
      {children}
    </motion.a>
  );
}
