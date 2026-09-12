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
 *   4. Audits SEAT_MODELS — reports, never rewrites. As of 2026-09-11 the audit
 *      live-probes each seat instead of only looking it up in the catalog.
 *      Existence and price were never sufficient: T1 sat on a *paid* id that
 *      passed the existence check (2026-09-07), then on a $0 id that 403s
 *      because OpenRouter gates it to "agentic harnesses", while T2 and MACRO
 *      sat on $0 Google ids that 429 on every call. All four passed the old
 *      audit. A seat that cannot be called still answers via FREE_MODEL_CHAIN,
 *      so nothing downstream reports it — only a probe does.
 *
 * Portable by design: plain Node ESM, no dependencies, native fetch. Runs the
 * same on GitHub Actions, GCP Cloud Scheduler, Modal, or a Zo automation —
 * anywhere with Node 18+ and OPENROUTER_API_KEY in the environment.
 *
 * Env / flags:
 *   OPENROUTER_API_KEY   required (used for probing)
 *   MODEL_CHAIN_SIZE     how many models to keep (default 5)
 *   TARGET_FILE          file to rewrite (default lib/openrouter.ts)
 *   --dry-run            print the result, do not write the file
 *   --no-probe           skip live probing, trust the $0 pricing only
 *
 * Exit codes: 0 = success (whether or not the file changed),
 *             1 = hard failure — catalog unreachable, SEAT_MODELS block
 *                 unparseable, or too few working models; file left untouched,
 *             3 = the chain was refreshed fine, but SEAT_MODELS has >=1 retired
 *                 id (degraded, not broken). Distinct from 1 so a CI job can
 *                 let the refresh PR through while still flagging the dead seat
 *                 (docs/free-model-rotation-status.md, P1).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const OR_BASE = 'https://openrouter.ai/api/v1';
const envChainSize = Number(process.env.MODEL_CHAIN_SIZE);
// 5, not 4 (2026-09-11): one more fall-through slot is ~25% more depth, and
// because SPECIALIST_MODEL_PATTERNS below now removes the non-chat ids that
// used to occupy a slot, the added depth is a real general-purpose model rather
// than a nominal one. Both halves matter — a 5-deep chain whose 5th entry is a
// code model is still 4 deep for a council seat.
const CHAIN_SIZE = Number.isNaN(envChainSize) ? 5 : envChainSize;
const MIN_WORKING = 1; // never write a chain that would strand the app with zero models
const PROBE_TIMEOUT_MS = 15_000;
const RETRY_429_DELAY_MS = 2_000; // pause before the single 429 retry (P4)
const MAX_PER_VENDOR = 2; // cap chain entries per vendor prefix — an all-one-vendor
// chain has nominal depth N and real depth 1 against an account-tier outage (P4)

/**
 * Ids whose job is not open-ended chat, and which therefore must never occupy a
 * council fall-through slot however cheap and reachable they are.
 *
 * This is not hypothetical tidiness: the 2026-09-11 run selected
 * `cohere/north-mini-code:free` into the chain — a code model — purely because
 * it was $0 and answered a 1-token ping. A seat that fell through to it would
 * get a code completion where a trader's outlook belongs, and `runSeat` cannot
 * tell the difference: it checks that the answer is non-empty, not that it is
 * on-topic. The catalog also carries a safety classifier
 * (`nvidia/nemotron-3.5-content-safety:free`, which replies "User Safety:
 * safe") and audio-preview ids, both of which pass a ping just as happily.
 */
const SPECIALIST_MODEL_PATTERNS = [
  /-code(?:[-:]|$)/, // code-completion models
  /content-safety|guard|moderation/, // classifiers that answer with a verdict label
  /lyria|audio|tts|whisper|music|clip/, // media models
  /embed|rerank/, // not chat endpoints at all
];

/** Whether `id` is a specialist model per SPECIALIST_MODEL_PATTERNS. */
function isSpecialistModel(id) {
  return SPECIALIST_MODEL_PATTERNS.some((re) => re.test(id));
}
const EXIT_DEGRADED_SEATS = 3; // chain OK, but a SEAT_MODELS id is retired (P1)
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
  const all = body.data.filter(
    (m) => m && isFree(m.pricing) && typeof m.id === 'string' && m.id.endsWith(':free'),
  );
  const chatCapable = all.filter((m) => !isSpecialistModel(m.id));
  const dropped = all.length - chatCapable.length;
  if (dropped > 0) {
    console.log(
      `Excluding ${dropped} specialist $0 model(s) from chain candidacy ` +
        `(code / classifier / media — see SPECIALIST_MODEL_PATTERNS): ` +
        all
          .filter((m) => isSpecialistModel(m.id))
          .map((m) => m.id)
          .join(', '),
    );
  }
  return chatCapable.map((m) => m.id).sort(rank);
}

