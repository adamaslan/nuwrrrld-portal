/**
 * Firestore Admin SDK bootstrap — shared by the paper-portfolio mirror and
 * reconciliation modules (docs/council-paper-portfolios.md §5.1, Phase 6 of
 * docs/paper-portfolios-remaining-todo.md). The first Firestore client this
 * repo has ever needed — everything else here talks to Neon.
 *
 * Lazily initialized and memoized so importing this module has no side
 * effect until a caller actually needs Firestore. Returns null (never
 * throws) when `FIRESTORE_SERVICE_ACCOUNT_JSON` isn't configured or fails to
 * parse — every caller in lib/paper-firestore-mirror.ts and
 * lib/paper-reconcile.ts treats a null handle as "this run's mirror/reconcile
 * is a no-op," matching guardrail #7 (a failed or missing mirror never fails
 * the run).
 */
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let cached: Firestore | null | undefined; // undefined = not yet attempted this process
let warnedMissing = false;

export function getPaperFirestore(): Firestore | null {
  if (cached !== undefined) return cached;

  const raw = process.env.FIRESTORE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "[firestore-admin] FIRESTORE_SERVICE_ACCOUNT_JSON is not set — paper-portfolio " +
          "Firestore mirror/reconcile is disabled until it's provisioned (see " +
          "docs/manual-setup-todo.md).",
      );
    }
    cached = null;
    return cached;
  }

  try {
    const serviceAccount = JSON.parse(raw);
    const app: App = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
    cached = getFirestore(app);
  } catch (err) {
    console.error(
      `[firestore-admin] failed to initialize from FIRESTORE_SERVICE_ACCOUNT_JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cached = null;
  }
  return cached;
}

/** Test-only: force re-initialization (and re-warn-once) on the next call. */
export function __resetPaperFirestoreCache(): void {
  cached = undefined;
  warnedMissing = false;
}
