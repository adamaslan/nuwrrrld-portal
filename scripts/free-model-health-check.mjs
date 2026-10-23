#!/usr/bin/env node
/**
 * free-model-health-check — read-only re-verification of the COMMITTED
 * FREE_MODEL_CHAIN on the default branch.
 *
 * The weekly refresh (refresh-free-models.mjs, GitHub Actions) is the only
 * writer: it selects the chain and opens the PR. This script never edits
 * the repo, never opens PRs, and never changes the chain. It answers one
 * question: do the ids the app is shipping still work?
 *
 * Per committed id it reports a verdict:
 *   ok         $0-priced and answered a 1-token completion (HTTP 200)
 *   paid       still in the catalog but no longer $0-priced
 *   retired    gone from the OpenRouter catalog (404 on probe)
 *   rejected   probe refused for a non-retirement reason (other 4xx)
 *   temporary  429 or 5xx or timeout still failing after bounded retries
 *   not-probed skipped because the probe budget ran out (not a regression)
 *
 * Bounds: at most MAX_PROBES completions, PROBE_TIMEOUT_MS per request,
 * PROBE_RETRIES retries on temporary failures, and RUN_BUDGET_MS overall.
 * Response bodies and the API key are never logged.
 *
 * Alerts go to ntfy: one summary every run (priority 3), and a deduplicated
 * high-priority alert when the regression set changes, plus one recovery
 * note when it clears. Delivery is reported on its own line so a failed push
 * is not confused with a failed check.
 *
 * Exit codes: 0 healthy, 2 regression, 4 OpenRouter key rejected,
 * 1 run error (catalog or GitHub read failed).
 *
 *   node scripts/free-model-health-check.mjs            # full check
 *   node scripts/free-model-health-check.mjs --no-probe  # committed chain vs catalog only
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseChain } from './free-model-chain.mjs';

const execFileAsync = promisify(execFile);

const OR_BASE = 'https://openrouter.ai/api/v1';
const EXIT_HEALTHY = 0;
const EXIT_RUN_ERROR = 1;
const EXIT_REGRESSION = 2;
const EXIT_KEY_REJECTED = 4;

const REPO = process.env.REPO || 'adamaslan/nuwrrrld-portal';
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';
const CHAIN_PATH = 'lib/openrouter.ts';
const MAX_PROBES = Number(process.env.MAX_PROBES || 6);
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 15000);
const PROBE_RETRIES = 2;
const PROBE_MAX_TOKENS = 16;
const RETRY_DELAYS_MS = [2000, 8000];
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 180000);
const STATE_FILE = process.env.HEALTH_STATE_FILE || 'free-model-health-state.json';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';

const REGRESSION_VERDICTS = new Set(['paid', 'retired', 'rejected', 'temporary']);

/** Map one probe outcome to a verdict. `status` is an HTTP code or 'timeout'/'network'. */
export function classifyProbe(status) {
  if (status === 200) return 'ok';
  if (status === 401) return 'key';
  if (status === 404) return 'retired';
  if (status === 429 || status === 'timeout' || status === 'network' || status === 'empty') return 'temporary';
  if (typeof status === 'number' && status >= 500) return 'temporary';
  return 'rejected';
}

/** Regressions only, sorted by id. Not-probed and key outcomes are reported separately. */
export function findRegressions(results) {
  return results
    .filter((r) => REGRESSION_VERDICTS.has(r.verdict))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Stable identity of a regression set, used to dedupe alerts. Empty when healthy. */
export function regressionSignature(regressions) {
  return regressions.map((r) => `${r.id}=${r.verdict}`).join(';');
}

/** Decide what to send, given the stored state and the current signature. */
export function alertDecision(previousSignature, currentSignature) {
  if (currentSignature && currentSignature !== previousSignature) return 'regression';
  if (!currentSignature && previousSignature) return 'recovery';
  return 'none';
}

/** A $0 model has zero prompt and completion pricing on OpenRouter. */
export function isFreePricing(pricing) {
  return Boolean(pricing) && String(pricing.prompt) === '0' && String(pricing.completion) === '0';
}

function remainingMs(deadline) {
  return Math.max(1000, deadline - Date.now());
}

async function readCommittedChain(deadline) {
  const timeout = remainingMs(deadline);
  const { stdout: sha } = await execFileAsync('gh', [
    'api', `repos/${REPO}/commits/${BASE_BRANCH}`, '--jq', '.sha',
  ], { timeout });
  const { stdout: encoded } = await execFileAsync('gh', [
    'api', `repos/${REPO}/contents/${CHAIN_PATH}?ref=${BASE_BRANCH}`, '--jq', '.content',
  ], { timeout });
  const source = Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8');
  return { sha: sha.trim(), chain: parseChain(source) };
}

async function fetchCatalog(deadline) {
  const res = await fetch(`${OR_BASE}/models`, { signal: AbortSignal.timeout(remainingMs(deadline)) });
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.data)) {
    throw new Error('OpenRouter /models response is missing the "data" array');
  }
  const catalog = new Map();
  for (const model of body.data) {
    if (typeof model?.id === 'string') catalog.set(model.id, { free: isFreePricing(model.pricing) });
  }
  return catalog;
}

