import { describe, expect, it } from "vitest";
import { SEED_CARDS, type ScanCard } from "@/lib/shared/se1-catalog";
import {
  assistFactsFor, assistStateFor, buildAssistPrompt, deterministicExplanation, validateAssistAnswer,
  type AssistFacts,
} from "@/lib/shared/se1/assist-explainer";

const card = SEED_CARDS[0];
const facts = (o: Partial<AssistFacts> = {}): AssistFacts => ({ ...assistFactsFor(card), ...o });

describe("X26-04 assist state", () => {
  it("a card on a built feed with no run is absent_run", () => {
    expect(assistStateFor(card)).toBe("absent_run");
  });

  it("a card whose feed is not built is unsupported_feed", () => {
    const edgarCard: ScanCard = { ...card, feed: "edgar" };
    expect(assistStateFor(edgarCard)).toBe("unsupported_feed");
  });
});

describe("X26-04 deterministic text", () => {
  it("says there is no result and names the spec level, never a higher one", () => {
    const text = deterministicExplanation(facts());
    expect(text).toContain("no recorded run");
    expect(text).toContain(card.evidence_level);
    expect(text).not.toMatch(/\bE[1-4]\b/);
  });

  it("names the missing feed when the feed is not built", () => {
    const text = deterministicExplanation(facts({ state: "unsupported_feed", feed: "edgar", feed_label: "SEC EDGAR filings and fundamentals" }));
    expect(text).toContain("SEC EDGAR filings and fundamentals");
    expect(text).toContain("cannot run yet");
  });
});

describe("X26-04 prompt", () => {
  it("is built only from facts and carries the no-opinion and evidence-level rules", () => {
    const p = buildAssistPrompt(facts());
    expect(p).toContain(`title: ${card.title}`);
    expect(p).toContain("Do not give an investment opinion");
    expect(p).toContain("Do not name any evidence level other than the one given");
  });
});

describe("X26-04 validateAssistAnswer", () => {
  const f = facts({ min_bars: 21, version: "1" });

  it("accepts a short grounded answer with the same numbers", () => {
    expect(validateAssistAnswer(`This scan has no run yet. It needs 21 bars and is a ${card.evidence_level} spec.`, f)).toEqual({ ok: true });
  });

  it("rejects an empty answer", () => {
    expect(validateAssistAnswer("   ", f)).toEqual({ ok: false, reason: "empty answer" });
  });

  it("rejects a number that is not in the facts", () => {
    const r = validateAssistAnswer("It needs 42 bars.", f);
    expect(r).toEqual({ ok: false, reason: "number not in facts: 42" });
  });

  it("rejects an evidence level above the card's own", () => {
    const r = validateAssistAnswer(`Confirmed at E3 level.`, f);
    expect(r.ok).toBe(false);
  });

  it("rejects opinion wording", () => {
    const r = validateAssistAnswer("Strong buy here.", f);
    expect(r).toEqual({ ok: false, reason: "opinion wording" });
  });

  it("rejects an answer over the word limit", () => {
    const long = Array.from({ length: 90 }, () => "word").join(" ");
    expect(validateAssistAnswer(long, f)).toEqual({ ok: false, reason: "answer too long" });
  });
});
