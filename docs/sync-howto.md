# How to Keep the Web Portal and Mobile App in Sync

NuWrrrld Financial ships as **two surfaces** over **one Clerk user pool** and the
**same backend services**:

| Surface | Path | Stack | Auth |
|---|---|---|---|
| **Web** | `nuwrrrld-portal` (this repo) | Next.js 16 + React 19 + TS | `@clerk/nextjs` — `proxy.ts` `clerkMiddleware`, server `auth()` |
| **Mobile** | `/Users/adamaslan/code/gcp3-mobile` | Expo / React Native + TS | `@clerk/clerk-expo` — `useSSO`, `useAuth` |

The goal of "strong sync" is simple: **write the logic once, let only the UI and
platform glue diverge.** This doc is the practical checklist. For the deeper
reference (auth parity tables, OAuth details) use the `nuwrrrld-fullstack` skill.

---

## The golden rule — single-source the core

The canonical shared core lives in **`gcp3-mobile/lib/`**. It is already
platform-agnostic (pure typed `fetch`, no `react-native`/`expo`/`react` imports):

- `lib/clients/{gcp3,holdfold,aitext,council}.ts` — typed API clients + request/response interfaces
- `lib/http.ts`, `lib/api.ts` — HTTP layer
- `lib/config-validator.ts`, `lib/monitoring.ts`, `lib/resilience/*` — pure logic
- `lib/auth-constants.ts`, `lib/ui/theme.ts` — constants / tokens

**Business logic, types, validation, and prompts are written ONCE in the canonical
copy.** The portal *consumes* the same code — never re-implement it here.

Only these may differ per surface:
- **UI** — RN components/screens (`gcp3-mobile/screens/`, `components/`) vs React-DOM (`nuwrrrld-portal/app/`)
- **Platform glue** — `expo-secure-store` vs cookies; `useSSO`/`useAuth` vs `clerkMiddleware`/`auth()`; deep links vs routes

---

## The sharing mechanism (no monorepo yet)

There are two separate repos with separate `node_modules`. Until a shared workspace
package exists, **"share" = canonical in mobile, mirrored into the portal under
`nuwrrrld-portal/lib/shared/`, kept byte-identical except for the URL seam.**

1. Edit the canonical file in `gcp3-mobile/lib/...`.
2. Copy it to `nuwrrrld-portal/lib/shared/...` (create the dir if absent).
3. In the mirror, the **only** allowed edit is the base-URL seam (below). Anything
   else means the logic wasn't really shared — push it back into the canonical file.
4. Guard against drift with `diff` (see Verify) — the only differences allowed are
   the documented seam.

