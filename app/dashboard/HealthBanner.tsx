"use client";
import { useEffect, useState } from "react";

// Mirrors the DepStatus union in app/api/health/route.ts.
type DepStatus = "ok" | "degraded" | "down" | "not_configured";

interface HealthVerdict {
  status: DepStatus;
  mcp?: { status: DepStatus };
  neon?: { status: DepStatus };
  stripe?: { status: DepStatus };
  openrouter?: { status: DepStatus };
  clerk?: { status: DepStatus };
}

const DEP_LABELS: Record<string, string> = {
  mcp: "market data",
  neon: "database",
  stripe: "billing",
  openrouter: "Nu AI",
  clerk: "sign-in",
};

// Which dependency statuses count as user-visible degradation. `not_configured`
// is an expected inert state in previews, so it never raises the banner.
const DEGRADED_STATES: ReadonlySet<DepStatus> = new Set(["down", "degraded"]);

function affectedDeps(verdict: HealthVerdict): string[] {
  return Object.keys(DEP_LABELS).filter((dep) => {
    const status = verdict[dep as keyof HealthVerdict];
    return typeof status === "object" && status !== null && DEGRADED_STATES.has(status.status);
  });
}

/**
 * Client-side health probe. Fetches /api/health once on mount and renders a
 * banner when a backend dependency is down or degraded, so a user reaching the
 * dashboard during an outage sees why features may misbehave instead of hitting
 * silent failures. Renders nothing when everything is ok.
 *
 * This is the real target the `EXPOSE: frontend renders a usable page when
 * /api/health reports down` e2e test asserts against (data-testid="health-banner").
 */
export function HealthBanner() {
  const [affected, setAffected] = useState<string[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((res) => res.json() as Promise<HealthVerdict>)
      .then((verdict) => {
        if (verdict.status === "ok") return;
        const deps = affectedDeps(verdict);
        if (deps.length > 0) setAffected(deps);
      })
      .catch((err) => {
        // A real network failure is itself a signal something is wrong — surface
        // a generic banner. But an AbortError is our own unmount cleanup firing,
        // not an outage: ignore it so we don't set state on an unmounted
        // component or flash a false banner on navigation away.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setAffected([]);
      });
    return () => controller.abort();
  }, []);

  if (affected === null) return null;

  const detail =
    affected.length > 0
      ? `Affected: ${affected.map((d) => DEP_LABELS[d]).join(", ")}.`
      : "Some services may be unreachable.";

  return (
    <div className="health-banner" role="alert" data-testid="health-banner">
      <strong>Some features may be unavailable right now.</strong> {detail}{" "}
      We&apos;re on it — your data is safe.
    </div>
  );
}
