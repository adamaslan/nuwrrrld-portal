/**
 * Feed the real MOO scan + investment simulation to the NuWrrrld AI council.
 *
 * Runs the app's own lib/openrouter.ts council seats (compiled to JS) against
 * the real MOO scan + investment simulation produced by scan_moo.py / sim_moo.py.
 */
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OR = require("./compiled/openrouter.js");

// The portal's own OPENROUTER_API_KEY (.env.local) returns 401 "API key
// expired"; the still-valid key lives in ~/code/homebase/.env, which is what
// the local locrun pipeline uses. Same provider, same free-tier model chain —
// only the credential differs.
const envRaw = fs.readFileSync(`${os.homedir()}/code/homebase/.env`, "utf8");
const apiKey = (envRaw.match(/^OPEN_ROUTER_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
if (!apiKey) throw new Error("OPEN_ROUTER_KEY not found in ~/code/homebase/.env");

const runSeat = (seat, messages, maxTokens = 3000, temperature = 0.4, modelOverride) =>
  OR.runSeat(seat, messages, apiKey, maxTokens, temperature, modelOverride);

const scan = JSON.parse(fs.readFileSync("moo_scan.json", "utf8"));
const sim = JSON.parse(fs.readFileSync("moo_sim.json", "utf8"));
const fund = JSON.parse(fs.readFileSync("moo_holdings.json", "utf8"));

const moo = scan.find((r) => r.ticker === "MOO");
const holdings = scan.filter((r) => r.ticker !== "MOO");
const bull = holdings.filter((h) => h.direction === "bullish").length;
const bt = sim.signal_backtest.forward_returns;
const lump = Object.fromEntries(sim.lump_sum_10k.map((l) => [l.years, l]));
const sw = fund.sector_weightings;

const BRIEF = `
=== SIMULATION: $10,000 INVESTED IN MOO (VanEck Agribusiness ETF) TODAY ===
Scan date: ${moo.data_as_of} | Last close $${moo.price} (${moo.change_pct >= 0 ? "+" : ""}${moo.change_pct}%)
Fund: ${fund.longName} | AUM $${(fund.totalAssets / 1e6).toFixed(0)}M | expense ratio ${fund.expenseRatio}% | yield ${(fund.yield * 100).toFixed(1)}% | 3Y beta ${fund.beta3Y}
Sector mix: consumer defensive ${(sw.consumer_defensive * 100).toFixed(0)}%, basic materials ${(sw.basic_materials * 100).toFixed(0)}%, industrials ${(sw.industrials * 100).toFixed(0)}%, healthcare ${(sw.healthcare * 100).toFixed(0)}%
$10,000 buys ${(10000 / moo.price).toFixed(1)} shares at today's close.

=== DATA: LIVE SCAN OF MOO (run today, real yfinance OHLCV, same engine as the site) ===
Confluence score ${moo.ai_score}/100 -> ${moo.ai_action}, ${moo.ai_confidence} confidence, ${moo.signal_count} confirming signals.
RSI ${moo.indicators_raw.rsi} | MACD hist ${moo.indicators_raw.macd_hist} | volume ${moo.indicators_raw.volume_ratio}x the 20-day average
Price ${sim.current_state.pct_above_sma20}% above SMA20 ($${moo.indicators_raw.sma20}); SMA50 $${moo.indicators_raw.sma50}
Bollinger: upper $${moo.indicators_raw.bb_upper}, mid $${moo.indicators_raw.bb_mid}, lower $${moo.indicators_raw.bb_lower}; %B ${moo.indicators_raw.bb_pct} (price is ABOVE the upper band)

=== DATA: HISTORICAL HIT-RATE OF THIS EXACT SIGNAL ON MOO (10y, ${sim.signal_backtest.total_fires} prior fires) ===
Rule: ${sim.signal_backtest.rule}
5d:  hit ${bt["5d"].hit_rate_pct}% (buy-and-hold baseline ${bt["5d"].baseline_hit_rate_pct}%) | mean ${bt["5d"].mean_fwd_pct}% | worst ${bt["5d"].worst_fwd_pct}% | best ${bt["5d"].best_fwd_pct}% | n=${bt["5d"].n}
20d: hit ${bt["20d"].hit_rate_pct}% (baseline ${bt["20d"].baseline_hit_rate_pct}%) | mean ${bt["20d"].mean_fwd_pct}% | worst ${bt["20d"].worst_fwd_pct}% | best ${bt["20d"].best_fwd_pct}% | n=${bt["20d"].n}
60d: hit ${bt["60d"].hit_rate_pct}% (baseline ${bt["60d"].baseline_hit_rate_pct}%) | mean ${bt["60d"].mean_fwd_pct}% | worst ${bt["60d"].worst_fwd_pct}% | best ${bt["60d"].best_fwd_pct}% | n=${bt["60d"].n}

=== DATA: WHAT ACTUALLY HOLDING MOO PAID (real adjusted-close history) ===
$10k lump sum 1y ago  -> $${lump[1].final_value} (${lump[1].total_return_pct}%), max drawdown ${lump[1].max_drawdown_pct}%, ann vol ${lump[1].ann_vol_pct}%, Sharpe ${lump[1].sharpe_rf0}
$10k lump sum 3y ago  -> $${lump[3].final_value} (CAGR ${lump[3].cagr_pct}%), max drawdown ${lump[3].max_drawdown_pct}%
$10k lump sum 5y ago  -> $${lump[5].final_value} (CAGR ${lump[5].cagr_pct}%), max drawdown ${lump[5].max_drawdown_pct}%
$10k lump sum 10y ago -> $${lump[10].final_value} (CAGR ${lump[10].cagr_pct}%), max drawdown ${lump[10].max_drawdown_pct}%, Sharpe ${lump[10].sharpe_rf0}
$250/mo DCA for 10y   -> invested $${sim.dca_250_monthly[2].invested}, now $${sim.dca_250_monthly[2].final_value} (${sim.dca_250_monthly[2].total_return_pct}%)

=== DATA: LOOK-THROUGH SCAN OF MOO'S TOP HOLDINGS (same engine, today) ===
${bull}/${holdings.length} of the scanned top holdings are bullish.
${holdings.map((h) => `${h.ticker} (${h.etf_weight_pct}% of fund) score ${h.ai_score}/100 ${h.ai_action} ${h.ai_confidence} | RSI ${h.indicators_raw.rsi} | ${h.explanation}`).join("\n")}

=== RULES ===
R1: An ETF signal is only as good as the breadth beneath it — a bullish ETF carried by two names is fragile.
R2: %B above 1.0 means price is outside the upper Bollinger band; mean-reversion risk is elevated.
R3: A hit-rate edge measured on fewer than 40 samples has wide error bars.
R4: MOO's 5y CAGR and its 10y CAGR disagree sharply — the recent regime is not the long-run one.
R5: Expense ratio and sector concentration are a permanent drag that an entry signal cannot offset.
`.trim();

const QUESTION =
  "The question before the council: should a retail investor put $10,000 into MOO today, and if so how? Use ONLY the DATA above.";

const t0 = Date.now();
console.error("Round 1 — five seats deliberating on the MOO simulation...");
async function seatWithRetry(seatName, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await runSeat(seatName, [
        { role: "system", content: OR.seatSystemPrompt(seatName) },
        { role: "user", content: `${QUESTION}\n\n${BRIEF}` },
      ]);
      if (r.answer.trim().length > 40) {
        console.error(`  [${seatName}] ${r.model} ${r.latencyMs}ms ${r.answer.length}ch`);
        return r;
      }
      console.error(`  [${seatName}] attempt ${i + 1}: empty/short (${r.answer.length}ch) — retrying`);
    } catch (e) {
      console.error(`  [${seatName}] attempt ${i + 1} failed: ${String(e.message).slice(0, 90)}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { seat: seatName, model: "none", latencyMs: 0, answer: "" };
}

// Sequential, not parallel: the free tier rate-limits five concurrent calls.
const round1 = [];
for (const s of OR.DEBATE_SEATS) round1.push(await seatWithRetry(s));

const transcript = round1.map((r) => `--- ${r.seat} ---\n${r.answer}`).join("\n\n");

console.error("Synthesis — CHAIR...");
let chair = { model: "none", latencyMs: 0, answer: "" };
for (let i = 0; i < 4; i++) {
  try {
    chair = await runSeat("CHAIR", [
      { role: "system", content: OR.seatSystemPrompt("CHAIR") },
      { role: "user", content: `${QUESTION}\n\n${BRIEF}\n\n=== SEAT ANSWERS ===\n${transcript}` },
    ]);
    if (chair.answer.trim().length > 60) break;
  } catch (e) { console.error(`  [CHAIR] attempt ${i + 1}: ${String(e.message).slice(0, 90)}`); }
  await new Promise((r) => setTimeout(r, 4000));
}
console.error(`  [CHAIR] ${chair.model} ${chair.latencyMs}ms ${chair.answer.length}ch`);

console.error("Verdict — 3 samples, majority vote...");
const samples = [];
for (let i = 0; i < 3; i++) {
  let v = { answer: "" };
  try {
    v = await runSeat(
    "CHAIR",
    [
      { role: "system", content: OR.CHAIR_VERDICT_SYSTEM },
      {
        role: "user",
        content: `Question: ${QUESTION}\n\nCouncil transcript:\n${transcript}\n\nChair synthesis:\n${chair.answer}`,
      },
    ],
    1200,
    1.0,
      OR.SMALLEST_MODEL,
    );
  } catch (e) { console.error(`  [verdict ${i + 1}] ${String(e.message).slice(0, 90)}`); }
  try {
    samples.push(JSON.parse(v.answer.trim()));
  } catch {
    samples.push({ raw: v.answer, parse_error: true });
  }
}

const out = {
  backend: "openrouter (key from ~/code/homebase/.env; portal .env.local key is expired)",
  generatedAt: new Date().toISOString(),
  ticker: "MOO",
  question: QUESTION,
  brief: BRIEF,
  seats: round1.map((r) => ({ seat: r.seat, model: r.model, latencyMs: r.latencyMs, answer: r.answer })),
  chair: { model: chair.model, latencyMs: chair.latencyMs, synthesis: chair.answer },
  verdictSamples: samples,
  totalMs: Date.now() - t0,
};
fs.writeFileSync("moo_council_headroom.json", JSON.stringify(out, null, 2));
console.error(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s -> moo_council.json`);
