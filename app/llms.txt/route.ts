import { EVIDENCE_INFO, EVIDENCE_LEVELS, FAMILIES, SEED_CARDS, totalPlanned } from "@/lib/shared/se1-catalog";

/** I1: static llms.txt describing the se1 scan encyclopedia. No tools, keys or live data are advertised. */
export const dynamic = "force-static";

export function GET() {
  const lines = [
    "# NuWrrrld Financial: se1 scan encyclopedia",
    "",
    "> Scan cards that describe what each market scan asks, what it needs, and how much evidence backs it. Research context only. Not investment advice and not an order signal.",
    "",
    `Status: ${SEED_CARDS.length} of ${totalPlanned()} planned scan cards are written. All are specs (E0) until an evidence harness runs them. There is no public API or MCP endpoint yet.`,
    "",
    "## Pages",
    "- /scans: browse and filter scan cards",
    "- /scans/{id}: one scan card, e.g. /scans/se1.trend.golden_cross_recency",
    "- /scans/gaps: families blocked on a data feed that isn't built",
    "",
    "## Evidence levels",
    ...EVIDENCE_LEVELS.map((l) => `- ${l} (${EVIDENCE_INFO[l].label}): ${EVIDENCE_INFO[l].mayClaim}`),
    "",
    "## Families",
    ...FAMILIES.map((f) => `- ${f.code}: ${f.name} (${f.planned} planned, ${f.phase})`),
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
