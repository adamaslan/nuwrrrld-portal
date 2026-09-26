/**
 * Run every detector over one point-in-time frame, the TS counterpart of
 * signals-app's `detect_all_signals`: a failing detector is recorded and
 * skipped, never allowed to abort the ticker.
 */
import type { Frame } from "./frame";
import type { Detector, EngineSignal } from "./detectors/types";

/** Same threshold as signals-app config.MAX_DETECTOR_FAILURES. */
export const MAX_DETECTOR_FAILURES = 4;
/** Same budget as signals-app config.DETECTOR_TIMEOUT_MS. JS can't pre-empt a
 *  synchronous detector, so an overrun is reported as a warning, not killed. */
export const DETECTOR_BUDGET_MS = 500;

export interface DetectorRun {
  signals: Array<EngineSignal & { detector: string }>;
  degraded: boolean;
  warnings: string[];
  timingsMs: Record<string, number>;
}

export function runDetectors(
  frame: Frame,
  detectors: readonly Detector[],
  now: () => number = () => performance.now(),
): DetectorRun {
  const signals: DetectorRun["signals"] = [];
  const warnings: string[] = [];
  const timingsMs: Record<string, number> = {};
  let failures = 0;

  for (const detector of detectors) {
    const started = now();
    try {
      for (const s of detector.detect(frame)) signals.push({ ...s, detector: detector.name });
    } catch (error) {
      failures += 1;
      warnings.push(`${detector.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const elapsed = now() - started;
    timingsMs[detector.name] = elapsed;
    if (elapsed > DETECTOR_BUDGET_MS) {
      warnings.push(`${detector.name} took ${elapsed.toFixed(0)} ms (budget ${DETECTOR_BUDGET_MS} ms)`);
    }
  }
  return { signals, degraded: failures >= MAX_DETECTOR_FAILURES, warnings, timingsMs };
}
