import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// /dashboard (and any future /dashboard/* route) requires a signed-in session.
// Blocks unauthenticated requests at the edge before the page renders; the
// per-page auth() guard in app/dashboard/page.tsx stays as defense in depth.
const isProtectedRoute = createRouteMatcher(['/dashboard(.*)'])

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect()
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
