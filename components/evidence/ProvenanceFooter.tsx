import { formatProvenance, missingProvenance, type Provenance } from "@/lib/shared/ai-features";

/** G9: fails closed. A missing field renders a visible "unsourced" notice, never a partial source line. */
export function ProvenanceFooter({ provenance }: { provenance: Partial<Provenance> }) {
  const line = formatProvenance(provenance);
  if (line) return <p className="ev-prov">{line}</p>;
  return <p className="ev-prov ev-prov-missing">Unsourced: missing {missingProvenance(provenance).join(", ")}.</p>;
}
