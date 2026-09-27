import type { FibLevel, FibConfluenceZone, FibSummary } from "@/lib/shared/fib-levels";

export interface EngineStructureRow {
  levels: unknown;
  zones: unknown;
  nearest_support: number | null;
  nearest_resistance: number | null;
}

/** engine_structure row → the FibSummary shape buildFibLadder renders unchanged. */
export function structureToFibSummary(row: EngineStructureRow): FibSummary {
  const levels = Array.isArray(row.levels) ? (row.levels as FibLevel[]) : [];
  const zones = Array.isArray(row.zones) ? (row.zones as FibConfluenceZone[]) : [];
  return {
    fib_levels: levels,
    fib_confluence_zones: zones,
    nearest_fib_support: row.nearest_support,
    nearest_fib_resistance: row.nearest_resistance,
  };
}

export const engineLadderEnabled = (): boolean => process.env.ENGINE_LADDER_ENABLED === "true";

export const engineLiveEnabled = (): boolean => process.env.ENGINE_LIVE_ENABLED === "true";
