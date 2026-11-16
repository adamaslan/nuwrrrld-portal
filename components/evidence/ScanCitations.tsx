import Link from "next/link";
import { splitCitations } from "@/lib/shared/se1-catalog";

/** A3: scan IDs inside text become links to the card; everything else stays plain text. */
export function ScanCitations({ text }: { text: string }) {
  return (
    <>
      {splitCitations(text).map((part, i) =>
        part.type === "scan" ? (
          <Link key={i} href={`/scans/${part.id}`} className="ev-cite"><code>{part.id}</code></Link>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
