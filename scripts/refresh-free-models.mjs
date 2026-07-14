#!/usr/bin/env node
/**
 * refresh-free-models — keep FREE_MODEL_CHAIN pointed at models that are
 * actually free AND actually reachable this week.
 *
 * What it does:
 *   1. Pulls OpenRouter's model catalog and keeps only $0-priced models
 *      (pricing.prompt / completion / request all parse to 0).
 *   2. Live-probes each candidate (1-token completion) so a model that is
 *      priced $0 but returns 402/429 — the exact failure hitting the council
 *      route — is dropped, not trusted.
 *   3. Rewrites the FREE_MODEL_CHAIN array in lib/openrouter.ts with the top N
 *      that pass, in preference order.
 *
 * Portable by design: plain Node ESM, no dependencies, native fetch. Runs the
 * same on GitHub Actions, GCP Cloud Scheduler, Modal, or a Zo automation —
 * anywhere with Node 18+ and OPENROUTER_API_KEY in the environment.
 *
 * Env / flags:
 *   OPENROUTER_API_KEY   required (used for probing)
 *   MODEL_CHAIN_SIZE     how many models to keep (default 4)
 *   TARGET_FILE          file to rewrite (default lib/openrouter.ts)
 *   --dry-run            print the result, do not write the file
 *   --no-probe           skip live probing, trust the $0 pricing only
 *
 * Exit codes: 0 = success (whether or not the file changed),
 *             1 = unsafe result (too few working models) — file left untouched.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const OR_BASE = 'https://openrouter.ai/api/v1';
const envChainSize = Number(process.env.MODEL_CHAIN_SIZE);
const CHAIN_SIZE = Number.isNaN(envChainSize) ? 4 : envChainSize;
const MIN_WORKING = 1; // never write a chain that would strand the app with zero models
const PROBE_TIMEOUT_MS = 15_000;
const DRY_RUN = process.argv.includes('--dry-run');
const PROBE = !process.argv.includes('--no-probe');

const scriptDir = dirname(fileURLToPath(import.meta.url));
const TARGET_FILE = resolve(
  scriptDir,
  '..',
  process.env.TARGET_FILE ?? 'lib/openrouter.ts',
);

// Preference order: earlier substrings rank higher when we have more working
// models than we need. Tuned toward capable, reliably-free instruct models.
const PREFERRED = [
  'llama-3.3-70b',
  'qwen3',
  'deepseek',
  'gemma-3',
  'gemma-2',
  'mistral-small',
  'mistral-7b',
  'llama-3.1',
  'phi-3',
];

function isFree(pricing) {
  if (!pricing || typeof pricing !== 'object') return false;
  // prompt/completion must be explicitly present and zero. `request` is
  // commonly omitted by the API when zero/not-applicable, so its absence is
  // not disqualifying — but if present, it must be zero too.
  const isZero = (v) => Number(v) === 0;
  const presentAndZero = (v) => v !== undefined && v !== null && isZero(v);
  const zeroOrAbsent = (v) => v === undefined || v === null || isZero(v);
  return presentAndZero(pricing.prompt) && presentAndZero(pricing.completion) && zeroOrAbsent(pricing.request);
}

function paramSize(id) {
  const m = id.match(/(\d+(?:\.\d+)?)b/i);
  return m ? Number(m[1]) : 0;
}

function rank(a, b) {
  const pref = (id) => {
    const i = PREFERRED.findIndex((p) => id.includes(p));
    return i === -1 ? PREFERRED.length : i;
  };
  const byPref = pref(a) - pref(b);
  if (byPref !== 0) return byPref;
  const bySize = paramSize(b) - paramSize(a); // larger first
  if (bySize !== 0) return bySize;
  return a.localeCompare(b);
}

async function fetchFreeModels() {
  const res = await fetch(`${OR_BASE}/models`);
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('Failed to parse OpenRouter /models response as JSON');
  }
  if (!body || !Array.isArray(body.data)) {
    throw new Error('OpenRouter /models response is missing the "data" array');
  }
  return body.data
    .filter((m) => m && isFree(m.pricing) && typeof m.id === 'string' && m.id.endsWith(':free'))
    .map((m) => m.id)
    .sort(rank);
}

async function probe(apiKey, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://financial.nuwrrrld.com',
        'X-Title': 'NuWrrrld free-model refresh',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });
    await res.body?.cancel().catch(() => {});
    return { model, ok: res.ok, status: res.status };
  } catch (err) {
    return { model, ok: false, status: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function selectWorking(apiKey, candidates) {
  if (!PROBE) return candidates.slice(0, CHAIN_SIZE);
  const working = [];
  for (const model of candidates) {
    const r = await probe(apiKey, model);
    console.log(`  probe ${r.ok ? 'OK ' : 'skip'} [${r.status}] ${model}`);
    if (r.ok) working.push(model);
    if (working.length >= CHAIN_SIZE) break; // stop early to spare the free quota
  }
  return working;
}

function renderChain(models) {
  const lines = models.map((m) => `  '${m}',`).join('\n');
  return `export const FREE_MODEL_CHAIN = [\n${lines}\n] as const;`;
}

async function rewriteTarget(models) {
  const src = await readFile(TARGET_FILE, 'utf8');
  const pattern = /export const FREE_MODEL_CHAIN = \[[\s\S]*?\] as const;/;
  const match = src.match(pattern);
  if (!match) {
    throw new Error(`FREE_MODEL_CHAIN block not found in ${TARGET_FILE}`);
  }
  const current = match[0];
  const next = renderChain(models);
  if (current === next) {
    console.log('\nNo change — chain already current.');
    return false;
  }
  if (DRY_RUN) {
    console.log(`\n[dry-run] would write:\n${next}`);
    return false;
  }
  await writeFile(TARGET_FILE, src.replace(pattern, next), 'utf8');
  console.log(`\nUpdated ${TARGET_FILE}:\n${next}`);
  return true;
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (PROBE && !apiKey) {
    console.error('OPENROUTER_API_KEY is required (or pass --no-probe).');
    process.exit(1);
  }

  console.log('Fetching OpenRouter catalog…');
  const free = await fetchFreeModels();
  console.log(`Found ${free.length} $0-priced :free models.`);

  console.log(PROBE ? 'Live-probing in preference order…' : 'Skipping probe (--no-probe).');
  const working = await selectWorking(apiKey, free);

  if (working.length < MIN_WORKING) {
    console.error(
      `\nOnly ${working.length} working model(s) found (need >= ${MIN_WORKING}). ` +
        'Leaving FREE_MODEL_CHAIN untouched to avoid stranding the app.',
    );
    process.exit(1);
  }

  console.log(`\nSelected ${working.length} model(s):\n${working.map((m) => `  - ${m}`).join('\n')}`);
  await rewriteTarget(working);
}

main().catch((err) => {
  console.error(`\nrefresh-free-models failed: ${err.message}`);
  process.exit(1);
});
