/**
 * hydrate-rows — pure classification of rows a compute host posts to
 * /api/pipeline/hydrate-universe. No I/O, so it is unit-testable without a DB.
 */

/**
 * True only when the host explicitly tagged the error `unservable` (the vendor
 * has no bars for the symbol). Never inferred from the error string: a host
 * that omits `errorKind` keeps the old behaviour and counts as an upstream
 * error.
 */
export function isUnservableRow(row: { status?: string; errorKind?: string } | null | undefined): boolean {
  return row?.status === "error" && row.errorKind === "unservable";
}

/** Share of a request that may be classified `unservable` before it stops
 *  looking like a handful of dead symbols and starts looking like a vendor or
 *  network outage that returned empty bars for everything. */
const UNSERVABLE_MAX_FRACTION = 0.25;
const UNSERVABLE_MIN_ALLOWANCE = 8;

/**
 * True when `unservableCount` is plausible as dead symbols. Above the ceiling
 * the caller must count those rows as upstream errors again, so an outage can
 * never turn into a green run of "skips".
 */
export function unservableWithinCeiling(unservableCount: number, totalRows: number): boolean {
  if (unservableCount <= 0) return true;
  return unservableCount <= Math.max(UNSERVABLE_MIN_ALLOWANCE, Math.floor(totalRows * UNSERVABLE_MAX_FRACTION));
}