> **Eventual upgrade (propose, don't auto-do):** promote `lib/` to a shared
> workspace package both surfaces import via path alias, eliminating the mirror.
> Until then, the diff guard *is* the contract.

---

## The one seam: backend base URLs

The clients resolve their base URL from `process.env.EXPO_PUBLIC_*`, e.g.:

```ts
// gcp3-mobile/lib/clients/holdfold.ts
const BASE_URL =
  process.env.EXPO_PUBLIC_HOLDFOLD_BACKEND_URL || 'http://localhost:8081';
```

`EXPO_PUBLIC_*` leaks the URL into the client bundle. That's fine for mobile but
**wrong for web**, where backend calls must stay server-side. When sharing a client
to web, do **not** hardcode `EXPO_PUBLIC_*`. Either:

- **Preferred:** add an optional `baseUrl` / config argument to the client and pass
  it in, or
- Resolve it from a **non-public** var (`HOLDFOLD_BACKEND_URL`, *not* `NEXT_PUBLIC_*`)
  inside a Next.js **route handler**, and call the client only from there.

The fetch/parsing/typing stay identical; the env difference is isolated to one
resolver.

---

## Workflow for any cross-surface feature

1. **Classify the change:** shared-core | web-UI | native-UI | auth/config. Most
   features have a shared-core part — do it first so both UIs build on it.
2. **Edit the canonical shared core** in `gcp3-mobile/lib/`; mirror it into
   `nuwrrrld-portal/lib/shared/`. Never parallelize this step — it's the sync point.
3. **Wire web:** a Next.js **route handler** (server-side, Clerk-session-gated, base
   URL from a non-public env var) under `app/api/...`, plus the UI section in
   `app/dashboard/` (or the relevant route).
4. **Wire native:** the screen/component in `gcp3-mobile/screens/` or `components/`,
   importing the canonical client, gated by `useAuth`.
5. Steps 3 and 4 are independent once the shared core lands — do them sequentially,
   or as two concurrent workstreams if asked.
6. **Verify both** — a feature isn't done until both repos build clean.

### Example: exposing `holdfold` analysis on the web

```ts
// nuwrrrld-portal/app/api/holdfold/route.ts
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { analyzeHoldFold } from "@/lib/shared/clients/holdfold";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  // base URL from a NON-public var, resolved server-side only
  const verdict = await analyzeHoldFold(body, {
    baseUrl: process.env.HOLDFOLD_BACKEND_URL,
  });
  return NextResponse.json(verdict);
}
```

The browser calls `/api/holdfold`; the backend URL never reaches the client bundle.

---

## Auth parity

Both surfaces share **one Clerk user pool** and **one Google OAuth Web client**
(served via `clerk.nuwrrrld.com` — don't create per-surface Google clients).

| Concern | Web (this repo) | Mobile |
|---|---|---|
| Provider | `<ClerkProvider>` in `app/layout.tsx` | `<ClerkProvider … tokenCache>` |
| Sign-in | `<SignIn/>` page + hosted accounts | `useSSO().startSSOFlow({ strategy:'oauth_google' })` |
| Gate | `proxy.ts` `clerkMiddleware` + `createRouteMatcher(['/dashboard(.*)'])` + server `auth()` | `useAuth()` / `isSignedIn` |
| Post-auth dest | `/dashboard` (`NEXT_PUBLIC_CLERK_SIGN_{IN,UP}_FALLBACK_REDIRECT_URL`) | tabs |

The single source of truth for Clerk/auth config state is
`/Users/adamaslan/code/homebase/authodo.md` — read it before touching Clerk config
and update it when you change config.

---

## Verify (run before considering a change done)

```bash
# Web — must pass; expect "ƒ Proxy (Middleware)" in the output
cd /Users/adamaslan/code/nuwrrrld-portal && npm run build

# Mobile — type-check shared core + screens
cd /Users/adamaslan/code/gcp3-mobile && npx tsc --noEmit

# Drift guard — run per shared file; the ONLY diff allowed is the base-URL seam
diff /Users/adamaslan/code/gcp3-mobile/lib/clients/holdfold.ts \
     /Users/adamaslan/code/nuwrrrld-portal/lib/shared/clients/holdfold.ts
```

---

## Shipping a cross-surface change: PRs in both repos

The two surfaces are **separate GitHub repos with separate remotes** — there is no
single PR that covers both. A cross-surface feature lands as **two coordinated PRs**:

| Surface | Repo | Remote | Default base |
|---|---|---|---|
| **Web** | `nuwrrrld-portal` | `github.com/adamaslan/nuwrrrld-portal` | `main` |
| **Mobile** | `gcp3-mobile` | `github.com/adamaslan/gcp-expo1` | `main` |

### Conventions

- **Use the same branch name in both repos**, e.g. `feat/holdfold-on-web`. It makes
  the pair obvious and lets the helper command operate on both identically.
- **Cross-link the PRs.** Put the sibling PR's URL in each PR body (`Pairs with:
  <url>`) so a reviewer can find the other half. Land them together.
- **Shared-core changes go in the mobile PR** (canonical), and the **mirror copy**
  (`nuwrrrld-portal/lib/shared/...`) goes in the web PR. Call out in both bodies that
  they must stay byte-identical except the URL seam, and that the `diff` guard passed.
- **Security scan before every commit** (no `.env`, no `sk_live`/`CLERK_SECRET_KEY`,
  no `EXPO_PUBLIC_*`/`NEXT_PUBLIC_*` secrets) — see the `/pr` command in each repo.

### Commands

Each repo has a `/pr` slash command (`.claude/commands/pr.md`) that scans for
secrets, branches, commits, pushes, and opens a PR for **that repo**. For a
cross-surface change, both repos also carry a **`/sync-pr`** command
(`.claude/commands/sync-pr.md`) that drives the dual-PR flow end-to-end:

```
/sync-pr feat/holdfold-on-web "expose holdfold analysis on web"
```

The same coordination reference and command live in the homebase hub at
`/Users/adamaslan/code/homebase/dual-pr-howto.md` and
`/Users/adamaslan/code/homebase/.claude/commands/sync-pr.md`. Manual equivalent:

```bash
# 1. Mobile (canonical shared core lands here)
cd /Users/adamaslan/code/gcp3-mobile
git checkout -b feat/holdfold-on-web
# ...security scan + stage safe files + commit + push...
gh pr create --base main --title "feat: holdfold analysis (shared core)" \
  --body "Pairs with: <web PR url>"

# 2. Web (mirror + route handler + UI land here)
cd /Users/adamaslan/code/nuwrrrld-portal
git checkout -b feat/holdfold-on-web
# ...security scan + stage safe files + commit + push...
gh pr create --base main --title "feat: holdfold analysis on web" \
  --body "Pairs with: <mobile PR url>"

# 3. Edit each PR body to fill in the sibling URL once both exist
gh pr edit <n> --repo adamaslan/gcp-expo1     --body "...Pairs with: <web url>"
gh pr edit <n> --repo adamaslan/nuwrrrld-portal --body "...Pairs with: <mobile url>"
```

> Open both PRs before filling in `Pairs with:` — you need both URLs to cross-link.
> Don't merge one without the other; a half-landed shared-core change drifts the mirror.

---

## Guardrails

- **Never** put `sk_live` / `CLERK_SECRET_KEY` in `EXPO_PUBLIC_*` or `NEXT_PUBLIC_*`.
- **Web backend URLs stay server-side:** route handlers + `HOLDFOLD_BACKEND_URL`
  (no `NEXT_PUBLIC_`). Mobile uses `EXPO_PUBLIC_*` by necessity.
- **Next.js 16 middleware is `proxy.ts`, not `middleware.ts`** — the build registers
  it as `ƒ Proxy (Middleware)`. Don't "fix" it to `middleware.ts`.
- **One Google OAuth Web client** serves web + native. Don't create per-surface clients.
- **`.env*` are gitignored and hold credentials** — append, never clobber; never commit.
- **Archive, never delete** superseded docs/code (`docs/archive/`, `file-archive/`).
- **Don't re-implement shared logic in the portal.** If you're tempted to, it belongs
  in `gcp3-mobile/lib/` instead — write it there and mirror it.
