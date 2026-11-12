/** Local JSON in, research dossier JSON out. No provider, DB, model or promotion. */
import { readFileSync } from 'node:fs';
import { evaluateMaDistance, replayMaDistance, type DossierInput } from '../lib/engine/research/ma-distance';
const [path,asOf,...extra]=process.argv.slice(2);
if (!path || extra.length || (asOf && asOf !== '--replay' && !/^\d{4}-\d{2}-\d{2}$/.test(asOf))) {
  console.error('Usage: npx tsx scripts/replay-ma-distance.ts LOCAL.json YYYY-MM-DD|--replay');
  process.exit(2);
}
try {
  const input=JSON.parse(readFileSync(path,'utf8')) as DossierInput;
  const results=asOf==='--replay' ? replayMaDistance(input) : evaluateMaDistance(input,asOf ?? '');
  console.log(JSON.stringify({kind:'offline_reconstructed_context',notLivePerformance:true,
    formula:'(close - SMA50(close)) / WilderATR14; ATR seeds at first high-low; completed daily bars',
    evidence:'caller-declared basis/source, synthetic fixtures tested; not independently price-verified',
    comparison:'signals-app MADistanceExpandedDetector uses percentage thresholds, not this ATR convention',
    results},null,2));
} catch(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
