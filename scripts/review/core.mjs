// Shared pieces of the free-model PR reviewer: free-model verification, diff
// splitting, lens routing, quote anchoring and the model call. Pure helpers are
// exported separately so tests can reach them without touching the network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
export const MAX_FILE_DIFF_CHARS = 6000;
export const MAX_TOKENS = 2000; // reasoning models burn ~300 tokens thinking before JSON
const SKIP_FILE = /\.(md|json|lock|html|svg|png|jpg)$|(^|\/)package-lock\.json$/;
const MIN_QUOTE_CHARS = 8;

export const EXIT_UNVERIFIED_FREE = 2;
export const EXIT_BILLED = 3;

export function loadLenses() {
  return JSON.parse(readFileSync(path.join(HERE, 'lenses.json'), 'utf8'));
}

export function readDeclaredChain(repoRoot = process.cwd()) {
  const src = readFileSync(path.join(repoRoot, 'lib/openrouter.ts'), 'utf8');
  const body = src.match(/FREE_MODEL_CHAIN = \[([\s\S]*?)\]/)?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// Same rule as scripts/refresh-free-models.mjs isFree(): prompt and completion
// price present and 0, request price 0 or absent.
export function isFree(pricing) {
  if (!pricing || typeof pricing !== 'object') return false;
  const presentAndZero = (v) => v !== undefined && v !== null && Number(v) === 0;
  const zeroOrAbsent = (v) => v === undefined || v === null || Number(v) === 0;
  return presentAndZero(pricing.prompt) && presentAndZero(pricing.completion) && zeroOrAbsent(pricing.request);
}

// Free check 1: re-verify every declared id against the live catalog. Fails closed.
export async function verifyFreeChain(declared) {
  const res = await fetch(`${OPENROUTER_URL}/models`).catch(() => null);
  if (!res?.ok) fail('free-check: OpenRouter /models unreachable — refusing to run unverified', EXIT_UNVERIFIED_FREE);
  const catalog = new Map(((await res.json())?.data ?? []).map((m) => [m.id, m]));
  const verified = declared.filter((id) => id.endsWith(':free') && isFree(catalog.get(id)?.pricing));
  const dropped = declared.filter((id) => !verified.includes(id));
  console.error(`free-check: ${verified.length}/${declared.length} chain models verified $0${dropped.length ? ` — dropped: ${dropped.join(', ')}` : ''}`);
  if (verified.length === 0) fail('free-check: no verified-free model left — aborting', EXIT_UNVERIFIED_FREE);
  return { verified, dropped };
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

export function splitDiff(diff) {
  return diff.split(/^diff --git /m).slice(1)
    .map((block) => ({ path: block.match(/ b\/(\S+)/)?.[1], body: block }))
    .filter((f) => f.path)
    .map((f) => ({
      ...f,
      skipped: SKIP_FILE.test(f.path),
      truncated: f.body.length > MAX_FILE_DIFF_CHARS,
      body: f.body.slice(0, MAX_FILE_DIFF_CHARS),
    }));
}

// Minimal glob: `**` spans directories, `*` stays within one segment.
export function globToRegExp(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^${re}$`);
}

export function lensesForPath(lenses, filePath) {
  return lenses.filter((l) => l.paths.some((g) => globToRegExp(g).test(filePath)));
}

// New-file line number of the first added line containing `quote`, or null when
// no + line matches (the finding is unanchored and gets dropped).
export function addedLineNumber(body, quote) {
  let newLine = 0;
  for (const l of body.split('\n')) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (l.startsWith('+++') || l.startsWith('---') || !newLine) continue;
    if (l.startsWith('+')) {
      if (l.includes(quote)) return newLine;
      newLine++;
    } else if (!l.startsWith('-')) {
      newLine++;
    }
  }
  return null;
}

export function anchorQuote(body, rawQuote) {
  const quote = (rawQuote ?? '').replace(/^\+/, '').trim();
  const line = quote.length > MIN_QUOTE_CHARS ? addedLineNumber(body, quote) : null;
  return { quote, line, anchored: line !== null };
}

export function lensPrompt(question, file, contextPack = '') {
  return [
    'You review ONE file diff for ONE question.',
    `QUESTION: ${question}`,
    'Lines starting with + are new. Judge only + lines.',
    'Reply with ONLY JSON: {"answer":"yes|no","quote":"exact + line copied from the diff","why":"one sentence"}',
    contextPack && `DEFINITIONS the changed code calls (already correct, do not review them):\n${contextPack}`,
    `FILE: ${file.path}\n${file.body}`,
    'Answer "no" unless you can copy the exact line. Output starts with { and ends with }.',
  ].filter(Boolean).join('\n');
}

function parseJson(text) {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// Walks `chain` until a model returns parseable JSON. Free check 2: every
// response must report a billed usage.cost of exactly 0, otherwise the run stops.
export async function ask(chain, content, { key } = {}) {
  for (const model of chain) {
    const r = await fetch(`${OPENROUTER_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'free-pr-review' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: MAX_TOKENS, reasoning: { effort: 'low' },
        usage: { include: true }, messages: [{ role: 'user', content }],
      }),
    }).catch(() => null);
    if (!r?.ok) continue;
    const payload = await r.json().catch(() => null);
    // OpenRouter can return HTTP 200 with an error body (provider overloaded); nothing ran, nothing billed.
    if (!payload || payload.error || !payload.choices?.length) continue;
    const cost = payload?.usage?.cost;
    if (cost !== 0) fail(`free-check: ${model} reported usage.cost=${cost} — stopping before another call`, EXIT_BILLED);
    const msg = payload?.choices?.[0]?.message ?? {};
    const text = msg.content || msg.reasoning || '';
    if (process.env.DEBUG) console.error(model, JSON.stringify(text).slice(0, 300));
    const parsed = parseJson(text);
    if (parsed) return { model, ...parsed };
  }
  return null;
}

export function vendorOf(modelId) {
  return modelId.split('/')[0];
}
