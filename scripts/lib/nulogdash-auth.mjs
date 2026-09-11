/**
 * Session auth for the /nulogdash sweep.
 *
 * The sweep used to read a hand-pasted Clerk `__session` cookie out of
 * NULOGDASH_SESSION_COOKIE. That could never work for more than a minute:
 * Clerk session cookies are short-lived JWTs that clerk-js refreshes in the
 * browser, and on a *development* instance they are suffixed
 * (`__session_<suffix>`) so the bare name isn't even the right cookie. Result:
 * the var sat empty and all 38 auth-required features reported `blocked`
 * forever (docs/wiki-portal/entity-nulogdash.md, known failure 3).
 *
 * Instead we mint a session token server-side, per run, from CLERK_SECRET_KEY
 * and the same dedicated test user the Playwright suite signs in as
 * (E2E_CLERK_TEST_EMAIL) — then present it as `Authorization: Bearer <jwt>`,
 * which Clerk's request authenticator accepts without any cookie-suffix or
 * handshake machinery. Verified both ways against the live dev instance: the
 * cookie form 401s, the bearer form reaches the handler.
 *
 * The minted token's TTL is TOKEN_TTL_SECONDS and it is re-minted whenever it
 * is within TOKEN_REFRESH_MARGIN_S of expiry, so a long sweep can't half-fail
 * on an expired token partway through.
 */
import { createClerkClient } from "@clerk/backend";

const TOKEN_TTL_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_S = 300;

/** A bearer JWT minted from an explicit cookie value can't be derived, so an
 *  operator-supplied NULOGDASH_SESSION_COOKIE is still honoured as a cookie —
 *  it just isn't the path anyone should need any more. */
function explicitCookieAuth(cookie) {
  return {
    ok: true,
    mode: "cookie (NULOGDASH_SESSION_COOKIE)",
    headersFor: () => ({ cookie: `__session=${cookie}` }),
  };
}

async function mintedBearerAuth() {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  const email = process.env.E2E_CLERK_TEST_EMAIL?.trim();

  if (!secretKey) {
    return { ok: false, reason: "CLERK_SECRET_KEY not set — cannot mint a sweep session" };
  }
  if (!email) {
    return {
      ok: false,
      reason: "E2E_CLERK_TEST_EMAIL not set — needed to mint a sweep session for the test user",
    };
  }

  const clerk = createClerkClient({ secretKey });

  let userId;
  try {
    const { data } = await clerk.users.getUserList({ emailAddress: [email] });
    if (data.length === 0) {
      return { ok: false, reason: `no Clerk user matches E2E_CLERK_TEST_EMAIL on this instance` };
    }
    userId = data[0].id;
  } catch (err) {
    return {
      ok: false,
      reason: `Clerk user lookup failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  let sessionId = null;
  let token = null;
  let expiresAt = 0;

  async function ensureSession() {
    if (sessionId) return sessionId;
    // Reuse a live session when the test user has one (the Playwright suite
    // leaves them behind), so a sweep doesn't pile up a new session per run.
    const { data } = await clerk.sessions.getSessionList({ userId, status: "active" });
    sessionId = data[0]?.id ?? (await clerk.sessions.createSession({ userId })).id;
    return sessionId;
  }

  async function ensureToken() {
    const nowS = Math.floor(Date.now() / 1000);
    if (token && expiresAt - nowS > TOKEN_REFRESH_MARGIN_S) return token;
    const id = await ensureSession();
    const { jwt } = await clerk.sessions.getToken(id, undefined, TOKEN_TTL_SECONDS);
    token = jwt;
    expiresAt = nowS + TOKEN_TTL_SECONDS;
    return token;
  }

  // Fail the preflight, not the first feature, if minting is broken.
  try {
    await ensureToken();
  } catch (err) {
    return {
      ok: false,
      reason: `Clerk session mint failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  return {
    ok: true,
    mode: `bearer (minted for ${email})`,
    userId,
    headersFor: async () => ({ authorization: `Bearer ${await ensureToken()}` }),
  };
}

/**
 * Resolve how the sweep should authenticate as a signed-in user.
 * @returns `{ ok: true, mode, headersFor() }` or `{ ok: false, reason }`.
 */
export async function resolveSessionAuth() {
  const explicit = process.env.NULOGDASH_SESSION_COOKIE?.trim();
  if (explicit) return explicitCookieAuth(explicit);
  return mintedBearerAuth();
}
