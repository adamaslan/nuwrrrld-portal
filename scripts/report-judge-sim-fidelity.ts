/** Run with: node node_modules/tsx/dist/cli.mjs scripts/report-judge-sim-fidelity.ts
 * No model calls, writes, database access or real Judge gate invocation.
 */
import seed from "../__tests__/fixtures/followed-tickers-gold-set.json";
import { reportSimulatorFidelity } from "../lib/judge-sim-fidelity";

console.log(JSON.stringify(reportSimulatorFidelity(seed.entries), null, 2));
