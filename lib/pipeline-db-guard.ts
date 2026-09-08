/**
 * pipeline-db-guard — refuse a live (writing) pipeline run when DATABASE_URL
 * resolves to the production Neon branch.
 *
 * Why this exists: `scripts/local-trigger.mjs --no-dry-run` and the nulogdash
 * trigger buttons (docs/admin-console-todo.md §2/§5) both fire a real pipeline
 * run against whatever `DATABASE_URL` names. Nothing else distinguishes a dev
 * Neon branch from production, so "remember not to point local at prod" was a
 * habit rather than a control. This turns it into a structural check keyed on
 * one env var, `PRODUCTION_DB_HOST`.
 *
 * The guard is opt-in: with `PRODUCTION_DB_HOST` unset it allows everything
 * (warning once that it is inert), so it can land before the value is known.
 * Set `PRODUCTION_DB_HOST` to the production branch host in every environment
 * that must never take a live local / dashboard run.
 *
 * Never logs `DATABASE_URL` or any connection string — only bare host names.
 */

/** Raised by `assertNotProductionDb` when the live run would hit production. */
export class ProductionDbWriteError extends Error {
  constructor(context: string) {
    super(
      `Refusing to run "${context}": DATABASE_URL resolves to the host named by ` +
        `PRODUCTION_DB_HOST. Point it at a dev branch, or clear PRODUCTION_DB_HOST ` +
        `if this is genuinely intended.`,
    );
    this.name = "ProductionDbWriteError";
  }
}

/**
 * Host portion of a Postgres connection URL, lower-cased, or `null` when it
 * cannot be parsed. A standard `postgresql` connection string (with or without
 * an embedded credential and query params) is parsed by `URL`; a bare host or a
 * malformed string returns `null`.
 */
export function resolveDbHost(
  url: string | undefined = process.env.DATABASE_URL,
): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

let warnedInert = false;

/**
 * Throw `ProductionDbWriteError` when the configured production host matches
 * the host `DATABASE_URL` currently points at. No-op when `PRODUCTION_DB_HOST`
 * is unset (warns once) or when the hosts differ.
 *
 * @param context short human label for the guarded operation, shown in the
 *   error message (e.g. `"nulogdash live pipeline trigger"`).
 */
export function assertNotProductionDb(context: string): void {
  const prodHost = process.env.PRODUCTION_DB_HOST?.trim().toLowerCase();
  if (!prodHost) {
    if (!warnedInert) {
      warnedInert = true;
      console.warn(
        "[pipeline-db-guard] PRODUCTION_DB_HOST is unset — the live-run guard " +
          "is inert. Set it to the production Neon branch host to enable.",
      );
    }
    return;
  }
  if (resolveDbHost() === prodHost) {
    throw new ProductionDbWriteError(context);
  }
}

/** Test-only: reset the once-warned latch. */
export function __resetDbGuardWarnLatch(): void {
  warnedInert = false;
}
