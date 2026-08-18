/**
 * LIVE: OpenRouter operational resilience — the facts that rot on their own.
 *
 * model-chain.live.test.ts answers "does the chain answer at all?". This file
 * answers the questions that decide whether the chain survives *next* week:
 * how much headroom is left on the account, whether the chain's models are
 * genuinely independent (a chain of four endpoints behind one upstream vendor
 * is a chain of one), how the chain behaves under the concurrency the council
 * actually generates, and whether the ids in the source still exist in the
 * live catalog.
 *
 * Same rule as the rest of __tests__/live: assert invariants, never wording,
 * never a specific model id — the chain is rewritten weekly by
 * scripts/refresh-free-models.mjs.
 *
 * These tests are informational-first: several `console.info` a table and
 * assert only a floor, because the useful output is the trend across runs in
 * CI logs, not a single boolean.
 */
import { expect, it } from "vitest";
import { DEBATE_SEATS, FREE_MODEL_CHAIN, runSeat } from "@/lib/openrouter";
import { LIVE_KEY, describeLive, probeModel } from "./_harness";

const OR_BASE = "https://openrouter.ai/api/v1";

interface CatalogModel {
  id: string;
  pricing?: { prompt?: string; completion?: string; request?: string };
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null };
}

async function fetchCatalog(): Promise<CatalogModel[]> {
  const res = await fetch(`${OR_BASE}/models`, {
    headers: { Authorization: `Bearer ${LIVE_KEY}` },
  });
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  const json = (await res.json()) as { data?: CatalogModel[] };
  return json.data ?? [];
}

/** vendor prefix of a `vendor/model:free` id — the concentration-risk unit. */
function vendorOf(modelId: string): string {
  return modelId.split("/")[0] ?? modelId;
}

/**
 * Distinguishes "the account's daily free quota is spent" (429 with
 * `limit_source: openrouter_free_tier_daily`) from a genuine chain defect.
 * Both look identical to the fallback logic, but only the second is a bug we
 * can fix in this repo — so the concurrency tests below report and skip on the
 * first rather than failing red every evening after the quota is used up.
 */
