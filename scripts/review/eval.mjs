// Golden-set eval: runs planted-bug and known-clean diffs through the reviewer, one
// chain model at a time, and prints recall/precision per model. Reachable != competent.
// Usage: node scripts/review/eval.mjs [--min-recall 0.5] [--model <id>]
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeclaredChain, verifyFreeChain } from './core.mjs';
import { reviewDiff } from './review-diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const MIN_RECALL = Number(arg('--min-recall', '0.5'));

export function score(expectedLenses, foundLenses) {
  const expected = new Set(expectedLenses);
  const found = new Set(foundLenses);
  const hits = [...found].filter((l) => expected.has(l)).length;
  return { expected: expected.size, found: found.size, hits };
}

async function main() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }
  const expected = JSON.parse(readFileSync(path.join(GOLDEN, 'expected.json'), 'utf8'));
  const { verified } = await verifyFreeChain(readDeclaredChain());
  const requested = arg('--model');
  if (requested && !verified.includes(requested)) {
    console.error(`--model ${requested} is not in the verified-$0 chain — refusing to eval it unverified`);
    process.exit(1);
  }
  const models = requested ? [requested] : verified;
  const rows = [];

  for (const model of models) {
    const total = { expected: 0, found: 0, hits: 0 };
    for (const name of readdirSync(GOLDEN).filter((f) => f.endsWith('.diff'))) {
      const diff = readFileSync(path.join(GOLDEN, name), 'utf8');
      const result = await reviewDiff(diff, { chain: [model], key, verify: false });
      const s = score(expected[name] ?? [], result.findings.filter((f) => f.anchored).map((f) => f.lens));
      for (const k of Object.keys(total)) total[k] += s[k];
      if (result.tally.unanswered) console.error(`${model}: ${result.tally.unanswered} unanswered on ${name}`);
    }
    rows.push({ model, recall: total.expected ? total.hits / total.expected : 1, precision: total.found ? total.hits / total.found : 1, ...total });
  }

  console.table(rows.map((r) => ({ model: r.model, recall: r.recall.toFixed(2), precision: r.precision.toFixed(2), hits: r.hits, expected: r.expected, found: r.found })));
  const weak = rows.filter((r) => r.recall < MIN_RECALL);
  if (weak.length) {
    console.error(`recall below ${MIN_RECALL}: ${weak.map((r) => r.model).join(', ')} — remove from review routing`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
