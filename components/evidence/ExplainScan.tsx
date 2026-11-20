"use client";

import { useState } from "react";

/** X26-04: "Explain this result". Sends a card id only; the server builds the prompt and decides what to show. */
export function ExplainScan({ cardId }: { cardId: string }) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [source, setSource] = useState<"model" | "deterministic" | null>(null);

  async function explain() {
    setBusy(true);
    try {
      const res = await fetch("/api/scans/assist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ card: cardId }),
      });
      const json = (await res.json()) as { answer?: string; source?: "model" | "deterministic" };
      setAnswer(json.answer ?? "The explanation is unavailable right now.");
      setSource(json.source ?? "deterministic");
    } catch {
      setAnswer("The explanation is unavailable right now.");
      setSource("deterministic");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Explain this scan">
      <button type="button" onClick={explain} disabled={busy}>
        {busy ? "Explaining…" : "Explain this result"}
      </button>
      {answer && (
        <p>
          {answer}{" "}
          <small>{source === "model" ? "(model-written, checked against the card facts)" : "(standard text)"}</small>
        </p>
      )}
    </section>
  );
}