async function dailyQuotaExhausted(): Promise<boolean> {
  const res = await fetch(`${OR_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LIVE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: FREE_MODEL_CHAIN[0],
      messages: [{ role: "user", content: "OK" }],
      max_tokens: 4,
    }),
  });
  const text = await res.text().catch(() => "");
  return res.status === 429 && /free_tier_daily|free-models-per-day/.test(text);
}

describeLive("LIVE: chain entries still exist in the live catalog", () => {
  it("every FREE_MODEL_CHAIN id is present in OpenRouter's catalog", async () => {
    // A retired id fails with a 404 at request time, which the fallback logic
    // treats as fatal (not in the retry set) — so one dead id at the head of
    // the chain can break every AI feature while the other three are healthy.
    const catalog = await fetchCatalog();
    const ids = new Set(catalog.map((m) => m.id));
    const missing = FREE_MODEL_CHAIN.filter((m) => !ids.has(m));
    expect(
      missing,
      `these ids are in FREE_MODEL_CHAIN but no longer in the catalog: ${missing.join(", ")} — ` +
        `run scripts/refresh-free-models.mjs`,
    ).toEqual([]);
  });

  it("every chain entry is still priced at $0 by the live catalog", async () => {
    // The `:free` suffix is a naming convention, not a guarantee. This checks
    // the actual pricing fields, which is what bills the account.
    const catalog = await fetchCatalog();
    const byId = new Map(catalog.map((m) => [m.id, m]));
    const billed: string[] = [];
    for (const id of FREE_MODEL_CHAIN) {
      const m = byId.get(id);
      if (!m) continue; // covered by the previous test
      const prices = [m.pricing?.prompt, m.pricing?.completion, m.pricing?.request];
      if (prices.some((p) => p != null && Number.parseFloat(p) > 0)) billed.push(id);
    }
    expect(billed, `these chain entries now carry non-zero pricing: ${billed.join(", ")}`).toEqual(
      [],
    );
  });

  it("reports how many free models exist beyond the chain (refresh headroom)", async () => {
    // Informational: if the pool of viable free models collapses, the weekly
    // refresh has nothing to rotate to and the chain will decay no matter how
    // often it runs. Worth seeing in the log before it becomes an outage.
    const catalog = await fetchCatalog();
    const free = catalog.filter((m) => {
      const prices = [m.pricing?.prompt, m.pricing?.completion];
      return prices.every((p) => p != null && Number.parseFloat(p) === 0);
    });
    console.info(`[catalog] ${free.length} $0-priced models available; chain uses ${FREE_MODEL_CHAIN.length}`);
    expect(free.length).toBeGreaterThanOrEqual(FREE_MODEL_CHAIN.length);
  });
});

describeLive("LIVE: chain independence (concentration risk)", () => {
  it("does not put every model behind a single vendor", async () => {
    // The failure this catches is subtle and real: a chain of four
    // `nvidia/*:free` ids looks like four-deep redundancy but shares one
    // upstream. When that vendor rate-limits the account, all four 429 at
    // once and the "fallback" absorbs nothing.
    const vendors = FREE_MODEL_CHAIN.map(vendorOf);
    const distinct = new Set(vendors);
    console.info(`[chain] vendors: ${[...distinct].join(", ")} across ${FREE_MODEL_CHAIN.length} models`);
    expect(
      distinct.size,
      `all ${FREE_MODEL_CHAIN.length} chain models are from one vendor (${[...distinct][0]}) — ` +
        `a single-vendor rate limit takes down the whole chain at once. ` +
        `Consider a vendor-diversity constraint in scripts/refresh-free-models.mjs.`,
    ).toBeGreaterThan(1);
  });

  it("survives the loss of its first model — the tail alone can still serve", async () => {
    // Simulates the most common real degradation: the head of the chain is
    // exhausted (402) while the rest should carry the load.
    if (await dailyQuotaExhausted()) {
      console.info("[tail] SKIPPED — daily free-model quota exhausted; see docs/known-bugs.md.");
      return;
    }
    const tail = FREE_MODEL_CHAIN.slice(1);
    const probes = await Promise.all(tail.map((m) => probeModel(m, LIVE_KEY)));
    for (const p of probes) {
      console.info(`[tail] ${p.ok ? "✅" : "❌"} ${p.status} ${p.latencyMs}ms ${p.model}`);
    }
    expect(
      probes.filter((p) => p.ok).length,
      `with the first chain model removed, nothing else answers — the chain has no real depth`,
    ).toBeGreaterThan(0);
  });
});

describeLive("LIVE: behaviour under council-shaped concurrency", () => {
  it("absorbs a parallel burst the size of one deliberation round", async () => {
    if (await dailyQuotaExhausted()) {
      console.info(
        "[burst] SKIPPED — account's daily free-model quota is exhausted (429 " +
          "free_tier_daily). This is an account-state fact, not a chain defect; " +
          "see docs/known-bugs.md. Re-run after the UTC-midnight reset.",
      );
      return;
    }
    // A council round fires one call per debate seat simultaneously. Sequential
    // probes never reveal a per-account concurrency limit; this does. Partial
    // success is acceptable and expected — total failure is not.
    const started = Date.now();
    const results = await Promise.allSettled(
      DEBATE_SEATS.map((seat) =>
        runSeat(seat, [{ role: "user", content: "Reply with one short sentence." }], LIVE_KEY, 32),
      ),
    );
    const elapsed = Date.now() - started;
    const ok = results.filter((r) => r.status === "fulfilled").length;
    console.info(`[burst] ${ok}/${DEBATE_SEATS.length} seats answered in ${elapsed}ms`);
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") {
        console.info(`[burst] ❌ ${DEBATE_SEATS[i]}: ${String(r.reason).slice(0, 120)}`);
      }
    }
    // A round that returns nothing produces no verdict at all; a round that
    // loses one seat still deliberates. That is the line worth defending.
    expect(ok, `every seat failed under a ${DEBATE_SEATS.length}-way parallel burst`).toBeGreaterThan(0);
  });

  it("recovers immediately after a burst — no lingering account-wide lockout", async () => {
    if (await dailyQuotaExhausted()) {
      console.info("[burst] SKIPPED — daily free-model quota exhausted; see docs/known-bugs.md.");
      return;
    }
    // If a burst trips a rate limit that persists, the *next* user request
    // fails too. This asserts the limit is per-window, not sticky.
    await Promise.allSettled(
      FREE_MODEL_CHAIN.map((m) => probeModel(m, LIVE_KEY)),
    );
    const after = await runSeat(
      "QUANT",
      [{ role: "user", content: "Reply with the single word: OK" }],
      LIVE_KEY,
      16,
    );
    expect(after.answer.trim().length).toBeGreaterThan(0);
  });
});

describeLive("LIVE: latency distribution across the chain", () => {
  it("has at least one model fast enough for an interactive JIT call", async () => {
    // The JIT budget discussed in docs/api-failure-mitigation-build-options.md
    // is ~1.5s to first token for chat grounding. A chain where every model
    // takes 10s is technically "healthy" and practically unusable for the
    // interactive surfaces.
    if (await dailyQuotaExhausted()) {
      console.info("[latency] SKIPPED — daily free-model quota exhausted; see docs/known-bugs.md.");
      return;
    }
    const INTERACTIVE_BUDGET_MS = 6_000;
    const probes = await Promise.all(FREE_MODEL_CHAIN.map((m) => probeModel(m, LIVE_KEY)));
    const healthy = probes.filter((p) => p.ok).sort((a, b) => a.latencyMs - b.latencyMs);
    for (const p of healthy) console.info(`[latency] ${p.latencyMs}ms ${p.model}`);
    expect(healthy.length, "no model answered at all").toBeGreaterThan(0);
    expect(
      healthy[0].latencyMs,
      `fastest chain model took ${healthy[0]?.latencyMs}ms — every interactive AI surface ` +
        `will feel broken. Prefer faster models in the refresh ranking.`,
    ).toBeLessThan(INTERACTIVE_BUDGET_MS);
  });
});

describeLive("LIVE: account-level guardrails", () => {
  it("reports remaining credits / rate-limit posture", async () => {
    // Purely informational, but it is the single most useful number when the
    // chain starts 402-ing: it distinguishes "our account is out" from "this
    // model is out", which look identical from the fallback logic's side.
    const res = await fetch(`${OR_BASE}/auth/key`, {
      headers: { Authorization: `Bearer ${LIVE_KEY}` },
    });
    if (!res.ok) {
      console.info(`[account] key introspection unavailable (${res.status}) — skipping report`);
      expect(res.status).toBeLessThan(500);
      return;
    }
    const json = (await res.json()) as {
      data?: { limit?: number | null; usage?: number; is_free_tier?: boolean; rate_limit?: unknown };
    };
    console.info(`[account] ${JSON.stringify(json.data ?? {})}`);
    expect(json.data).toBeDefined();
  });

  it("rejects an invalid key fast, without walking the chain", async () => {
    // The live twin of the stubbed 401 test: proves OpenRouter really does
    // return a non-retryable status for a bad key, so the stub's assumption
    // stays true.
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-or-v1-definitely-not-a-real-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: FREE_MODEL_CHAIN[0],
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    });
    await res.body?.cancel().catch(() => {});
    expect([401, 403]).toContain(res.status);
  });
});
