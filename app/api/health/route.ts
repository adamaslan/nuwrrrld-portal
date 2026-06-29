import { NextResponse } from "next/server";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 5_000;

export async function GET() {
  const start = Date.now();

  let mcpStatus: "ok" | "degraded" | "down" = "down";
  let mcpLatencyMs: number | null = null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/health`, { signal: controller.signal });
    mcpLatencyMs = Date.now() - start;
    mcpStatus = res.ok ? "ok" : "degraded";
  } catch {
    mcpStatus = "down";
  } finally {
    clearTimeout(timer);
  }

  const overall = mcpStatus === "ok" ? "ok" : mcpStatus === "degraded" ? "degraded" : "down";

  return NextResponse.json(
    { status: overall, mcp: { status: mcpStatus, latencyMs: mcpLatencyMs }, ts: new Date().toISOString() },
    { status: overall === "down" ? 503 : 200 }
  );
}