async function sendOnce(apiKey, model, deadline) {
  const started = Date.now();
  const remaining = Math.max(1000, Math.min(PROBE_TIMEOUT_MS, deadline - started));
  try {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: PROBE_MAX_TOKENS }),
      signal: AbortSignal.timeout(remaining),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { status: res.status, durationMs: Date.now() - started };
    }
    // The answer is checked for presence only and never logged: it is model output.
    const body = await res.json();
    const answer = body?.choices?.[0]?.message?.content;
    const usable = typeof answer === 'string' && answer.trim().length > 0;
    return { status: usable ? 200 : 'empty', durationMs: Date.now() - started };
  } catch (err) {
    const status = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
    return { status, durationMs: Date.now() - started };
  }
}

async function spendProbe(apiKey, model, deadline, budget) {
  budget.remaining -= 1;
  return sendOnce(apiKey, model, deadline);
}

/** Probe one model with bounded retries on temporary failures; every request spends the shared budget. */
export async function probeModel(apiKey, model, deadline, budget, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let attempt = await spendProbe(apiKey, model, deadline, budget);
  for (let i = 0; i < PROBE_RETRIES && classifyProbe(attempt.status) === 'temporary'; i += 1) {
    if (budget.remaining <= 0 || Date.now() + RETRY_DELAYS_MS[i] >= deadline) break;
    await sleep(RETRY_DELAYS_MS[i]);
    attempt = await spendProbe(apiKey, model, deadline, budget);
  }
  return { ...attempt, verdict: classifyProbe(attempt.status) };
}

/** Verdict for every committed id, probing free models within the budget. */
export async function checkChain(chain, catalog, apiKey, { probe = true, deadline } = {}) {
  const results = [];
  const budget = { remaining: MAX_PROBES };
  for (const id of chain) {
    const listing = catalog.get(id);
    if (!listing) {
      results.push({ id, verdict: 'retired', status: 'absent', durationMs: 0 });
      continue;
    }
    if (!listing.free) {
      results.push({ id, verdict: 'paid', status: 'listed', durationMs: 0 });
      continue;
    }
    if (!probe) {
      results.push({ id, verdict: 'not-probed', status: 'no-probe', durationMs: 0 });
      continue;
    }
    if (budget.remaining <= 0 || Date.now() >= deadline) {
      results.push({ id, verdict: 'not-probed', status: 'budget', durationMs: 0 });
      continue;
    }
    const outcome = await probeModel(apiKey, id, deadline, budget);
    results.push({ id, ...outcome });
    if (outcome.verdict === 'key') break;
  }
  return results;
}

async function ntfyPost(title, priority, tags, message) {
  if (!NTFY_TOPIC) return 'no-topic';
  if (!/^[A-Za-z0-9_-]+$/.test(NTFY_TOPIC)) return 'failed';
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Priority: String(priority), Tags: tags },
      body: message,
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { signature: '' };
  }
}

function formatLines(results) {
  return results.map((r) => `${r.id}  ${r.verdict}  ${r.status}  ${r.durationMs}ms`).join('\n');
}

async function main() {
  const noProbe = process.argv.includes('--no-probe');
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!noProbe && !apiKey) {
    console.error('OPENROUTER_API_KEY is required (or pass --no-probe).');
    return EXIT_RUN_ERROR;
  }
  const deadline = Date.now() + RUN_BUDGET_MS;
  const { sha, chain } = await readCommittedChain(deadline);
  console.log(`committed_sha=${sha} chain=${chain.join(',')}`);

  const catalog = await fetchCatalog(deadline);
  const results = await checkChain(chain, catalog, apiKey, { probe: !noProbe, deadline });
  const keyRejected = results.some((r) => r.verdict === 'key');
  const regressions = findRegressions(results);
  const signature = keyRejected ? 'key-rejected' : regressionSignature(regressions);

  console.log(formatLines(results));
  const state = await readState();
  const decision = alertDecision(state.signature, signature);
  const healthy = !signature;
  const summary = healthy
    ? `Free-model chain healthy (${chain.length} ids, sha ${sha.slice(0, 7)}).`
    : `Free-model chain needs attention (sha ${sha.slice(0, 7)}): ${signature}.`;

  const deliveries = [];
  deliveries.push(['summary', await ntfyPost('Free-model health check', 3, 'white_check_mark', `${summary}\n${formatLines(results)}`)]);
  if (decision === 'regression') {
    deliveries.push(['alert', await ntfyPost('Free-model chain regression', 5, 'rotating_light', `${summary}\n${formatLines(regressions)}`)]);
  }
  if (decision === 'recovery') {
    deliveries.push(['recovery', await ntfyPost('Free-model chain recovered', 3, 'white_check_mark', summary)]);
  }
  await writeFile(STATE_FILE, JSON.stringify({ signature, sha, updatedAt: new Date().toISOString() }));
  console.log(`alert_decision=${decision}`);
  for (const [kind, result] of deliveries) console.log(`notification_delivery[${kind}]=${result}`);

  if (keyRejected) return EXIT_KEY_REJECTED;
  return healthy ? EXIT_HEALTHY : EXIT_REGRESSION;
}

/** A run that could not finish still alerts once per distinct failure, not every week. */
async function reportRunError(err) {
  const signature = `run-error:${err.message.slice(0, 80)}`;
  const state = await readState();
  if (state.signature === signature) return 'deduped';
  const delivery = await ntfyPost(
    'Free-model health check failed', 5, 'rotating_light',
    `The read-only free-model health check could not finish: ${err.message}`,
  );
  await writeFile(STATE_FILE, JSON.stringify({ signature, updatedAt: new Date().toISOString() }));
  return delivery;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (err) => {
      console.error(`free-model-health-check failed: ${err.message}`);
      console.log(`notification_delivery[run-error]=${await reportRunError(err)}`);
      process.exitCode = EXIT_RUN_ERROR;
    });
}
