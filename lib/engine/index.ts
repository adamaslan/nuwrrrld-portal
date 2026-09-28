/**
 * nu-engine: the portal's signal engine (homebase harness/CLOUD-ENGINE.md,
 * Phase 1). Pure: nothing under lib/engine/ may fetch, touch a database, read
 * env, or import Next — __tests__/engine-layering.test.ts enforces that.
 * Adapters (batch runner, API route) do the I/O and call in here.
 */
export { ENGINE_CODE_VERSION, CANONICAL_SOURCE } from "./version";
export { buildFrame, atrSeries, rollingMean } from "./indicators";
export { sliceFrame, frameLength, type Bar, type Frame } from "./frame";
export { precomputePivots, type Pivot } from "./structure/pivots";
export {
  recentLegs,
  confluenceZones,
  retracement,
  extension,
  RETRACEMENTS,
  EXTENSIONS,
  GOLDEN_POCKET,
  type FibLeg,
  type ConfluenceZone,
} from "./structure/fib";
export { FibonacciDetector } from "./detectors/fibonacci";
export { MaCrossDetector } from "./detectors/ma-cross";
export { IchimokuDetector } from "./detectors/ichimoku";
export type { Detector, EngineSignal, SignalStrength } from "./detectors/types";
export { smaSeries, signCross, lastCross, buildMaColumns, type CrossEvent, type MaColumns } from "./indicators/ma";
export { buildIchimokuColumns, type IchimokuColumns } from "./indicators/ichimoku";
export { runDetectors, type DetectorRun } from "./run";
export { snapshotFrame, holdExitLevels, SNAPSHOT_DETECTORS, type TickerSnapshot, type SnapshotHit } from "./snapshot";
export { labelHit, sideForStrength, DEFAULT_HORIZON_DAYS, DIRECTIONAL_STRENGTHS, type HitLabel } from "./labels";
