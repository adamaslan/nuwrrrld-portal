// The review spine: split → route lenses → context pack → finder → anchor → verifier.
// Used by scripts/free-pr-review.mjs and scripts/review/eval.mjs.
import { ask, anchorQuote, lensPrompt, lensesForPath, loadLenses, splitDiff } from './core.mjs';
import { buildContextPack } from './context-pack.mjs';
import { verifyFinding } from './verify.mjs';

export async function reviewDiff(diff, { chain, key, verify = true, repoRoot = process.cwd(), lenses = loadLenses() }) {
  const files = splitDiff(diff);
  const tally = { yes: 0, no: 0, unanswered: 0 };
  const served = {};
  const findings = [];
  const skipped = files.filter((f) => f.skipped).map((f) => ({ path: f.path, reason: 'non-code file' }));
  const truncated = files.filter((f) => !f.skipped && f.truncated).map((f) => f.path);
  let calls = 0;

  for (const file of files.filter((f) => !f.skipped)) {
    const routed = lensesForPath(lenses, file.path);
    if (routed.length === 0) { skipped.push({ path: file.path, reason: 'no lens routed' }); continue; }
    const pack = buildContextPack(file.body, diff, repoRoot);
    for (const lens of routed) {
      calls++;
      const res = await ask(chain, lensPrompt(lens.question, file, pack), { key });
      if (!res) { tally.unanswered++; continue; }
      served[res.model] = (served[res.model] ?? 0) + 1;
      if (res.answer !== 'yes') { tally.no++; continue; }
      tally.yes++;
      const anchor = anchorQuote(file.body, res.quote);
      findings.push({ file: file.path, lens: lens.id, severity: lens.severity, model: res.model, why: res.why, pack, ...anchor });
    }
  }

  const verifyTally = { real: 0, false: 0, unanswered: 0 };
  if (verify) {
    for (const f of findings.filter((x) => x.anchored)) {
      const v = await verifyFinding(chain, f, f.pack, key);
      Object.assign(f, { verdict: v.verdict, verdictReason: v.reason, verifier: v.verifier });
      verifyTally[v.verdict]++;
      calls++;
    }
  }
  for (const f of findings) delete f.pack;
  return { files: files.length, calls, tally, verifyTally: verify ? verifyTally : null, served, skipped, truncated, findings };
}

// A finding is reportable when anchored and not refuted by the verifier.
// Unanswered verification stays visible instead of being dropped.
export function reportable(findings) {
  return findings.filter((f) => f.anchored && f.verdict !== 'false');
}
