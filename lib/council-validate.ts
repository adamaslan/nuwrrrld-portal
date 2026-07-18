/**
 * The repair loop (docs/council-prompting-small-models.md §7): deterministic,
 * millisecond validators over a structured verdict, turned into a mechanical
 * re-prompt rather than a bare reject. A small model can't find its own
 * mistake from "please improve" — it can execute a fix that names the exact
 * line and the exact correct value.
 *
 * Two checks, both pure/no network:
 *   - numeric cross-check: every number in BECAUSE/INVALIDATION/EXECUTION
 *     must appear (±1% tolerance) somewhere in the brief it was grounded on.
 *   - trade-logic sanity: EXECUTION's entry/stop/target must be ordered
 *     correctly for the call's direction (stop < entry < target for a long,
 *     the reverse for a short).
 */
import type { StructuredVerdict } from "@/lib/council-verdict";
import { directionFromOutlook } from "@/lib/council-verdict";

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;
const NUMERIC_TOLERANCE = 0.01; // ±1%

function extractNumbers(text: string): number[] {
  // Strip evidence ids like [C1] first — the "1" is a reference, not data.
  const withoutIds = text.replace(/\[C\d+\]/g, "");
  const matches = withoutIds.match(NUMBER_RE) ?? [];
  return matches.map(Number).filter((n) => !Number.isNaN(n));
}

function numberGroundedIn(candidate: number, groundedNumbers: number[]): boolean {
  return groundedNumbers.some((g) => {
    const denom = Math.max(Math.abs(g), 1);
    return Math.abs(candidate - g) / denom <= NUMERIC_TOLERANCE;
  });
}

export interface RepairFlag {
  field: "BECAUSE" | "INVALIDATION" | "EXECUTION";
  message: string;
}

/** Flags any number in the verdict's fields that doesn't appear in the brief it was grounded on. */
export function numericCrossCheck(verdict: StructuredVerdict, brief: string): RepairFlag[] {
  const groundedNumbers = extractNumbers(brief);
  const flags: RepairFlag[] = [];

  (["because", "invalidation", "execution"] as const).forEach((key) => {
    const field = key === "because" ? "BECAUSE" : key === "invalidation" ? "INVALIDATION" : "EXECUTION";
    const orphans = extractNumbers(verdict[key]).filter((n) => !numberGroundedIn(n, groundedNumbers));
    for (const orphan of orphans) {
      flags.push({
        field,
        message: `${field} cites ${orphan}, but that number does not appear in DATA or RULES. Rewrite ${field} using only numbers from DATA or RULES.`,
      });
    }
  });

  return flags;
}

/** Parses "entry X / stop Y / target Z" and checks ordering against the call's direction. */
export function tradeLogicSanity(verdict: StructuredVerdict): RepairFlag[] {
  const match = verdict.execution.match(
    /entry\s*\$?(-?[\d.]+).*?stop\s*\$?(-?[\d.]+).*?target\s*\$?(-?[\d.]+)/i,
  );
  if (!match) return []; // "n/a" or unparseable — nothing to check

  const [, entryStr, stopStr, targetStr] = match;
  const entry = Number(entryStr);
  const stop = Number(stopStr);
  const target = Number(targetStr);
  if ([entry, stop, target].some(Number.isNaN)) return [];

  const direction = directionFromOutlook(verdict.outlook);
  if (direction === "neutral") return [];

  const ok =
    direction === "bullish" ? stop < entry && entry < target : target < entry && entry < stop;
  if (ok) return [];

  const orderWanted = direction === "bullish" ? "stop < entry < target" : "target < entry < stop";
  return [
    {
      field: "EXECUTION",
      message: `Your EXECUTION has entry ${entry} / stop ${stop} / target ${target}, which isn't ordered correctly for a ${direction} call. Fix the order: ${orderWanted}.`,
    },
  ];
}

/** All Layer-B-style checks for one structured verdict. */
export function validateStructuredVerdict(verdict: StructuredVerdict, brief: string): RepairFlag[] {
  return [...numericCrossCheck(verdict, brief), ...tradeLogicSanity(verdict)];
}

/** Turns flags into one mechanical, non-evaluative repair message — never "please improve". */
export function buildRepairMessage(flags: RepairFlag[]): string {
  const lines = flags.map((f) => `- ${f.message}`);
  return [
    "Your previous response had specific errors. Resend all four fields, fixing only these lines:",
    ...lines,
  ].join("\n");
}
