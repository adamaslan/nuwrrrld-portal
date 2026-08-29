import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { bearerTokenMatches } from '@/lib/http-auth'

// /dashboard (and any future /dashboard/* route) requires a signed-in session.
// Blocks unauthenticated requests at the edge before the page renders; the
// per-page auth() guard in app/dashboard/page.tsx stays as defense in depth.
const isProtectedRoute = createRouteMatcher(['/dashboard(.*)'])

// -------------------------------------------------------------------------
// API route auth classification (docs/todo-auth-cookies-tracking.md Phase 1.3)
//
// Every route under app/api/ falls into exactly one bucket:
//
//   auth-required     — reads/writes per-user rows; handler calls Clerk auth().
//                       Listed below so a handler-level regression fails closed
//                       at the edge instead of silently open.
//   internal-secret   — server-to-server only, Bearer PORTAL_PUSH_SECRET /
//                       CRON_SECRET / LAUNCH_REMIND_SECRET. NOT in the matcher:
//                       a Clerk session is never presented, so auth.protect()
//                       would 404 the legitimate caller. The handler does a
//                       timing-safe bearer check (lib/http-auth.ts).
//   webhook-signed    — /api/webhooks/*. Provider-signed (svix / Stripe). NOT
//                       in the matcher, by design: the signature IS the auth.
//   public            — landing-page / health / cookieless demo. No auth.
//
// The full table lives in docs/API-ROUTE-AUTH.md — keep the two in sync.
// -------------------------------------------------------------------------
const isProtectedApiRoute = createRouteMatcher([
  // Existing (audit 2026-07-15)
  '/api/signals/digest(.*)',
  '/api/portfolio/health(.*)',
  '/api/holdfold(.*)',
  // Added Phase 1.3 — per-user routes that were handler-guarded only
  '/api/analyze(.*)',
  '/api/backtest(.*)',
  '/api/brief(.*)',
  '/api/council(.*)',
  '/api/nuai(.*)',
  '/api/disclaimer(.*)',
  '/api/legal-consent(.*)',
  '/api/push/register(.*)',
  '/api/referral(.*)',
  '/api/retention/streak(.*)',
  '/api/portfolio/health-ai(.*)',
  '/api/portfolio/suggestions(.*)',
  '/api/portfolio/watchlist(.*)',
  '/api/privacy/export(.*)',
  '/api/privacy/profile(.*)',
  '/api/privacy/delete(.*)',
  '/api/signals/(.*)/chat(.*)',
  '/api/stripe/checkout(.*)',
  '/api/stripe/portal(.*)',
  '/api/stripe/subscription(.*)',
])

// Routes inside a protected prefix that nonetheless have a legitimate
// unauthenticated caller: a trusted server-to-server request bearing
// PORTAL_PUSH_SECRET. Those are let through to the handler's own timing-safe
// secret check instead of being blocked at the edge.
//   /api/signals/digest — the digest push pipeline (see .env.example)
//   /api/council/public — anonymous landing-page demo, cookieless, ticker-only
//   /api/council/sample — cached SPY sample for the landing page, no auth
const isPublicCouncilRoute = createRouteMatcher([
  '/api/council/public(.*)',
  '/api/council/sample(.*)',
])

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect()
    return
  }

  if (isProtectedApiRoute(req) && !isPublicCouncilRoute(req)) {
    const secret = process.env.PORTAL_PUSH_SECRET
    const pathname = req.nextUrl.pathname
    const isInternalDigestCall =
      pathname.startsWith('/api/signals/digest') &&
      bearerTokenMatches(req.headers.get('authorization'), secret)

    if (!isInternalDigestCall) {
      await auth.protect()
    }
  }
})

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
}
