import { NextResponse } from "next/server";
import sql from "@/lib/db";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 5_000;

type DepStatus = "ok" | "degraded" | "down" | "not_configured";

interface DepResult {
  status: DepStatus;
  latencyMs: number | null;
  error?: string;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function checkMcp(): Promise<DepResult> {
  const start = Date.now();
  try {
    const res = await withTimeout((signal) => fetch(`${MCP_URL}/health`, { signal }));
    return { status: res.ok ? "ok" : "degraded", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "down", latencyMs: null, error: err instanceof Error ? err.message : "unreachable" };
  }
}

async function checkNeon(): Promise<DepResult> {
  const start = Date.now();
  try {
    await sql`SELECT 1`;
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "down", latencyMs: null, error: err instanceof Error ? err.message : "query failed" };
  }
}

async function checkStripe(): Promise<DepResult> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { status: "not_configured", latencyMs: null, error: "STRIPE_SECRET_KEY not set" };
  const start = Date.now();
  try {
    // Lightweight, cheap call just to confirm the key is valid and Stripe is reachable.
    const res = await withTimeout((signal) =>
      fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      }),
    );
    return { status: res.ok ? "ok" : "degraded", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "down", latencyMs: null, error: err instanceof Error ? err.message : "unreachable" };
  }
}

async function checkOpenRouter(): Promise<DepResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { status: "not_configured", latencyMs: null, error: "OPENROUTER_API_KEY not set" };
  const start = Date.now();
  try {
    const res = await withTimeout((signal) =>
      fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      }),
    );
    return { status: res.ok ? "ok" : "degraded", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "down", latencyMs: null, error: err instanceof Error ? err.message : "unreachable" };
  }
}

export async function GET() {
  const [mcp, neon, stripe, openrouter] = await Promise.all([
    checkMcp(),
    checkNeon(),
    checkStripe(),
    checkOpenRouter(),
  ]);

  const deps = { mcp, neon, stripe, openrouter };
  // Neon down is a hard failure (every persisted feature breaks); Stripe/OpenRouter
  // not_configured is expected in some previews, so only "down" counts against them.
  const anyDown = Object.values(deps).some((d) => d.status === "down");
  const anyDegraded = Object.values(deps).some((d) => d.status === "degraded");
  const overall = anyDown ? "down" : anyDegraded ? "degraded" : "ok";

  return NextResponse.json(
    { status: overall, ...deps, ts: new Date().toISOString() },
    { status: overall === "down" ? 503 : 200 },
  );
}
