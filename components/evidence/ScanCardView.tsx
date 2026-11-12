import Link from "next/link";
import { EvidenceBadge } from "./EvidenceBadge";
import { ProvenanceFooter } from "./ProvenanceFooter";
import { FEED_LABEL, BUILT_FEEDS, type ScanCard } from "@/lib/shared/se1-catalog";
import { EVIDENCE_INFO } from "@/lib/shared/se1-catalog";

/** G2 scan card viewer, with A9 "explain this scan" (the card's own prose, no model call). */
export function ScanCardView({ card }: { card: ScanCard }) {
  const fields = Object.entries(card.output_fields);
  const feedBuilt = BUILT_FEEDS.includes(card.feed);
  return (
    <article className="ev-card">
      <header>
        <p className="ev-meta"><code>{card.id}</code> · v{card.version} · {card.family} · {card.role}</p>
        <h1>{card.title}</h1>
        <EvidenceBadge level={card.evidence_level} />
      </header>
      <section><h2>Question</h2><p>{card.question}</p></section>
      <section><h2>Explain this scan</h2><p>{card.prose}</p></section>
      <section>
        <h2>What a surface may say</h2>
        <p>{EVIDENCE_INFO[card.evidence_level].mayClaim}</p>
        {card.status === "spec" && <p className="ev-note">Status is spec: this scan has never been run, so no result exists.</p>}
      </section>
      <section>
        <h2>Output fields</h2>
        {fields.length ? <ul>{fields.map(([k, t]) => <li key={k}><code>{k}</code>: {t}</li>)}</ul> : <p>Not defined yet.</p>}
      </section>
      <section>
        <h2>Caveats</h2>
        <ul>{card.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
      </section>
      <section>
        <h2>Related scans</h2>
        <RelatedList label="Works with" ids={card.composes_with} />
        <RelatedList label="Disagrees with" ids={card.contradicts} />
      </section>
      <ProvenanceFooter provenance={{ source: card.source_ref, feed: `${FEED_LABEL[card.feed]}${feedBuilt ? "" : " (not built)"}`, as_of: "not run", scan_version: card.version }} />
    </article>
  );
}

function RelatedList({ label, ids }: { label: string; ids: string[] }) {
  if (!ids.length) return <p>{label}: none listed.</p>;
  return <p>{label}: {ids.map((id, i) => <span key={id}>{i > 0 && ", "}<Link href={`/scans/${id}`}><code>{id}</code></Link></span>)}</p>;
}
