import Link from "next/link";
import { SEED_CARDS, type ScanCard } from "@/lib/shared/se1-catalog";
import { resolveCitations } from "@/lib/shared/se1/ask";

/** A3: a scan ID that names a written card becomes a link to it; a well-formed ID with no card is shown as
 *  plain text marked "unknown scan", never a link to a missing page (audit R10). */
export function ScanCitations({ text, cards = SEED_CARDS }: { text: string; cards?: readonly Pick<ScanCard, "id" | "version">[] }) {
  return (
    <>
      {resolveCitations(text, cards).map((part, i) => {
        if (part.type === "scan") {
          return (
            <Link key={i} href={`/scans/${part.id}`} className="ev-cite" title={`Scan card v${part.version}`}>
              <code>{part.id}</code>
            </Link>
          );
        }
        if (part.type === "unknown_scan") {
          return <span key={i} className="ev-cite-unknown"><code>{part.id}</code> (unknown scan)</span>;
        }
        return <span key={i}>{part.text}</span>;
      })}
    </>
  );
}
