/**
 * LIVE: the model transport layer, against the real OpenRouter API.
 *
 * This is the file the stubbed tests cannot replace. A `fetch` stub proves the
 * fallback logic is internally consistent; only a real call proves the models
 * in FREE_MODEL_CHAIN and SEAT_MODELS still exist, still serve this account,
 * and still qualify as free tier. Those facts rot on their own — a provider
 * can retire a `:free` endpoint overnight with no code change on our side.
 *
 * Deliberately asserts chain *behaviour*, never a specific model id: the chain
 * is refreshed weekly by scripts/refresh-free-models.mjs and pinning ids would
 * make a routine refresh look like a regression.
 */
import { expect, it } from "vitest";
import {
  DEBATE_SEATS,
  FREE_MODEL_CHAIN,
  fetchWithModelFallback,
  runSeat,
  type CouncilSeat,
} from "@/lib/openrouter";
import { LIVE_KEY, SEAT_LATENCY_BUDGET_MS, describeLive, probeModel } from "./_harness";

const ALL_SEATS: CouncilSeat[] = [...DEBATE_SEATS, "CHAIR"];

describeLive("LIVE: FREE_MODEL_CHAIN reachability", () => {
  it("has at least one model that actually answers", async () => {
    const probes = await Promise.all(FREE_MODEL_CHAIN.map((m) => probeModel(m, LIVE_KEY)));
    for (const p of probes) {
      console.info(`[chain] ${p.ok ? "✅" : "❌"} ${p.status} ${p.latencyMs}ms ${p.model}`);
    }
    const healthy = probes.filter((p) => p.ok);
    expect(
      healthy.length,
      `no model in FREE_MODEL_CHAIN answered — every AI feature is down. ` +
        probes.map((p) => `${p.model}=${p.status}`).join(", "),
    ).toBeGreaterThan(0);
  });

  it("keeps a real fallback margin — more than one model answers", async () => {
    const probes = await Promise.all(FREE_MODEL_CHAIN.map((m) => probeModel(m, LIVE_KEY)));
    const healthy = probes.filter((p) => p.ok).map((p) => p.model);
    // A one-model chain is not a chain. This is the early warning that the
    // weekly refresh has stopped keeping up with provider churn.
    expect(
      healthy.length,
      `only ${healthy.length} model(s) in the chain are alive (${healthy.join(", ")}) — ` +
        `there is no fallback margin left. Run scripts/refresh-free-models.mjs.`,
    ).toBeGreaterThan(1);
  });

  it("never silently bills us — every chain entry is a free-tier id", () => {
    for (const model of FREE_MODEL_CHAIN) {
      expect(model, `${model} is in FREE_MODEL_CHAIN but is not a :free id`).toMatch(/:free$/);
    }
  });
});

describeLive("LIVE: every council seat can actually answer", () => {
  // The core production invariant: a seat is only useful if *some* model in
  // its chain serves it. This is checked per seat because each has a distinct
  // primary model, so seats fail independently and invisibly.
  it.each(ALL_SEATS)("seat %s returns a non-empty answer", async (seat) => {
    const result = await runSeat(
      seat,
      [
        { role: "system", content: "Answer in one short sentence." },
        { role: "user", content: "Name one risk of holding a single concentrated equity position." },
      ],
      LIVE_KEY,
      64,
    );
    console.info(`[seat] ${seat} served by ${result.model} in ${result.latencyMs}ms`);
    expect(result.answer.trim().length, `seat ${seat} returned an empty answer`).toBeGreaterThan(0);
    expect(result.seat).toBe(seat);
    expect(result.latencyMs).toBeLessThan(SEAT_LATENCY_BUDGET_MS);
  });
});

describeLive("LIVE: fetchWithModelFallback (the /api/brief and /api/nuai path)", () => {
  it("resolves to a model that streams, and reports which one", async () => {
    const { response, model } = await fetchWithModelFallback(
      LIVE_KEY,
      {
        max_tokens: 48,
        stream: true,
        temperature: 0.3,
        messages: [{ role: "user", content: "In one sentence, what is an RSI indicator?" }],
      },
      "NuWrrrld live test",
    );
    console.info(`[brief-path] served by ${model}`);
    expect(response.ok).toBe(true);
    expect(FREE_MODEL_CHAIN as readonly string[]).toContain(model);
    await response.body?.cancel().catch(() => {});
  });

  it("fails loudly rather than hanging when the key is invalid", async () => {
    // Auth failures are 401 — not in the retry set — so this must reject fast
    // instead of walking the whole chain. Guards against a bad key in prod
    // presenting as latency instead of an error.
    const started = Date.now();
    await expect(
      fetchWithModelFallback(
        "sk-or-v1-definitely-not-a-real-key",
        { max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
        "NuWrrrld live test",
      ),
    ).rejects.toThrow(/OpenRouter \d+/);
    expect(Date.now() - started).toBeLessThan(SEAT_LATENCY_BUDGET_MS);
  });
});