/**
 * Send a 1-token chat completion to `model` to check it actually answers.
 * Returns `{ model, ok, status }` where `status` is the HTTP code, `'timeout'`,
 * or `'network'`. Retries once on a first-attempt 429 (an account rate limit is
 * not evidence the model is dead); a 429 on the retry is reported as `ok:false`.
 */
async function probe(apiKey, model) {
  // Two attempts: a 429 on the first is an account-level rate limit, not
  // evidence the model is unreachable. Without the retry a momentarily
  // throttled vendor is excluded from the entire week's chain — that is how
  // both Google models were dropped on 2026-09-07 (P4).
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
      if (res.status === 429 && attempt === 0) {
        clearTimeout(timer);
        console.log(`  probe 429  ${model} — rate limited, retrying once in ${RETRY_429_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, RETRY_429_DELAY_MS));
        continue;
      }
      return { model, ok: res.ok, status: res.status };
    } catch (err) {
      return { model, ok: false, status: err?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { model, ok: false, status: 429 };
}

/** Keep at most MAX_PER_VENDOR ids sharing a `vendor/` prefix, order preserved. */
function capVendors(models) {
  const perVendor = new Map();
  const kept = [];
  for (const model of models) {
    const vendor = model.split('/')[0];
    const n = perVendor.get(vendor) ?? 0;
    if (n >= MAX_PER_VENDOR) {
      console.log(`  cap  skip  ${model} — already ${MAX_PER_VENDOR} from "${vendor}/"`);
      continue;
    }
    perVendor.set(vendor, n + 1);
    kept.push(model);
  }
  return kept;
}

/**
 * Reduce the ranked `candidates` to the working chain of at most CHAIN_SIZE
 * ids, capped at MAX_PER_VENDOR per `vendor/` prefix. With `--no-probe` it
 * trusts the $0 pricing and just caps + slices; otherwise it live-probes in
 * order, keeps the ones that answer, and stops early once the chain is full to
 * spare the free quota.
 */
async function selectWorking(apiKey, candidates) {
  // Diversify before slicing to CHAIN_SIZE so the chain doesn't collapse to a
  // single vendor (P4). A shorter multi-vendor chain survives an account-tier
  // outage; a longer single-vendor one does not.
  if (!PROBE) return capVendors(candidates).slice(0, CHAIN_SIZE);
  const working = [];
  const perVendor = new Map();
  for (const model of candidates) {
    const vendor = model.split('/')[0];
    if ((perVendor.get(vendor) ?? 0) >= MAX_PER_VENDOR) {
      console.log(`  cap  skip  ${model} — already ${MAX_PER_VENDOR} working from "${vendor}/"`);
      continue;
    }
    const r = await probe(apiKey, model);
    console.log(`  probe ${r.ok ? 'OK ' : 'skip'} [${r.status}] ${model}`);
    if (r.ok) {
      working.push(model);
      perVendor.set(vendor, (perVendor.get(vendor) ?? 0) + 1);
    }
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
 * Fetch the full OpenRouter catalog as a `Map<id, { free: boolean }>`. Unlike
 * `fetchFreeModels` this keeps paid ids too, so `auditSeatModels` can tell a
 * PAID seat (exists, bills per token) apart from a DEAD one (gone entirely).
 */
async function fetchAllModels() {
  const res = await fetch(`${OR_BASE}/models`);
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.data)) {
    throw new Error('OpenRouter /models response is missing the "data" array');
  }
  // id -> { free: bool }. A seat is "paid" if it exists but bills per token.
  const byId = new Map();
  for (const m of body.data) {
    if (typeof m?.id !== 'string') continue;
    byId.set(m.id, { free: isFree(m.pricing) });
  }
  return byId;
}

/**
 * Audit SEAT_MODELS against the live catalog: each seat is ok (exists, $0),
 * PAID (exists, bills per token), or DEAD (gone from the catalog). Returns the
 * count of DEAD seats.
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
async function auditSeatModels(catalog, apiKey) {
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

  const status = (model) => {
    const hit = catalog.get(model);
    if (!hit) return 'DEAD';
    return hit.free ? 'ok  ' : 'PAID';
  };
  const dead = seats.filter((s) => !catalog.has(s.model));
  const paid = seats.filter((s) => catalog.get(s.model)?.free === false);

  // Existence and price are not reachability. Probe each seat the same way
  // chain candidates are probed — see the header note on why.
  const probes = new Map();
  if (apiKey) {
    for (const { model } of seats) {
      if (probes.has(model)) continue;
      probes.set(model, await probe(apiKey, model));
    }
  }

  const unreachable = seats.filter((s) => probes.get(s.model)?.ok === false);

  console.log(`\nSeat audit — ${seats.length} seat(s) against the live catalog:`);
  for (const { seat, model } of seats) {
    const p = probes.get(model);
    const reach = p ? (p.ok ? 'reachable' : `UNREACHABLE [${p.status}]`) : 'not probed';
    console.log(`  ${status(model)} ${seat.padEnd(6)} ${model.padEnd(50)} ${reach}`);
  }

  if (unreachable.length > 0) {
    console.log(
      `\n${unreachable.length} seat model(s) exist and are $0 but cannot actually be called: ` +
        `${unreachable.map((s) => `${s.seat}=${s.model} [${probes.get(s.model).status}]`).join(', ')}. ` +
        'Such a seat answers entirely from FREE_MODEL_CHAIN, which looks identical to a working ' +
        'seat from the outside — repoint it in ' +
        `${TARGET_FILE}, keeping the size and vendor-spread intent documented there.`,
    );
  }

  if (dead.length > 0) {
    console.log(
      `\n${dead.length} seat model(s) no longer exist. Each costs a guaranteed 404 per call ` +
        'before falling through to FREE_MODEL_CHAIN — the council still answers, so nothing ' +
        'else will surface this. Update SEAT_MODELS in ' +
        `${TARGET_FILE} by hand, keeping the size and vendor-spread intent documented there.`,
    );
  }
  if (paid.length > 0) {
    // Not fatal — a seat *may* be a deliberate paid exception — but it must be
    // visible. A paid id passes an existence check silently, which is exactly
    // how SEAT_MODELS.T1 ran a paid model unnoticed until 2026-09-07
    // (docs/free-model-rotation-status.md, P2). Free is the default; a paid
    // seat is a choice someone has to make on purpose.
    console.log(
      `\n${paid.length} seat model(s) bill per token: ${paid.map((s) => `${s.seat}=${s.model}`).join(', ')}. ` +
        'If that is intentional, note it above the SEAT_MODELS block; otherwise repoint at a :free id.',
    );
  }
  // Unreachable counts as degraded for the exit code: a 403-gated or
  // permanently-429 seat costs the same guaranteed failed round trip per call
  // that a retired one does, and hides the same way.
  return dead.length + unreachable.length;
}

/**
 * Entrypoint. Fetches the catalog, audits SEAT_MODELS (before probing, so a
 * throttled account still gets the report), probes candidates into a
 * vendor-diversified working chain, and rewrites FREE_MODEL_CHAIN in
 * TARGET_FILE unless `--dry-run`. Sets `process.exitCode`: 1 on a hard failure
 * (already thrown by then), EXIT_DEGRADED_SEATS (3) when the chain refreshed
 * cleanly but a seat id is retired, 0 otherwise.
 */
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
  // The FULL catalog, not `free`: checking against the free-only list would
  // report a perfectly live paid model as dead. The audit distinguishes the
  // three states itself (ok / PAID / DEAD).
  const deadSeats = await auditSeatModels(await fetchAllModels(), apiKey);

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
  // land even when the seats need attention. Exit 3 (not 1) so the CI job can
  // tell "chain refreshed, seat rotted" apart from a hard failure and still
  // open the PR — see .github/workflows/refresh-free-models.yml (P1).
  if (deadSeats > 0) process.exitCode = EXIT_DEGRADED_SEATS;
}

main().catch((err) => {
  console.error(`\nrefresh-free-models failed: ${err.message}`);
  process.exit(1);
});
