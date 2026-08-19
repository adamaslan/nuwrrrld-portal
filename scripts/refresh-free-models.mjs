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

/**
 * Audit SEAT_MODELS against the live catalog.
 *
 * Reports, never rewrites. FREE_MODEL_CHAIN is a ranked list this script can
 * regenerate mechanically, but a seat assignment encodes intent a script has
 * no way to infer — the largest free model belongs on CHAIR synthesis, the
 * smallest on QUANT (which is reduced to classification), and vendors are
 * spread so one account-tier outage cannot take every seat at once. Silently
 * substituting "some model that exists" would satisfy the check and quietly
 * discard all three properties.
 *
 * Why this exists at all: this script faithfully maintained FREE_MODEL_CHAIN
 * for months while the other model list in the same file rotted to five dead
 * ids out of six, because nothing was looking at it. A dead seat model 404s,
 * falls through to the chain, and still answers — so the rot is invisible from
 * the outside and only a catalog check finds it.
 */
async function fetchAllModelIds() {
  const res = await fetch(`${OR_BASE}/models`);
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.data)) {
    throw new Error('OpenRouter /models response is missing the "data" array');
  }
  return new Set(body.data.map((m) => m?.id).filter((id) => typeof id === 'string'));
}

async function auditSeatModels(liveIds) {
  const src = await readFile(TARGET_FILE, 'utf8');
  const block = /const SEAT_MODELS: Record<CouncilSeat, string> = \{([\s\S]*?)\};/.exec(src);
  // A missing block means the audit cannot run — which is not the same as an
  // audit that ran and found nothing. Returning 0 here would convert a silently
  // disabled check into a passing one, so a rename or reformat of SEAT_MODELS
  // would let retired ids through with a green run. That is the exact shape of
  // the bug this audit exists to catch, one level up.
  if (!block) {
    throw new Error(
      `SEAT_MODELS block not found in ${TARGET_FILE} — the seat audit cannot run. ` +
        'If the declaration was renamed or reformatted, update the pattern in ' +
        'auditSeatModels() rather than leaving the check disabled.',
    );
  }

  const seats = [...block[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => ({
    seat: m[1],
    model: m[2],
  }));
  if (seats.length === 0) {
    throw new Error(
      `SEAT_MODELS in ${TARGET_FILE} parsed to zero seats — the pattern matched the block ` +
        'but not its entries, so nothing was actually checked.',
    );
  }

  const dead = seats.filter((s) => !liveIds.has(s.model));

  console.log(`\nSeat audit — ${seats.length} seat(s) against the live catalog:`);
  for (const { seat, model } of seats) {
    console.log(`  ${liveIds.has(model) ? 'ok  ' : 'DEAD'} ${seat.padEnd(6)} ${model}`);
  }

  if (dead.length > 0) {
    console.log(
      `\n${dead.length} seat model(s) no longer exist. Each costs a guaranteed 404 per call ` +
        'before falling through to FREE_MODEL_CHAIN — the council still answers, so nothing ' +
        'else will surface this. Update SEAT_MODELS in ' +
        `${TARGET_FILE} by hand, keeping the size and vendor-spread intent documented there.`,
    );
  }
  return dead.length;
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

  // Audited before the probe, deliberately. This needs only the catalog, and
  // the probe's failure modes — quota exhaustion, a vendor outage — are
  // exactly when a weekly run is most likely to abort early. Leaving the audit
  // downstream of that gate meant the one report that finds rotted seats went
  // missing precisely when the account was already unhealthy.
  //
  // The FULL catalog, not `free`: a seat may legitimately run a paid model
  // (T1 does), and checking against the free-only list would report a
  // perfectly live model as dead.
  const deadSeats = await auditSeatModels(await fetchAllModelIds());

  console.log(PROBE ? '\nLive-probing in preference order…' : '\nSkipping probe (--no-probe).');
  const working = await selectWorking(apiKey, free);

  if (working.length < MIN_WORKING) {
    console.error(
      `\nOnly ${working.length} working model(s) found (need >= ${MIN_WORKING}). ` +
        'Leaving FREE_MODEL_CHAIN untouched to avoid stranding the app.',
    );
    if (deadSeats > 0) {
      console.error(`Note: the seat audit above also found ${deadSeats} dead seat model(s).`);
    }
    process.exit(1);
  }

  console.log(`\nSelected ${working.length} model(s):\n${working.map((m) => `  - ${m}`).join('\n')}`);
  await rewriteTarget(working);

  // Non-fatal to the rewrite, which has already happened: a stale seat is a
  // degraded council, a stale chain is a dead one, so the chain refresh must
  // land even when the seats need attention.
  if (deadSeats > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nrefresh-free-models failed: ${err.message}`);
  process.exit(1);
});
