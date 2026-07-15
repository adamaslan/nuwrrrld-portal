import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// /dashboard (and any future /dashboard/* route) requires a signed-in session.
// Blocks unauthenticated requests at the edge before the page renders; the
// per-page auth() guard in app/dashboard/page.tsx stays as defense in depth.
const isProtectedRoute = createRouteMatcher(['/dashboard(.*)'])

// Defense-in-depth (audit 2026-07-15): these API routes already check auth
// inside their handlers, but that was the only line of defense — if a
// handler's own check is ever removed or refactored incorrectly, the route
// would be silently wide open. Enforce Clerk auth at the middleware layer
// too, so a handler-level regression fails closed instead of open.
const isProtectedApiRoute = createRouteMatcher([
  '/api/signals/digest(.*)',
  '/api/portfolio/health(.*)',
  '/api/holdfold(.*)',
])

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect()
    return
  }

  if (isProtectedApiRoute(req)) {
    // /api/signals/digest has one legitimate unauthenticated caller: trusted
    // internal server-to-server requests carrying the PORTAL_PUSH_SECRET
    // bearer token (see .env.example). Let those through to the handler's
    // own secret check instead of blocking them here.
    const secret = process.env.PORTAL_PUSH_SECRET
    const isInternalDigestCall =
      req.nextUrl.pathname.startsWith('/api/signals/digest') &&
      Boolean(secret) &&
      req.headers.get('authorization') === `Bearer ${secret}`

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
