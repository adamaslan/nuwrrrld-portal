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
const NTFY_TIMEOUT_MS = 10000;
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

/** Preserve prior findings when a run could not verify every committed model. */
export function mergeRegressionSignatures(...signatures) {
  const regressions = new Map();
  for (const signature of signatures) {
    for (const entry of signature.split(';')) {
      const separator = entry.lastIndexOf('=');
      if (separator <= 0 || separator === entry.length - 1) continue;
      regressions.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
  }
  return [...regressions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, verdict]) => `${id}=${verdict}`)
    .join(';');
}

/** Only acknowledge a regression transition after its notification is delivered. */
export function nextAlertedSignature(previousSignature, currentSignature, decision, delivery) {
  if (delivery !== 'ok') return previousSignature;
  if (decision === 'regression') return currentSignature;
  if (decision === 'recovery') return '';
  return previousSignature;
}

/** A $0 model has zero prompt and completion pricing on OpenRouter. */
export function isFreePricing(pricing) {
  return Boolean(pricing) && String(pricing.prompt) === '0' && String(pricing.completion) === '0';
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

/** Return the smaller of the notification cap and the remaining run budget. */
export function notificationTimeoutMs(deadline, now = Date.now()) {
  const remaining = Math.min(NTFY_TIMEOUT_MS, deadline - now);
  if (remaining <= 0) throw new Error('Run budget exhausted before sending ntfy notification');
  return remaining;
}

function requireRemainingMs(deadline, operation) {
  const remaining = remainingMs(deadline);
  if (remaining <= 0) throw new Error(`Run budget exhausted before ${operation}`);
  return remaining;
}

async function readCommittedChain(deadline) {
  const { stdout: sha } = await execFileAsync('gh', [
    'api', `repos/${REPO}/commits/${BASE_BRANCH}`, '--jq', '.sha',
  ], { timeout: requireRemainingMs(deadline, 'reading the default-branch SHA') });
  const { stdout: encoded } = await execFileAsync('gh', [
    'api', `repos/${REPO}/contents/${CHAIN_PATH}?ref=${BASE_BRANCH}`, '--jq', '.content',
  ], { timeout: requireRemainingMs(deadline, 'reading the committed model chain') });
  const source = Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8');
  return { sha: sha.trim(), chain: parseChain(source) };
}

async function fetchCatalog(deadline) {
  const res = await fetch(`${OR_BASE}/models`, {
    signal: AbortSignal.timeout(requireRemainingMs(deadline, 'fetching the OpenRouter catalog')),
  });
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
  const remaining = Math.min(PROBE_TIMEOUT_MS, remainingMs(deadline));
  if (remaining <= 0) return { status: 'timeout', durationMs: 0 };
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
  if (budget.remaining <= 0 || remainingMs(deadline) <= 0) {
    return { status: 'timeout', durationMs: 0 };
  }
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

async function ntfyPost(title, priority, tags, message, deadline) {
  if (!NTFY_TOPIC) return 'no-topic';
  if (!/^[A-Za-z0-9_-]+$/.test(NTFY_TOPIC)) return 'failed';
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Priority: String(priority), Tags: tags },
      body: message,
      signal: AbortSignal.timeout(notificationTimeoutMs(deadline)),
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

/** Include a rejected key outcome in the high-priority alert details. */
export function formatAlertMessage(summary, regressions, keyResult) {
  const results = keyResult ? [...regressions, keyResult] : regressions;
  return `${summary}\n${formatLines(results)}`;
}

/** Start independent notifications together so one timeout cannot starve another. */
export function deliverNotifications(requests) {
  return Promise.all(requests.map(async ([kind, send]) => [kind, await send()]));
}

async function main(workDeadline, notificationDeadline) {
  const noProbe = process.argv.includes('--no-probe');
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!noProbe && !apiKey) {
    throw new Error('OPENROUTER_API_KEY is required (or pass --no-probe).');
  }
  const { sha, chain } = await readCommittedChain(workDeadline);
  console.log(`committed_sha=${sha} chain=${chain.join(',')}`);

  const catalog = await fetchCatalog(workDeadline);
  const results = await checkChain(chain, catalog, apiKey, { probe: !noProbe, deadline: workDeadline });
  const keyRejected = results.some((r) => r.verdict === 'key');
  const regressions = findRegressions(results);
  const currentSignature = mergeRegressionSignatures(
    keyRejected ? 'openrouter-key=rejected' : '',
    regressionSignature(regressions),
  );
  const incomplete = results.some((r) => r.verdict === 'not-probed' || r.verdict === 'key');

  console.log(formatLines(results));
  const state = await readState();
  const storedSignature = typeof state.signature === 'string' && state.signature.includes('=')
    ? state.signature
    : '';
  const signature = incomplete
    ? mergeRegressionSignatures(storedSignature, currentSignature)
    : currentSignature;
  const decision = alertDecision(storedSignature, signature);
  const healthy = !signature && !incomplete;
  const keyResult = results.find((result) => result.verdict === 'key');
  const summary = incomplete
    ? `Free-model chain check incomplete (sha ${sha.slice(0, 7)}); unverified results were preserved.`
    : healthy
      ? `Free-model chain healthy (${chain.length} ids, sha ${sha.slice(0, 7)}).`
      : `Free-model chain needs attention (sha ${sha.slice(0, 7)}): ${signature}.`;

  const notificationSummary = keyRejected
    ? `OpenRouter API key rejected (HTTP ${keyResult.status}); free-model chain check stopped (sha ${sha.slice(0, 7)}).`
    : summary;
  const notificationRequests = [];
  if (decision === 'regression') {
    notificationRequests.push(['alert', () => ntfyPost(
      'Free-model chain regression', 5, 'rotating_light',
      formatAlertMessage(notificationSummary, regressions, keyResult), notificationDeadline,
    )]);
  }
  notificationRequests.push(['summary', () => ntfyPost(
    'Free-model health check', 3, 'white_check_mark',
    `${notificationSummary}\n${formatLines(results)}`, notificationDeadline,
  )]);
  if (decision === 'recovery') {
    notificationRequests.push(['recovery', () => ntfyPost(
      'Free-model chain recovered', 3, 'white_check_mark', notificationSummary, notificationDeadline,
    )]);
  }
  const deliveries = await deliverNotifications(notificationRequests);
  const alertKind = decision === 'recovery' ? 'recovery' : 'alert';
  const alertDelivery = deliveries.find(([kind]) => kind === alertKind)?.[1] || 'not-sent';
  const nextSignature = nextAlertedSignature(storedSignature, signature, decision, alertDelivery);
  await writeFile(STATE_FILE, JSON.stringify({
    ...state,
    signature: nextSignature,
    runErrorSignature: incomplete ? (state.runErrorSignature || '') : '',
    sha,
    updatedAt: new Date().toISOString(),
  }));
  console.log(`alert_decision=${decision}`);
  for (const [kind, result] of deliveries) console.log(`notification_delivery[${kind}]=${result}`);

  if (keyRejected) return EXIT_KEY_REJECTED;
  return healthy ? EXIT_HEALTHY : EXIT_REGRESSION;
}

/** A run that could not finish still alerts once per distinct failure, not every week. */
async function reportRunError(err, deadline) {
  const signature = `run-error:${err.message.slice(0, 80)}`;
  const state = await readState();
  if (state.runErrorSignature === signature) return 'deduped';
  const delivery = await ntfyPost(
    'Free-model health check failed', 5, 'rotating_light',
    `The read-only free-model health check could not finish: ${err.message}`,
    deadline,
  );
  if (delivery === 'ok') {
    await writeFile(STATE_FILE, JSON.stringify({
      ...state,
      runErrorSignature: signature,
      updatedAt: new Date().toISOString(),
    }));
  }
  return delivery;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const workDeadline = deadline - NTFY_TIMEOUT_MS;
  main(workDeadline, deadline)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (err) => {
      console.error(`free-model-health-check failed: ${err.message}`);
      console.log(`notification_delivery[run-error]=${await reportRunError(err, deadline)}`);
      process.exitCode = EXIT_RUN_ERROR;
    });
}
