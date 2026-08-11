/**
 * Disclaimer text + acknowledgement hash. Ported from
 * holdemfoldemapp/frontend/src/lib/disclaimer.ts with the property that
 * matters kept intact: DISCLAIMER_HASH is derived from DISCLAIMER_TEXT, so
 * editing a single word invalidates every stored acknowledgement — no
 * migration or version bump to remember.
 *
 * Nothing here does I/O. Persistence lives in lib/disclaimer-db.ts
 * (signed-in, Neon) and the localStorage helpers below (signed-out).
 */

export const DISCLAIMER_VERSION = "1.0";
export const DISCLAIMER_LAST_UPDATED = "2026-08-11";

export const DISCLAIMER_TEXT = `Not investment advice. NuWrrrld Financial is an educational and analytical tool that aggregates publicly available market data and AI-generated commentary. It is NOT a registered investment adviser, broker-dealer, financial planner, or fiduciary, and its output is NOT personalized investment advice, a recommendation to buy or sell any security, or a solicitation of any transaction.

Verdicts are AI-generated signals, not decisions. Hold/Fold verdicts, signals, and the "AI Council" commentary are produced by large language models reasoning over technical indicators and market data. Models can be wrong, can hallucinate details, and do not consider your financial situation, risk tolerance, tax circumstances, time horizon, liquidity needs, or any other personal factor. Two users seeing the same verdict may have completely different correct actions.

A paid subscription does not create an advisory relationship. Purchasing access to NuWrrrld Financial buys you use of the tool and its output — it does not make us your financial adviser, and payment does not change the nature of the information provided above.

Data may be incomplete, delayed, cached, or wrong. Market data is supplied by third parties. It may be delayed, missing for thinly-traded securities, incorrect during corporate actions, or unavailable during outages. Results shown may be served from a cache up to several hours old, and during a backend outage the service may show the most recent cached result it has rather than fail outright — always check the "as of" timestamp on any verdict before acting on it.

Options carry uncapped risk. Selling uncovered options, credit spreads, and certain combination strategies can result in losses many times larger than the premium received, up to and including total loss of capital and assignment obligations exceeding the value of your account. Options are not suitable for all investors.

Past performance does not predict future results. Backtests, technical patterns, and historical price action have no proven predictive power on any specific future trade.

You are solely responsible for your trading decisions, for verifying any output against authoritative sources, for understanding the tax implications of your trades, and for compliance with all applicable laws and your broker's terms.

No warranty. This tool is provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, accuracy, and non-infringement. To the maximum extent permitted by law, the operators of this tool disclaim all liability for any direct, indirect, incidental, consequential, special, or punitive damages arising from your use of or inability to use the tool.

Jurisdiction. This tool is operated from the United States. If you access it from a jurisdiction where the provision of such information is restricted, you are responsible for compliance with local law.

By using this tool you acknowledge that you have read, understood, and agreed to the terms above.

Last updated: ${DISCLAIMER_LAST_UPDATED} — version ${DISCLAIMER_VERSION}`;

// Simple djb2 hash — no crypto dependency needed for this non-security use case.
// Also reused as the analyze_cache key derivation (see lib/analyze-cache-db.ts).
export function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash.toString(16).padStart(8, "0").slice(0, 12);
}

export const DISCLAIMER_HASH = djb2(DISCLAIMER_TEXT + DISCLAIMER_VERSION);
export const DISCLAIMER_STORAGE_KEY = "nwf.disclaimer.ack";

/** Signed-out fallback only. Signed-in users are checked server-side via lib/disclaimer-db.ts. */
export function hasAcknowledgedLocally(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(DISCLAIMER_STORAGE_KEY) === DISCLAIMER_HASH;
}

export function markAcknowledgedLocally(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(DISCLAIMER_STORAGE_KEY, DISCLAIMER_HASH);
}
