/**
 * se1/volume-floor — S26-43 dollar-volume floor persistence. Pure logic over daily bars; no I/O, no model call.
 *
 * Counts how many sessions in a declared window fall below a dollar-volume floor, and reports the
 * median and a low quantile, so one huge print cannot hide routinely thin trading.
 *
 * Denominators: eligible = bars in the window at or before the cutoff; computed = eligible bars with
 * usable close and volume; missing = eligible bars with an absent close or volume. A verified zero volume
 * is computed, counted in zero_volume, and is also a breach. Positive volume below the floor is a breach
 * that is not zero_volume. Missing bars are never a breach.
 */

export interface VolumeBar {
  /** Session date, YYYY-MM-DD. */
  date: string;
  close: number | null;
  volume: number | null;
}

export interface FloorOptions {
  /** Decision cutoff, YYYY-MM-DD. Bars dated after it are excluded, never used. */
  cutoff: string;
  /** Number of most recent sessions at or before the cutoff. Integer, at least 1. */
  window: number;
  /** Dollar-volume floor in USD. Finite and above zero. */
  floorUsd: number;
}

export type FloorResult =
  | {
      status: "computed";
      window: number;
      eligible: number;
      computed: number;
      missing: number;
      zero_volume: number;
      breach_count: number;
      median_usd: number;
      p10_usd: number;
      excluded_after_cutoff: number;
    }
  | { status: "unsupported"; reason: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new RangeError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
}

/** Nearest-rank median of a sorted, non-empty array. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile of a sorted, non-empty array. */
function nearestRank(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function dollarVolumeFloorPersistence(bars: readonly VolumeBar[], options: FloorOptions): FloorResult {
  const { cutoff, window, floorUsd } = options;
  requireIsoDate(cutoff, "cutoff");
  if (!Number.isInteger(window) || window < 1) throw new RangeError(`window must be an integer of at least 1, got ${window}`);
  if (!Number.isFinite(floorUsd) || floorUsd <= 0) throw new RangeError(`floorUsd must be finite and above zero, got ${floorUsd}`);

  for (const b of bars) requireIsoDate(b.date, "bar date");

  const dated = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const visible = dated.filter((b) => b.date <= cutoff);
  for (const b of visible) {
    if (b.close !== null && (!Number.isFinite(b.close) || b.close < 0)) throw new RangeError(`invalid close on ${b.date}`);
    if (b.volume !== null && (!Number.isFinite(b.volume) || b.volume < 0)) throw new RangeError(`invalid volume on ${b.date}`);
  }
  const excluded_after_cutoff = dated.length - visible.length;

  if (visible.length < window) {
    return { status: "unsupported", reason: `insufficient history: ${visible.length} bars at or before cutoff, window ${window}` };
  }

  const span = visible.slice(visible.length - window);
  let missing = 0;
  let zero_volume = 0;
  let breach_count = 0;
  const dollarVolumes: number[] = [];

  for (const b of span) {
    if (b.close === null || b.volume === null) {
      missing += 1;
      continue;
    }
    const usd = b.close * b.volume;
    dollarVolumes.push(usd);
    if (b.volume === 0) zero_volume += 1;
    if (usd < floorUsd) breach_count += 1;
  }

  if (dollarVolumes.length === 0) {
    return { status: "unsupported", reason: "no usable close and volume in window" };
  }

  dollarVolumes.sort((a, b) => a - b);
  return {
    status: "computed",
    window,
    eligible: span.length,
    computed: dollarVolumes.length,
    missing,
    zero_volume,
    breach_count,
    median_usd: median(dollarVolumes),
    p10_usd: nearestRank(dollarVolumes, 0.1),
    excluded_after_cutoff,
  };
}
