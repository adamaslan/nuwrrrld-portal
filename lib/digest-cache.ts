import { adaptLiveSignals, type DigestPayload } from "@/lib/digest";
import {
  getLatestDigest,
  getLatestDigestAnyAge,
  getUserDigest,
  saveDigest,
  saveUserDigest,
} from "@/lib/digest-cache-db";

export const globalDigestCache: { digest: DigestPayload | null; pushedAt: number } = {
  digest: null,
  pushedAt: 0,
};

const FETCH_TIMEOUT_MS = 8_000;

// Per-user cache: Neon is the durable store (survives serverless cold starts —
// the #1 launch blocker); this Map is an in-process L1 in front of it. 15 min TTL
// matches signal freshness.
const USER_CACHE_TTL_MS = 15 * 60 * 1000;
const userCache = new Map<string, { digest: DigestPayload; expiresAt: number }>();

// Global cache freshness window before a live fetch is attempted.
const GLOBAL_CACHE_TTL_MS = 60 * 60 * 1000;

// Step 4's stale Neon row, remembered in-process so the degraded path doesn't
// re-read the full payload on every request. Digests are pushed only from local
// scripts, so past the 15 min Neon window every signals page load, digest API
// call and Nu AI message used to land here. Only a real row is kept (never a
// miss or a failed read), and it is always served marked degraded. Steps 2 and
// 3 still run first on every request, so a fresh row is never hidden; kept
// under the 15 min Neon window so a newer stale row can't be either.
const DEGRADED_MEMO_TTL_MS = 5 * 60 * 1000;
export const degradedDigestMemo: { digest: DigestPayload | null; expiresAt: number } = {
  digest: null,
  expiresAt: 0,
};

async function lastKnownDurableDigest(): Promise<DigestPayload | null> {
  if (degradedDigestMemo.digest && degradedDigestMemo.expiresAt > Date.now()) {
    return degradedDigestMemo.digest;
  }
  const digest = await getLatestDigestAnyAge();
  if (digest) {
    degradedDigestMemo.digest = digest;
    degradedDigestMemo.expiresAt = Date.now() + DEGRADED_MEMO_TTL_MS;
  }
  return digest;
}

async function fetchLiveSignals(): Promise<unknown> {
  const mcpUrl = process.env.MCP_BACKEND_URL;
  if (!mcpUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // GET /signals is public on the GCP3 backend — no auth header needed.
    const res = await fetch(`${mcpUrl}/signals`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single source of truth for the signals-digest fallback chain, shared by
 * the /api/signals/digest route and the server-rendered signals page — both
 * previously had their own copy, and the page's copy skipped every caching
 * layer, hitting the live backend on every page load.
 *
 * Order: per-user cache (fresh) -> global cache (fresh) -> live fetch
 * (caches on success) -> global cache (however stale: in-memory, then the newest
 * durable Neon row, which survives cold starts) marked degraded -> null.
 */
export async function getOrFetchDigest(
  userId: string | null | undefined,
): Promise<(DigestPayload & { degraded?: boolean }) | null> {
  // 1. Per-user: L1 in-memory, then durable Neon (survives cold starts).
  if (userId) {
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.digest;
    }
    const dbResult = await getUserDigest(userId);
    if (dbResult) {
      userCache.set(userId, { digest: dbResult.digest, expiresAt: dbResult.expiresAt.getTime() });
      return dbResult.digest;
    }
  }

  // 2. Global: L1 in-memory, then durable Neon.
  if (globalDigestCache.digest && Date.now() - globalDigestCache.pushedAt < GLOBAL_CACHE_TTL_MS) {
    return globalDigestCache.digest;
  }
  const dbGlobal = await getLatestDigest();
  if (dbGlobal) {
    globalDigestCache.digest = dbGlobal;
    globalDigestCache.pushedAt = Date.now();
    return dbGlobal;
  }

  // 3. Live fetch — persist to both L1 and Neon on success.
  const raw = await fetchLiveSignals();
  if (raw) {
    try {
      const digest = adaptLiveSignals(raw);
      if (userId) {
        const expiresAt = new Date(Date.now() + USER_CACHE_TTL_MS);
        userCache.set(userId, { digest, expiresAt: expiresAt.getTime() });
        await saveUserDigest(userId, digest, expiresAt);
      } else {
        // No user context (internal caller) — warm both L1 and durable cache.
        globalDigestCache.digest = digest;
        globalDigestCache.pushedAt = Date.now();
        await saveDigest(digest);
      }
      return digest;
    } catch {
      // Falls through to the degraded stale-cache path below.
    }
  }

  // 4. Graceful degradation: last-known global, however stale. The in-memory copy is
  // empty after a cold start, so fall through to the newest durable row.
  const lastKnown = globalDigestCache.digest ?? (await lastKnownDurableDigest());
  return lastKnown ? { ...lastKnown, degraded: true } : null;
}
