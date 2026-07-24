"use client";

import { useEffect } from "react";
import Lenis from "lenis";

/**
 * Drop-in smooth scroll for the signed-out landing page only. Mounted once
 * near the root of app/page.tsx; renders nothing. Respects reduced-motion —
 * Lenis is skipped entirely so native (instant) scroll behavior takes over,
 * matching the guardrail in app/globals.css.
 */
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lenis = new Lenis({ duration: 1.1, smoothWheel: true });
    let frameId: number;
    function raf(time: number) {
      lenis.raf(time);
      frameId = requestAnimationFrame(raf);
    }
    frameId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(frameId);
      lenis.destroy();
    };
  }, []);

  return null;
}
