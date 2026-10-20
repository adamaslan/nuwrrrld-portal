import { NextResponse } from "next/server";
import sql from "@/lib/db";
import { PRICES } from "@/lib/stripe";
import { nyseSessionsBetween } from "@/lib/shared/nyse-calendar";
import { newYorkDate } from "@/scripts/lib/hydrate-indicators.mjs";

// No default host: slot 1 (gcp3-backend) is being retired, and a hard-coded
// fallback would keep probing it after cutover. Unset means not_configured.
const TIMEOUT_MS = 5_000;
// Sessions behind today before the card data counts as stale. One session is
// normal (today's bar lands after the close); two means the writer missed a run.
const CARDS_STALE_TRADING_DAYS = 2;

type DepStatus = "ok" | "degraded" | "down" | "not_configured";

interface DepResult {
  status: DepStatus;
  latencyMs: number | null;
  error?: string;
}

function unreachableStatus(error: unknown): DepStatus {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
    ? "degraded"
    : "down";
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
  const mcpUrl = process.env.MCP_BACKEND_URL;
  if (!mcpUrl) return { status: "not_configured", latencyMs: null, error: "MCP_BACKEND_URL not set" };
  const start = Date.now();
  try {
    const res = await withTimeout((signal) => fetch(`${mcpUrl}/health`, { signal }));
    return { status: res.ok ? "ok" : "degraded", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: unreachableStatus(err), latencyMs: null, error: "unreachable" };
  }
}

async function checkNeon(): Promise<DepResult> {
  const start = Date.now();
  try {
    await sql`SELECT 1`;
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: unreachableStatus(err), latencyMs: null, error: "query failed" };
  }
}

/** Freshness of the ticker cards the portal serves. Reads the newest bar date
 *  directly (not via latestCardBarDate, which hides query errors as null), so
 *  a dead writer shows up here as stale and a dead database as a query error. */
async function checkCardFreshness(): Promise<DepResult> {
  const start = Date.now();
  let latest: unknown;
  try {
    const rows = await sql`SELECT MAX(bar_date) AS latest FROM ticker_cards`;
    latest = rows[0]?.latest;
  } catch {
    return { status: "degraded", latencyMs: null, error: "freshness query failed" };
  }
  if (latest == null) {
    return { status: "degraded", latencyMs: Date.now() - start, error: "ticker_cards is empty" };
  }
  const latestIso = latest instanceof Date ? latest.toISOString().slice(0, 10) : String(latest).slice(0, 10);
  const staleTradingDays = nyseSessionsBetween(
    new Date(`${latestIso}T00:00:00Z`),
    new Date(`${newYorkDate(new Date())}T00:00:00Z`),
  );
  const status: DepStatus = staleTradingDays >= CARDS_STALE_TRADING_DAYS ? "degraded" : "ok";
  return {
    status,
    latencyMs: Date.now() - start,
    ...(status === "degraded" ? { error: `latest bar ${latestIso} is ${staleTradingDays} trading days old` } : {}),
  };
}

async function checkStripe(): Promise<DepResult> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { status: "not_configured", latencyMs: null, error: "STRIPE_SECRET_KEY not set" };

  // Checkout can't complete without real price IDs — catch this before a user
  // hits the "price not configured" 500 in app/api/stripe/checkout/route.ts.
  const missingPrice = (["monthly", "annual"] as const).find(
    (plan) => !PRICES[plan] || PRICES[plan].includes("placeholder"),
  );
  if (missingPrice) {
    return {
      status: "not_configured",
      latencyMs: null,
      error: `STRIPE_PRICE_${missingPrice.toUpperCase()} is unset or a placeholder`,
    };
  }

  // Inbound sync (checkout.session.completed, subscription created/updated/
  // deleted, invoice.payment_failed) is dead until this is a real signing
  // secret — app/api/webhooks/stripe/route.ts fails closed on the same
  // placeholder check. Without this, health can report "ok" (key valid,
  // prices valid) while every Stripe webhook 500s and no subscription ever
  // activates — the outbound path looks fine and the inbound path is silent.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.startsWith("whsec_placeholder")) {
    return {
      status: "not_configured",
      latencyMs: null,
      error: "STRIPE_WEBHOOK_SECRET is unset or a placeholder — webhook events will 500",
    };
  }

  const start = Date.now();
  try {
    // Lightweight, cheap call just to confirm the key is valid and Stripe is reachable.
    // A malformed key (e.g. stray newline from a copy-paste) throws here with
    // something like "Invalid character in header content [\"Authorization\"]" —
    // surfaced via err.message below rather than a generic "unreachable".
    const res = await withTimeout((signal) =>
      fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      }),
    );
    return { status: res.ok ? "ok" : "degraded", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: unreachableStatus(err), latencyMs: null, error: "unreachable" };
  }
}

async function checkClerk(): Promise<DepResult> {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!key) {
    // Missing entirely in production means auth is completely broken, not
    // just "not set up yet" — that's a degraded (down-counting) state, unlike
    // preview/dev environments where an unset key is an expected inert state.
    return process.env.VERCEL_ENV === "production"
      ? { status: "degraded", latencyMs: null, error: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY not set in production" }
      : { status: "not_configured", latencyMs: null, error: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY not set" };
  }

  // A Clerk Development instance key (pk_test_...) backing a live production
  // domain has MAU/sign-up caps and isn't meant for this — flag it loudly
  // instead of letting it silently cap or break sign-up.
  if (process.env.VERCEL_ENV === "production" && key.startsWith("pk_test_")) {
    return {
      status: "degraded",
      latencyMs: null,
      error: "using a Clerk Development instance key (pk_test_...) in production",
    };
  }

  return { status: "ok", latencyMs: null };
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
    return { status: unreachableStatus(err), latencyMs: null, error: "unreachable" };
  }
}

export async function GET() {
  const [mcp, neon, cards, stripe, openrouter, clerk] = await Promise.all([
    checkMcp(),
    checkNeon(),
    checkCardFreshness(),
    checkStripe(),
    checkOpenRouter(),
    checkClerk(),
  ]);

  const deps = { mcp, neon, cards, stripe, openrouter, clerk };
  // Neon down is a hard failure (every persisted feature breaks); Stripe/OpenRouter
  // not_configured is expected in some previews, so only "down" counts against them.
  const anyDown = Object.values(deps).some((d) => d.status === "down");
  const anyDegraded = Object.values(deps).some((d) => d.status === "degraded");
  const overall = anyDown ? "down" : anyDegraded ? "degraded" : "ok";

  return NextResponse.json(
    { status: overall, ...deps, ts: new Date().toISOString() },
    { status: overall === "down" ? 503 : 200, headers: { "Cache-Control": "public, s-maxage=60" } },
  );
}
