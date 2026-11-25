import Link from "next/link";
import { NWF2_MESSAGE } from "@/lib/nwf2";

export default function Nwf2Placeholder({ title, back = "/dashboard", backLabel = "← Dashboard" }: { title: string; back?: string; backLabel?: string }) {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <Link href={back}>{backLabel}</Link>
      <h1 style={{ marginTop: 24 }}>{title}</h1>
      <p data-testid="nwf2-message">{NWF2_MESSAGE}</p>
    </main>
  );
}
