/**
 * se1/volume-participation — S26-45 volume concentration fragility and S26-46 up/down participation asymmetry.
 * Pure logic over daily bars; no I/O, no model call.
 *
 * S26-45 tests whether a window's volume is carried by a few sessions. S26-46 reports signed-volume components,
 * not an accumulation score. Both are daily-price proxies, never buyer or seller identity or order flow.
 */

export interface ParticipationBar {
  /** Session date, YYYY-MM-DD. */
  date: string;
  close: number | null;
  volume: number | null;
}

export interface ParticipationOptions {
  /** Decision cutoff, YYYY-MM-DD. Bars after it are excluded and counted. */
  cutoff: string;
  /** Sessions in the window at or before the cutoff. Integer, at least 2. */
  window: number;
}

export type Unsupported = { status: "unsupported"; reason: string };

export type ConcentrationResult =
  | {
      status: "computed";
      window: number;
      top_k: number;
      concentration_top_k: number;
      /** Sessions whose volume is at least EVENT_MULTIPLE times the window median. */
      events_excluded: number;
      baseline_remaining: number;
      spike_dominated: boolean;
      excluded_after_cutoff: number;
    }
  | Unsupported;

export type AsymmetryResult =
  | {
      status: "computed";
      window: number;
      up_volume: number;
      down_volume: number;
      flat_volume: number;
      flat_days: number;
      missing_days: number;
      /** up / (up + down). Null when neither side has volume: never a division by zero. */
      up_share: number | null;
      excluded_after_cutoff: number;
    }
  | Unsupported;

/** A session at least this many times the window median is an event, not baseline participation. */
export const EVENT_MULTIPLE = 5;
/** Top-k share above this means the window is dominated by a few sessions. */
export const SPIKE_SHARE = 0.5;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new RangeError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
}

function validate(bars: readonly ParticipationBar[], options: ParticipationOptions): ParticipationBar[] {
  requireIsoDate(options.cutoff, "cutoff");
  if (!Number.isInteger(options.window) || options.window < 2) {
    throw new RangeError(`window must be an integer of at least 2, got ${options.window}`);
  }
  for (const b of bars) {
    requireIsoDate(b.date, "bar date");
    if (b.close !== null && (!Number.isFinite(b.close) || b.close < 0)) throw new RangeError(`invalid close on ${b.date}`);
    if (b.volume !== null && (!Number.isFinite(b.volume) || b.volume < 0)) throw new RangeError(`invalid volume on ${b.date}`);
  }
  return [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** S26-45: how much of the window's volume sits in its top sessions, and whether one event dominates. */
export function volumeConcentration(bars: readonly ParticipationBar[], options: ParticipationOptions, topK = 3): ConcentrationResult {
  const sorted = validate(bars, options);
  if (!Number.isInteger(topK) || topK < 1) throw new RangeError(`topK must be an integer of at least 1, got ${topK}`);

  const visible = sorted.filter((b) => b.date <= options.cutoff);
  const excluded_after_cutoff = sorted.length - visible.length;
  if (visible.length < options.window) {
    return { status: "unsupported", reason: `insufficient history: ${visible.length} bars at or before cutoff, window ${options.window}` };
  }

  const span = visible.slice(visible.length - options.window);
  const volumes = span.flatMap((b) => (b.volume === null ? [] : [b.volume]));
  if (volumes.length < topK) {
    return { status: "unsupported", reason: `only ${volumes.length} usable volumes in window, need at least ${topK}` };
  }

  const total = volumes.reduce((a, v) => a + v, 0);
  if (total === 0) return { status: "unsupported", reason: "window has no volume" };

  const desc = [...volumes].sort((a, b) => b - a);
  const top = desc.slice(0, topK).reduce((a, v) => a + v, 0);
  const concentration_top_k = top / total;

  const med = median([...volumes].sort((a, b) => a - b));
  const events = volumes.filter((v) => med > 0 && v >= EVENT_MULTIPLE * med).length;

  return {
    status: "computed",
    window: options.window,
    top_k: topK,
    concentration_top_k: concentration_top_k,
    events_excluded: events,
    baseline_remaining: volumes.length - events,
    spike_dominated: concentration_top_k > SPIKE_SHARE,
    excluded_after_cutoff,
  };
}

/**
 * S26-46: signed-volume components over the window. A session is up or down by its close against the prior
 * session's close, which must sit inside the bars at or before the cutoff. Flat sessions and missing sessions are
 * counted separately, never assigned a side.
 */
export function participationAsymmetry(bars: readonly ParticipationBar[], options: ParticipationOptions): AsymmetryResult {
  const sorted = validate(bars, options);
  const visible = sorted.filter((b) => b.date <= options.cutoff);
  const excluded_after_cutoff = sorted.length - visible.length;
  // One extra bar is needed before the window to compare the first session's close.
  if (visible.length < options.window + 1) {
    return { status: "unsupported", reason: `insufficient history: ${visible.length} bars at or before cutoff, need ${options.window + 1}` };
  }

  const span = visible.slice(visible.length - options.window - 1);
  let up_volume = 0;
  let down_volume = 0;
  let flat_volume = 0;
  let flat_days = 0;
  let missing_days = 0;

  for (let i = 1; i < span.length; i++) {
    const prev = span[i - 1].close;
    const cur = span[i];
    if (prev === null || cur.close === null || cur.volume === null) {
      missing_days += 1;
      continue;
    }
    if (cur.close > prev) up_volume += cur.volume;
    else if (cur.close < prev) down_volume += cur.volume;
    else {
      flat_volume += cur.volume;
      flat_days += 1;
    }
  }

  const sided = up_volume + down_volume;
  return {
    status: "computed",
    window: options.window,
    up_volume,
    down_volume,
    flat_volume,
    flat_days,
    missing_days,
    up_share: sided > 0 ? up_volume / sided : null,
    excluded_after_cutoff,
  };
}
