// Verifier pass: a second call, preferring a different vendor than the finder,
// that sees the claimed bug plus the definitions it depends on.
import { ask, vendorOf } from './core.mjs';

export function verifierChain(chain, finderModel) {
  const otherVendor = chain.filter((m) => vendorOf(m) !== vendorOf(finderModel));
  const rest = chain.filter((m) => !otherVendor.includes(m));
  return [...otherVendor, ...rest];
}

export function verifyPrompt(finding, contextPack) {
  return [
    'Here is a claimed bug, the exact line, and the definitions it depends on.',
    `CLAIM (${finding.lens}): ${finding.why}`,
    `LINE: ${finding.quote}`,
    contextPack && `DEFINITIONS:\n${contextPack}`,
    'Reply with ONLY JSON: {"verdict":"real|false","reason":"one sentence"}',
    'Answer "false" if a definition shown already handles the case. Output starts with { and ends with }.',
  ].filter(Boolean).join('\n');
}

// Returns 'real', 'false', or 'unanswered' — never silently drops a finding.
export async function verifyFinding(chain, finding, contextPack, key) {
  const res = await ask(verifierChain(chain, finding.model), verifyPrompt(finding, contextPack), { key });
  if (!res) return { verdict: 'unanswered' };
  return { verdict: res.verdict === 'false' ? 'false' : res.verdict === 'real' ? 'real' : 'unanswered', reason: res.reason, verifier: res.model };
}
