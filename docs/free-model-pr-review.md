# Free-Model PR Review — Getting Real Reviews Out of Small Models

How to use the portal's free model selector (`FREE_MODEL_CHAIN` in
[`lib/openrouter.ts`](../lib/openrouter.ts)) to review a pull request
thoroughly, given that the models in it will always be small, free, rate-limited,
and different from week to week.

**Status (2026-10-09):** files 1–8 of [§6](#6-files-to-create) are implemented
(`scripts/free-pr-review.mjs`, `scripts/review/*`, `docs/review-invariants.md`,
`.claude/commands/freereview.md`). Not built yet: #9 (refresh-script hook), #10
(GitHub workflow), #11 (usage log), and self-consistency
([§4.7](#47-self-consistency)). The §5 Step 2 heredoc is the original MVP; the
real script supersedes it. A provider overload can arrive as HTTP 200 with an
`error` body; the script treats that as "not served", not as a billing failure.

---

## 1. TL;DR

A small model does a bad job when you ask it to "review this PR". It does a
decent job when you ask it **one narrow yes/no question about one file** and
make it **quote the exact line** it is talking about. Have code handle
everything else:

0. **Prove every call is free.** The script re-checks catalog pricing at
   startup and requires a billed `usage.cost` of exactly `0` on every call. If
   either check fails, it stops
   ([§2.1](#21-how-the-script-verifies-a-model-is-free)).
1. **Run tools before models.** `tsc`, `eslint`, `vitest`, `gitleaks` and greps
   answer what they can. The model only gets questions a tool can't answer.
2. **Use lenses, not a single review.** Each call asks one question (null-guard,
   error-path, auth, secret, …) about one file's diff.
3. **Quote anchoring.** A finding must quote a `+` line that really is in the
   diff, and code checks that the quote matches. An unanchored finding is
   dropped.
4. **Context pack.** Send the definitions of the functions a hunk calls along
   with the hunk. Without them, the model will flag correct code
   ([§3](#3-measured-on-2026-10-09)).
5. **Verifier pass.** A second call, ideally to a model from a different vendor,
   receives each finding with its context and answers `real|false`.
6. **Report coverage.** Every run reports `yes / no / unanswered`. If calls went
   unanswered, a quiet result doesn't mean the PR is clean.
7. **Keep a golden set.** Diffs with planted bugs measure recall and precision
   every time the chain rotates.

Treat the output as **pre-flight triage**, not a replacement for CodeRabbit or
a strong-model pass (`/postbugmergerev`).

---

## 2. What the "free model selector" actually is

| Piece | Where | What it does |
|---|---|---|
| `FREE_MODEL_CHAIN` | [`lib/openrouter.ts`](../lib/openrouter.ts) | Ordered list of 5 `:free` OpenRouter ids. Callers walk it and fall through on 402 / 429 / 5xx. |
| `fetchWithModelFallback` | same file | The walk itself: tries each model until one returns 2xx. |
| `SEAT_MODELS` / `SMALLEST_MODEL` | same file | Council seat → model map. Larger models go to the hard job (synthesis) and the smallest go to classification. |
| `refresh-free-models.mjs` | [`scripts/refresh-free-models.mjs`](../scripts/refresh-free-models.mjs) | Weekly job: pulls the catalog, keeps the $0 models, live-probes them, rewrites the chain, and caps each vendor at 2 entries. |
| Weekly cron | [`deploy/free-model-refresh/`](../deploy/free-model-refresh/) | Modal / GCP wrapper that opens a PR when the chain changes. |

### 2.1 How the script verifies a model is free

Being free is a **hard invariant** for this reviewer. A review is dozens to
hundreds of calls, so one paid id in the chain turns a $0 review into a
metered one. This has already happened: on 2026-09-07 the council's T1 seat
was found sitting on a paid Cohere id that had passed an existence check.

Verification happens at three layers. The review script doesn't trust the
first one on its own:

| Layer | When | Check | On failure |
|---|---|---|---|
| **0. Weekly refresh** ([`refresh-free-models.mjs`](../scripts/refresh-free-models.mjs) `fetchFreeModels` / `isFree`) | Mondays 09:00 UTC, opens a PR | Id ends in `:free` **and** catalog `pricing.prompt` and `pricing.completion` are present and parse to `0`, **and** `pricing.request` is `0` or absent. It then live-probes each candidate with a 1-token call. | The id never enters `FREE_MODEL_CHAIN` |
| **1. Startup re-check** (review script) | Once per run, before any model call | Re-fetches `GET /api/v1/models` and applies the **same `isFree` rule** to every id in `FREE_MODEL_CHAIN`. The catalog can change between the weekly refresh and your run (a model can go paid mid-week, or `lib/openrouter.ts` can be hand-edited on your branch). | The failing ids are **dropped** and listed on stderr. If the catalog is unreachable or **no** id survives, it exits `2`: the script refuses to run unverified. |
| **2. Per-call billing check** (review script) | Every call | Sends `usage: { include: true }` so OpenRouter returns the **billed** `usage.cost` for that call, then requires `cost === 0` exactly. A missing `cost` counts as a failure, not a pass. | Exits `3` straight away, so no further calls go out. At most one call can be billed before the run stops. |

Why each layer is needed:

- **The `:free` suffix alone isn't proof.** It's a naming convention. The
  price fields are what OpenRouter actually bills against, so the script checks
  both.
- **The catalog price alone isn't proof either.** It describes the listing, not
  your call. `usage.cost` is OpenRouter's statement of what this specific
  request was charged, which makes layer 2 the authoritative check. Measured
  2026-10-09 on `liquid/lfm-2.5-2.6b:free`: the catalog showed
  `{"prompt":"0","completion":"0"}` and the call returned `"cost":0` along with
  `"upstream_inference_cost":0`.
- **Fail closed.** If either check can't be completed (catalog down, `usage`
  missing from the response), the script stops rather than assuming the model
  is free.

**Tested 2026-10-09:**

| Test | Result |
|---|---|
| Normal run (before the upstream chain refresh) | `4/5 chain models verified $0 — dropped: inclusionai/ling-3.0-flash-fin:free`. The `:free` id was **gone from the catalog**; only the paid `inclusionai/ling-3.0-flash-fin` was still listed, and it also backed the council's `RISK` seat (see below). The review still found 3 of 3 seeded bugs, with `billedCost: 0`. |
| Paid `openai/gpt-4o-mini` added to the start of a copy of the chain | `4/6 verified — dropped: openai/gpt-4o-mini, …`. Layer 1 removed it before any call was made. |
| Layer 2 (`usage.cost ≠ 0` → exit 3) | **Not exercised.** Triggering it means paying for a call, and layer 1 filters out paid ids before layer 2 would ever see one. The response field it reads was confirmed (`"cost":0` on a free call). |

> **Resolved upstream (2026-10-09):** the check above first caught
> `inclusionai/ling-3.0-flash-fin:free` still sitting in `FREE_MODEL_CHAIN` and
> `SEAT_MODELS.RISK` after OpenRouter retired the `:free` id. `origin/main` has
> since been refreshed (chain of 3, RISK on `poolside/laguna-xs-2.1:free`), and
> the same check now reports `3/3 chain models verified $0`. This is the
> failure the startup layer exists for: a dead or paid id stays invisible
> because the fallback walk hides it.

**Golden-set eval on the refreshed chain** (`node scripts/review/eval.mjs`, about
9 minutes, 2026-10-09):

| Model | Recall | Precision |
|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 0.80 | 0.50 |
| `nvidia/nemotron-3-super-120b-a12b:free` | 0.80 | 0.44 |
| `liquid/lfm-2.5-2.6b:free` | 0.80 | 0.57 |

All three find 4 of the 5 planted bugs, and precision is about 0.5 for every
model, so roughly half the raw findings are noise. That's why the verifier pass
(§4.6) and quote anchoring are not optional. `liquid/lfm-2.5-2.6b:free` also
left 4 calls unanswered across the golden diffs, so its runs are partial and
the report has to say so.

The final JSON report repeats what was verified, so a reader of the report
doesn't have to trust stderr:

```json
"freeCheck": { "verified": ["nvidia/…:free", "…"], "dropped": [], "billedCost": 0 }
```

To check the verification on its own, without running a review:

```bash
cd ~/code/nuwrrrld-portal && node -e '
const src=require("fs").readFileSync("lib/openrouter.ts","utf8");
const chain=[...src.match(/FREE_MODEL_CHAIN = \[([\s\S]*?)\]/)[1].matchAll(/\x27([^\x27]+)\x27/g)].map(m=>m[1]);
fetch("https://openrouter.ai/api/v1/models").then(r=>r.json()).then(({data})=>{const by=new Map(data.map(m=>[m.id,m]));
for(const id of chain){const p=by.get(id)?.pricing;console.log(id.endsWith(":free")&&p&&Number(p.prompt)===0&&Number(p.completion)===0&&(p.request==null||Number(p.request)===0)?"FREE":"NOT-FREE",id,JSON.stringify(p))}})'
```

Expect one `FREE` line per chain id. Any `NOT-FREE` line means the chain needs
a refresh before you run reviews:

```bash
cd ~/code/nuwrrrld-portal && set -a && source <(grep -E '^OPENROUTER_API_KEY=' .env.local) && set +a && node scripts/refresh-free-models.mjs --dry-run
```

Chain as of today (it changes weekly, so read the file rather than this list):
`nemotron-3-super-120b-a12b` (a 120B MoE with ~12B active), `nemotron-3-nano-omni-30b-a3b-reasoning`,
`lfm-2.5-2.6b`, `dots-3-note-preview`, `ling-3.0-flash-fin` (retired from the catalog; see §2.1) — that was the chain on 2026-10-09 morning, and `origin/main` now holds `nemotron-3-ultra-550b-a55b`, `nemotron-3-super-120b-a12b` and `lfm-2.5-2.6b`. These range from
2.6B dense models to MoEs with a large total but a small active parameter
count. **Design for the worst model in the chain**, as
[`concept-small-model-prompting`](wiki-portal/concept-small-model-prompting.md)
already does for the council.

### Constraints that shape everything below

- **Request budget.** OpenRouter's free tier limits requests per minute and per
  day, and the daily cap is much lower on an account without purchased credits.
  Check the current numbers at https://openrouter.ai/docs/api-reference/limits.
  Cost scales as `files × lenses × passes`, so a 20-file PR × 8 lenses × 2
  passes is 320 calls. **Route lenses by path** ([§4.3](#43-route-lenses-by-path))
  and skip files that tools already covered.
- **Latency.** We measured about **12 s per call**, or 16 calls in 3m20s.
  Calls run one at a time, deliberately, to stay under the per-minute limit.
- **Reasoning models eat the token budget.** See §3.
- **The chain rotates.** A prompt that works this week may not work next week.
  That's what the golden set is for ([§4.8](#48-golden-set--measure-dont-trust)).

---

## 3. Measured on 2026-10-09

These are actual runs of the [§5](#5-run-it-today) script, not predictions.

| Run | Result | Lesson |
|---|---|---|
| Seeded diff (auth-from-body, `rows[0].id`, unguarded `req.json()`), `max_tokens: 300` | **0 / 3 found.** Nemotron and LFM spent all 300 tokens thinking aloud and never emitted JSON. `nemotron-3-nano-omni` returned **empty `content`** (reasoning-only). | Give reasoning models **≥2000 `max_tokens`** plus `reasoning: { effort: 'low' }`, and read `message.reasoning` when `content` is empty. |
| Same diff, `max_tokens: 2000`, `effort: low` | **3 / 3 found**, all quote-anchored, and the secret lens correctly said no. | One lens per call works, even on a 2.6B model (LFM caught the `req.json()` case). |
| Real PR #240, run 1 | 16 calls, 0 findings. That run didn't track unanswered calls, so it's unclear whether any went unanswered. | **Always count `unanswered`.** |
| Real PR #240, run 2 (same input, temperature 0) | 15 no, 1 yes, 0 unanswered. The one "yes" said `hasActiveBetaGrant(adminIdentity?.publicMetadata)` might get `undefined`. | **False positive.** The function's own signature accepts `null \| undefined`, but it's defined in another file the model never saw. This calls for a **context pack** and a **verifier pass**. |
| Run 1 vs run 2 | Different results at `temperature: 0` | Free providers aren't deterministic. Run twice and keep a finding only if it reproduces or passes the verifier. |

---

## 4. Strategy: compensating for small models

### 4.1 Run tools first

Before any model call, run:

```bash
cd ~/code/nuwrrrld-portal && npx tsc --noEmit && npx eslint $(gh pr diff "$(gh pr view --json number -q .number)" --name-only | grep -E '\.(ts|tsx)$') && npx vitest run
```

Type errors, lint, failing tests and secret-shaped strings (the gitleaks
pre-commit hook) are already settled. Asking a 2.6B model about them wastes
budget and adds noise.

### 4.2 Lenses: one question, one file, one call

A lens is a single **positive, closed** question with a yes/no answer:

| Lens | Question (as sent) | Where it comes from |
|---|---|---|
| `null-guard` | Can a value used in an added line be null/undefined/empty where the code assumes it is present? | General |
| `error-path` | Does an added line call fetch / a DB / `JSON.parse` without handling the failure? | General |
| `auth` | Does an added API route trust a user/org id or role from the body/query instead of the Clerk session? | `.coderabbit.yaml` `app/api/**` |
| `secret` | Does an added line put a secret/key/token/internal URL into `NEXT_PUBLIC_*`, a log, or a response? | `.coderabbit.yaml` `**/*.ts` |
| `webhook-sig` | Does an added webhook handler read the body before verifying the signature? | `.coderabbit.yaml` `app/api/**` |
| `shared-drift` | Does this change a byte-identical mirrored file in `lib/shared/` outside its base-URL seam? | `.coderabbit.yaml` `lib/shared/**` |
| `timeout` | Does an added fetch to a model or vendor lack an AbortSignal or timeout budget? | `MODEL_CHAIN_WALK_BUDGET_MS` incident |
| `test-asserts` | Does an added test lack an assertion that could fail? | General |
| `fallthrough` | Does an added fallback chain stop on a status it should retry, or retry one it should stop on? | `openrouter.ts` 403/429 history |

Rules for writing a lens, following the council prompt contract:

- **≤5 directives in a prompt.** Small models drop instructions past the
  fourth.
- **Positive wording.** Ask "does X happen?" rather than "make sure X doesn't
  happen."
- **Put the critical constraint last.** Small models weight recent text most,
  so the prompt ends with *"Answer no unless you can copy the exact line."*
- **Output a single JSON object** with `answer`, `quote` and `why`. Don't ask
  for severity: small models are poor at grading it, so code assigns severity
  per lens.

### 4.3 Route lenses by path

Not every lens applies to every file. Send `auth` and `webhook-sig` only for
`app/api/**`, `shared-drift` only for `lib/shared/**`, and `test-asserts` only
for `__tests__/**`. Skip `*.md`, `*.json`, `*.html` and lockfiles entirely.
This is the main way to keep a large PR within the daily request budget.

### 4.4 Quote anchoring (done in code, never by the model)

Accept a `yes` only if `quote` (with any leading `+` stripped) is longer than
8 characters and appears inside a `+` line of that file's diff. This catches
invented lines and findings about removed code, and it gives every finding a
location you can click.

### 4.5 Context pack: the fix for the false positive in §3

For each hunk, code collects the **definitions of the identifiers it calls**:
grep the PR diff first, then the repo, for `export function <name>` /
`export const <name>` and include the first ~15 lines. Cap it at about 2,000
characters, because small context windows degrade quickly. For example, the
PR #240 false positive goes away once the model can see:

```ts
export function hasActiveBetaGrant(
  publicMetadata: Record<string, unknown> | null | undefined,
```

### 4.6 Verifier pass (different model, different question)

The finder pass is tuned for recall and the verifier pass for precision. For
each anchored finding, send:

> Here is a claimed bug, the exact line, and the definitions it depends on.
> Answer ONLY `{"verdict":"real|false","reason":"…"}`. Answer "false" if a
> definition shown already handles the case.

Route the verifier to the **largest model in the chain** and, where possible,
to a **different vendor** from the one that found the issue. The existing
2-per-vendor cap means the chain always has at least three vendors. Drop
findings that come back `false`.

### 4.7 Self-consistency

Run the finder twice, in the cheap mode where only lenses that produced a
`yes` in run 1 are re-asked. Keep a finding if it **reproduced** *or* the
verifier marked it **real**. This is the defense against the nondeterminism
seen in §3.

### 4.8 Golden set: measure, don't trust

Commit a few small diffs with **known planted bugs** plus a few **known-clean**
diffs, each listing its expected lens hits. Run them:

- whenever `refresh-free-models.mjs` changes the chain (wire this into the same
  weekly PR), and
- whenever a lens prompt changes.

Report recall and precision **per model**. If a model's recall falls below
about 50%, remove it from review routing even if it's fine for council chat.
Reachability, which the refresh script already probes, isn't the same as
competence.

### 4.9 Report what was *not* covered

Every run prints the files reviewed, the lenses × files run, `yes / no /
unanswered`, which model served each answer, and the files skipped and why. A
run where any call came back `unanswered` is a **partial** review and must say
so. If it doesn't, "free review found nothing" will eventually get read as
"the PR is clean".

### 4.10 Where it sits in the pipeline

```
tools (tsc/eslint/vitest/gitleaks)
  → free-model finder (lenses × files)
  → code: quote anchoring + path routing
  → free-model verifier (largest model, different vendor)
  → report (markdown + JSON)  ──►  human / CodeRabbit / /postbugmergerev
  → inline PR comments on anchored findings (preview first, post on opt-in; §5 Step 6)
```

It comments on bugs it finds, but only on anchored findings, always labelled as
unverified candidates, and only after a preview. It never auto-merges, never
approves or requests changes, and never edits code. Anything it flags on an auth,
session, webhook, crypto, rate-limit or `migrations/` surface goes through
`/fixy`'s confirmation gate, just like a CodeRabbit finding.

---

## 5. Run it today

The minimal reviewer below covers §4.2 (4 lenses), §4.4 (anchoring) and §4.9
(the tally), and Step 6 posts the anchored findings as inline PR comments. It
doesn't yet have context packs, the verifier, path routing or the golden set.
Until the verifier exists, posted comments are unverified, which is why they say so. Those belong to the files in §6.

**Step 1: preflight.**

```bash
cd ~/code/nuwrrrld-portal && gh auth status && grep -cE '^OPENROUTER_API_KEY=.+' .env.local && node --version
```

Expect `gh` to be logged in, a `1` from the grep, and Node ≥ 18.

**Step 2: write the script** (it creates `scripts/free-pr-review.mjs`).

```bash
cd ~/code/nuwrrrld-portal && cat > scripts/free-pr-review.mjs <<'EOF'
// free-pr-review (MVP) — one lens × one file per call, quote-anchored findings.
// Usage: gh pr diff <n> | node scripts/free-pr-review.mjs     (DEBUG=1 for raw model text)
import { readFileSync } from 'node:fs';

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const src = readFileSync('lib/openrouter.ts', 'utf8');
const DECLARED_CHAIN = [...src.match(/FREE_MODEL_CHAIN = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

// Free check 1 (startup): re-verify every chain id against the live catalog with the
// same rule as scripts/refresh-free-models.mjs isFree() — ':free' suffix, prompt and
// completion price present and 0, request price 0 or absent. Fail closed.
function isFree(pricing) {
  if (!pricing || typeof pricing !== 'object') return false;
  const isZero = (v) => Number(v) === 0;
  const presentAndZero = (v) => v !== undefined && v !== null && isZero(v);
  const zeroOrAbsent = (v) => v === undefined || v === null || isZero(v);
  return presentAndZero(pricing.prompt) && presentAndZero(pricing.completion) && zeroOrAbsent(pricing.request);
}
const catalogRes = await fetch('https://openrouter.ai/api/v1/models').catch(() => null);
if (!catalogRes?.ok) { console.error('free-check: OpenRouter /models unreachable — refusing to run unverified'); process.exit(2); }
const catalog = new Map(((await catalogRes.json())?.data ?? []).map((m) => [m.id, m]));
const CHAIN = DECLARED_CHAIN.filter((id) => id.endsWith(':free') && isFree(catalog.get(id)?.pricing));
const notFree = DECLARED_CHAIN.filter((id) => !CHAIN.includes(id));
console.error(`free-check: ${CHAIN.length}/${DECLARED_CHAIN.length} chain models verified $0${notFree.length ? ` — dropped: ${notFree.join(', ')}` : ''}`);
if (CHAIN.length === 0) { console.error('free-check: no verified-free model left — aborting'); process.exit(2); }

const LENSES = [
  ['null-guard', 'Can a value used in an added line be null, undefined, or an empty array where the code assumes it is present?'],
  ['error-path', 'Does an added line call fetch, a database, or JSON.parse without handling the failure case?'],
  ['auth', 'Does an added API route trust a user id, org id, or role from the request body or query instead of the Clerk session?'],
  ['secret', 'Does an added line put a secret, key, token, or internal URL into a NEXT_PUBLIC_ variable, a log, or a response?'],
];

const MAX_FILE_DIFF_CHARS = 6000;
const diff = readFileSync(0, 'utf8');
const files = diff.split(/^diff --git /m).slice(1)
  .map((block) => ({ path: block.match(/ b\/(\S+)/)?.[1], body: block }))
  .filter((f) => f.path && !/\.(md|json|lock|html)$/.test(f.path))
  .map((f) => ({ ...f, body: f.body.slice(0, MAX_FILE_DIFF_CHARS) }));

// Walk the hunk headers (@@ -a,b +c,d @@) to find the new-file line number of the first
// added line containing `quote`. Returns null when no + line matches (unanchored).
function addedLineNumber(body, quote) {
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

function prompt(lensQuestion, file) {
  return [
    'You review ONE file diff for ONE question.',
    `QUESTION: ${lensQuestion}`,
    'Lines starting with + are new. Judge only + lines.',
    'Reply with ONLY JSON: {"answer":"yes|no","quote":"exact + line copied from the diff","why":"one sentence"}',
    `FILE: ${file.path}\n${file.body}`,
    'Answer "no" unless you can copy the exact line. Output starts with { and ends with }.',
  ].join('\n');
}

async function ask(content) {
  for (const model of CHAIN) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'free-pr-review' },
      // Reasoning models spend 300 tokens thinking and never emit JSON — measured 2026-10-09.
      // usage.include asks OpenRouter to return the billed cost of this exact call.
      body: JSON.stringify({ model, temperature: 0, max_tokens: 2000, reasoning: { effort: 'low' }, usage: { include: true }, messages: [{ role: 'user', content }] }),
    }).catch(() => null);
    if (!r?.ok) continue;
    const payload = await r.json();
    // Free check 2 (every call): the billed cost must be exactly 0. Any charge stops the run.
    const cost = payload?.usage?.cost;
    if (cost !== 0) {
      console.error(`free-check: ${model} reported usage.cost=${cost} — stopping before another call`);
      process.exit(3);
    }
    const msg = payload?.choices?.[0]?.message ?? {};
    const text = msg.content || msg.reasoning || '';
    if (process.env.DEBUG) console.error(model, JSON.stringify(text).slice(0, 300));
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    try { return { model, ...JSON.parse(json) }; } catch { continue; }
  }
  return null;
}

const findings = [];
const tally = { yes: 0, no: 0, unanswered: 0 };
for (const file of files) {
  for (const [lens, question] of LENSES) {
    const res = await ask(prompt(question, file));
    if (!res) { tally.unanswered++; continue; }
    if (res.answer !== 'yes') { tally.no++; continue; }
    tally.yes++;
    // Quote anchoring: only a quote that is literally an added line counts.
    const quote = (res.quote ?? '').replace(/^\+/, '').trim();
    const line = quote.length > 8 ? addedLineNumber(file.body, quote) : null;
    const anchored = line !== null;
    findings.push({ file: file.path, line, lens, model: res.model, anchored, quote, why: res.why });
  }
}
console.log(JSON.stringify({ files: files.length, lenses: LENSES.length, freeCheck: { verified: CHAIN, dropped: notFree, billedCost: 0 }, tally, findings }, null, 2));
EOF
echo written
```

**Step 3: seeded self-test.** Before you trust it on a real PR this week,
check that it can still find planted bugs with the current chain.

```bash
cd ~/code/nuwrrrld-portal && set -a && source <(grep -E '^OPENROUTER_API_KEY=' .env.local) && set +a && printf '%s\n' \
  'diff --git a/app/api/x/route.ts b/app/api/x/route.ts' '+++ b/app/api/x/route.ts' '@@ -0,0 +1,6 @@' \
  '+export async function POST(req: Request) {' '+  const body = await req.json();' '+  const userId = body.userId;' \
  '+  const rows = await sql`SELECT id FROM portfolios WHERE user_id = ${userId}`;' '+  const first = rows[0].id;' '+}' \
  | node scripts/free-pr-review.mjs
```

Expect **3 anchored findings** (`null-guard`, `error-path`, `auth`), no
`secret` finding, and `unanswered: 0`. Fewer than 3 means the chain has
rotated to weaker or unreachable models. Re-run with `DEBUG=1` to see raw
output before trusting a real run.

**Step 4: review the current branch's PR.** This takes about 12 s per
file × lens.

```bash
cd ~/code/nuwrrrld-portal && set -a && source <(grep -E '^OPENROUTER_API_KEY=' .env.local) && set +a && PR=$(gh pr view --json number -q .number) && echo "PR #$PR" && gh pr diff "$PR" | node scripts/free-pr-review.mjs | tee "/tmp/free-review-pr$PR.json"
```

To review the most recently opened PR instead of the current branch's:

```bash
cd ~/code/nuwrrrld-portal && set -a && source <(grep -E '^OPENROUTER_API_KEY=' .env.local) && set +a && PR=$(gh pr list --limit 1 --json number -q '.[0].number') && echo "PR #$PR" && gh pr diff "$PR" | node scripts/free-pr-review.mjs | tee "/tmp/free-review-pr$PR.json"
```

**Step 5: read the result.**

```bash
PR=$(gh pr view --json number -q .number 2>/dev/null || gh pr list --limit 1 --json number -q '.[0].number') && node -e 'const r=require(process.argv[1]);console.log("tally",r.tally);for(const f of r.findings)console.log(f.anchored?"✓":"✗",f.lens.padEnd(11),f.file,"\n   ",f.quote,"\n   ",f.why,"("+f.model+")")' "/tmp/free-review-pr$PR.json"
```

How to read it:

- `✗` means unanchored. Ignore it.
- `✓` means a candidate. **Open the file and check the definitions it calls**
  before believing it, because the MVP has no context pack.
- `unanswered > 0` means the review is **partial**. Say so wherever you report
  the result.
- `freeCheck.dropped` that isn't empty means a chain id failed the price check
  and was skipped. Run the refresh dry run in §2.1. Exit code `2` (catalog
  unreachable or nothing verified) or `3` (a call reported a non-zero
  `usage.cost`) means the run stopped on purpose, so don't re-run it blindly.

**Step 6: comment on the bugs it found (preview first, then post).** Each
anchored (`✓`) finding becomes an inline review comment on the exact added
line, using the `line` the script recorded in Step 2. Unanchored findings are
never posted. Posting is outward-facing and can't be unsent, so the default is
a preview and you must opt in to the real post.

Rules the payload builder follows:

- Comments are labelled as **unverified candidates from a free model**, with the
  lens and the model that raised them, so nobody reads them as a confirmed bug.
- `secret` findings get a generic comment with **no quote and no `why`**,
  because the model's text could repeat the secret it found.
- The review body says **partial** when `unanswered > 0`, and lists the lenses
  that ran, so a quiet review isn't read as a clean PR.
- It posts as `COMMENT`. It never uses `APPROVE` or `REQUEST_CHANGES`.

*6a. Preview (posts nothing).*

```bash
PR=$(gh pr view --json number -q .number 2>/dev/null || gh pr list --limit 1 --json number -q '.[0].number') && node -e '
const r = require(process.argv[1]);
const comments = r.findings.filter((f) => f.anchored && f.line).map((f) => ({
  path: f.file, line: f.line, side: "RIGHT",
  body: f.lens === "secret"
    ? "🤖 **free-model review · `secret`** — possible secret, key, token or internal URL on this line. Unverified candidate; please check."
    : `🤖 **free-model review · \`${f.lens}\`** (${f.model}) — unverified candidate, please check before acting.\n\n${f.why}`,
}));
const partial = r.tally.unanswered > 0;
const body = `Free-model review: ${comments.length} candidate(s) from ${r.lenses} lenses over ${r.files} file(s). ${partial ? `**PARTIAL** — ${r.tally.unanswered} call(s) went unanswered. ` : ""}Candidates only, not a clean bill of health.`;
require("fs").writeFileSync(process.argv[2], JSON.stringify({ event: "COMMENT", body, comments }));
console.log(body); for (const c of comments) console.log(" -", c.path + ":" + c.line, c.body.split("\n")[0]);
' "/tmp/free-review-pr$PR.json" "/tmp/free-review-pr$PR.payload.json"
```

Expect one line per anchored finding, each with a `path:line`. Zero lines means
there is nothing to post, so stop here.

*6b. Post it (only after reading 6a).*

```bash
PR=$(gh pr view --json number -q .number 2>/dev/null || gh pr list --limit 1 --json number -q '.[0].number') && gh api "repos/{owner}/{repo}/pulls/$PR/reviews" --input "/tmp/free-review-pr$PR.payload.json" -q '.html_url'
```

Expect a PR review URL. A `422` almost always means a comment's line isn't part
of the PR diff (for example, the PR was force-pushed after the review ran).
Re-run Steps 4 and 6a against the current head.

*6c. Verify.*

```bash
PR=$(gh pr view --json number -q .number 2>/dev/null || gh pr list --limit 1 --json number -q '.[0].number') && gh api "repos/{owner}/{repo}/pulls/$PR/comments" -q '.[] | select(.body | startswith("🤖 **free-model review")) | "\(.path):\(.line)"'
```

Expect the same `path:line` list as the preview. Re-running Step 6b adds the
comments **again**, so run it once per review.

---

## 6. Files to create

In priority order. Each row says which small-model weakness it addresses.

| # | File | Purpose | Weakness addressed |
|---|---|---|---|
| 1 | `scripts/free-pr-review.mjs` | Orchestrator: split the diff, route lenses, call the chain, anchor, verify, report. Start from §5 Step 2. | All of them; this is the spine |
| 2 | `scripts/review/lenses.json` | Lens catalog: `{ id, question, paths[], severity, source }`. Move `.coderabbit.yaml` `path_instructions` here as closed questions so both tools review the same invariants. | Vague, compound prompts; budget (path routing) |
| 3 | `scripts/review/context-pack.mjs` | For each hunk, find definitions of the identifiers it calls (PR diff first, then `git grep`), giving ~15 lines each and a cap of ~2k chars. | **Context blindness** (the §3 false positive) |
| 4 | `scripts/review/verify.mjs` | Second pass: finding + quote + context → `real\|false`, using the largest chain model from a different vendor than the finder. | Precision and hallucinated bugs |
| 5 | `scripts/review/golden/*.diff` + `golden/expected.json` | 6–10 planted-bug diffs (one per lens) plus 3 known-clean diffs, with expected hits. | Prompts that silently stop working after chain rotation |
| 6 | `scripts/review/eval.mjs` | Runs the golden set and prints recall and precision per model and per lens. Exits non-zero when recall falls below a threshold. | "Reachable" mistaken for "competent" |
| 7 | `docs/review-invariants.md` | Short invariant cards, ≤5 bullets each (auth source of truth, webhook sig, timeout budgets, fallthrough statuses, shared-drift). Lenses pull **one** card into the prompt. | Lack of repo knowledge in a small context |
| 8 | `.claude/commands/freereview.md` | `/freereview [PR]` slash command: preflight → tools → seeded self-test → review → render markdown → preview the inline comments (§5 Step 6a) → post only on a yes. | Hand-rolling the flow each time |
| 9 | Hook in `scripts/refresh-free-models.mjs` | After rewriting the chain, run `eval.mjs` and put recall per model in the refresh PR body. | Weekly rotation shipping a model that can't review |
| 10 | `.github/workflows/free-pr-review.yml` (optional, last) | Runs on `pull_request`, routed lenses only, posts a single summary comment. Needs `OPENROUTER_API_KEY` as a repo secret (push it with the `secrets-sync` skill). | Automating it; build this only after #5 and #6 prove precision |
| 11 | `docs/model-usage/` log entries | Append the per-run tally and which model served each call, as the pipeline run log does. | Seeing which models actually answer review calls |

Suggested order: build **1 → 2 → 3 → 4** together as one PR (the reviewer
becomes trustworthy), then **5 → 6 → 9** (it stays trustworthy as the chain
rotates), then **7, 8**, and leave **10** for last.

### Sketch: `scripts/review/lenses.json`

```json
[
  { "id": "auth", "paths": ["app/api/**"], "severity": "high",
    "question": "Does an added API route trust a user id, org id, or role from the request body or query instead of the Clerk session?",
    "source": ".coderabbit.yaml app/api/**" },
  { "id": "shared-drift", "paths": ["lib/shared/**"], "severity": "high",
    "question": "Does this diff change a file that is mirrored byte-identical in gcp3-mobile, outside its base-URL seam?",
    "source": ".coderabbit.yaml lib/shared/**" },
  { "id": "test-asserts", "paths": ["__tests__/**", "**/*.test.ts", "**/*.test.tsx"], "severity": "low",
    "question": "Does an added test lack an assertion that could fail?",
    "source": "general" }
]
```

### Sketch: `scripts/review/golden/expected.json`

```json
{
  "auth-from-body.diff":   ["auth", "null-guard", "error-path"],
  "next-public-secret.diff": ["secret"],
  "webhook-no-sig.diff":   ["webhook-sig"],
  "clean-refactor.diff":   []
}
```

---

## 7. What this will not catch

Be explicit about these limits in any report built on this tool:

- **Cross-file logic.** A bug that only appears when two changed files
  interact. Context packs help with direct callees and nothing beyond that.
- **Concurrency and ordering.** Races, double writes, idempotency.
- **Design and "should this exist at all".** Small models will approve
  anything that is internally consistent.
- **Diffs larger than `MAX_FILE_DIFF_CHARS` per file.** Those are truncated.
  The orchestrator should split them into hunks rather than truncate, and
  report any truncation.

For those, use CodeRabbit (see the pacing rules) or a strong-model pass. A
free review is useful because it's cheap and quick: it catches the common,
mechanical defect classes before a paid reviewer spends a cycle on them.

---

## 8. Source as implemented

The code that exists on branch `feat/free-pr-review`, copied verbatim. The files on disk are authoritative; this section is a snapshot. It supersedes the MVP heredoc in §5 Step 2 (the §5 commands that call `scripts/free-pr-review.mjs` still work).

Run it:

```bash
cd ~/code/nuwrrrld-portal && set -a && source <(grep -E '^OPENROUTER_API_KEY=' .env.local) && set +a && gh pr diff "$(gh pr view --json number -q .number)" | node scripts/free-pr-review.mjs
```

Add `--no-verify` to skip the verifier pass. Check model competence with `node scripts/review/eval.mjs`.

### `scripts/free-pr-review.mjs`

```js
// free-pr-review — lens × file review of a PR diff using only verified-$0 OpenRouter models.
// Usage: gh pr diff <n> | node scripts/free-pr-review.mjs [--no-verify]     (DEBUG=1 for raw model text)
// Exit: 1 missing key · 2 free-ness unverified · 3 a call was billed.
import { readFileSync } from 'node:fs';
import { readDeclaredChain, verifyFreeChain } from './review/core.mjs';
import { reviewDiff } from './review/review-diff.mjs';

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const { verified, dropped } = await verifyFreeChain(readDeclaredChain());
const result = await reviewDiff(readFileSync(0, 'utf8'), { chain: verified, key, verify: !process.argv.includes('--no-verify') });
console.log(JSON.stringify({ ...result, freeCheck: { verified, dropped, billedCost: 0 } }, null, 2));
```

### `scripts/review/core.mjs`

```js
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
```

### `scripts/review/review-diff.mjs`

```js
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
```

### `scripts/review/context-pack.mjs`

```js
// Context pack: definitions of identifiers a diff calls, so the model stops
// flagging correct code whose signature lives in another file.
import { execFileSync } from 'node:child_process';

const MAX_PACK_CHARS = 2000;
const DEFINITION_LINES = 15;
const MAX_IDENTIFIERS = 8;
const IDENTIFIER = /\b([A-Za-z_$][\w$]{3,})\s*\(/g;
const NOISE = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await', 'async', 'require',
  'fetch', 'JSON', 'parse', 'stringify', 'push', 'map', 'filter', 'then', 'json', 'text', 'join', 'slice', 'includes']);

export function calledIdentifiers(body) {
  const names = new Set();
  for (const line of body.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const m of line.matchAll(IDENTIFIER)) if (!NOISE.has(m[1])) names.add(m[1]);
  }
  return [...names].slice(0, MAX_IDENTIFIERS);
}

function definitionFromDiff(diff, name) {
  const lines = diff.split('\n');
  const re = new RegExp(`(function\\s+${name}\\b|const\\s+${name}\\s*=)`);
  const at = lines.findIndex((l) => l.startsWith('+') && re.test(l));
  if (at < 0) return null;
  return lines.slice(at, at + DEFINITION_LINES).map((l) => l.replace(/^\+/, '')).join('\n');
}

// Looks only in tracked files, matches the exported definition, never writes.
function definitionFromRepo(name, repoRoot) {
  let hit;
  try {
    hit = execFileSync('git', ['grep', '-n', '-E', `export (async )?(function|const) ${name}\\b`, '--', '*.ts', '*.tsx', '*.mjs'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0];
  } catch { return null; }
  const m = hit?.match(/^([^:]+):(\d+):/);
  if (!m) return null;
  const start = Number(m[2]);
  try {
    return execFileSync('sed', ['-n', `${start},${start + DEFINITION_LINES - 1}p`, m[1]], { cwd: repoRoot, encoding: 'utf8' });
  } catch { return null; }
}

export function buildContextPack(fileBody, fullDiff, repoRoot = process.cwd()) {
  const parts = [];
  let used = 0;
  for (const name of calledIdentifiers(fileBody)) {
    const def = definitionFromDiff(fullDiff, name) ?? definitionFromRepo(name, repoRoot);
    if (!def) continue;
    if (used + def.length > MAX_PACK_CHARS) break;
    parts.push(def.trimEnd());
    used += def.length;
  }
  return parts.join('\n---\n');
}
```

### `scripts/review/verify.mjs`

```js
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
```

### `scripts/review/eval.mjs`

```js
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
  const models = arg('--model') ? [arg('--model')] : verified;
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
```

### `scripts/review/lenses.json`

```json
[
  { "id": "null-guard", "paths": ["**/*.ts", "**/*.tsx", "**/*.mjs"], "severity": "medium",
    "question": "Can a value used in an added line be null, undefined, or an empty array where the code assumes it is present?",
    "source": "general" },
  { "id": "error-path", "paths": ["**/*.ts", "**/*.tsx", "**/*.mjs"], "severity": "medium",
    "question": "Does an added line call fetch, a database, or JSON.parse without handling the failure case?",
    "source": "general" },
  { "id": "auth", "paths": ["app/api/**"], "severity": "high",
    "question": "Does an added API route trust a user id, org id, or role from the request body or query instead of the Clerk session?",
    "source": ".coderabbit.yaml app/api/**" },
  { "id": "secret", "paths": ["**/*.ts", "**/*.tsx", "**/*.mjs"], "severity": "high",
    "question": "Does an added line put a secret, key, token, or internal URL into a NEXT_PUBLIC_ variable, a log, or a response?",
    "source": ".coderabbit.yaml **/*.ts" },
  { "id": "webhook-sig", "paths": ["app/api/**"], "severity": "high",
    "question": "Does an added webhook handler read or trust the request body before verifying the signature?",
    "source": ".coderabbit.yaml app/api/**" },
  { "id": "shared-drift", "paths": ["lib/shared/**"], "severity": "high",
    "question": "Does this diff change a file that is mirrored byte-identical in gcp3-mobile, outside its base-URL seam?",
    "source": ".coderabbit.yaml lib/shared/**" },
  { "id": "timeout", "paths": ["**/*.ts", "**/*.tsx", "**/*.mjs"], "severity": "medium",
    "question": "Does an added fetch to a model or vendor lack an AbortSignal or timeout budget?",
    "source": "MODEL_CHAIN_WALK_BUDGET_MS incident" },
  { "id": "test-asserts", "paths": ["__tests__/**", "**/*.test.ts", "**/*.test.tsx"], "severity": "low",
    "question": "Does an added test lack an assertion that could fail?",
    "source": "general" },
  { "id": "fallthrough", "paths": ["lib/openrouter.ts", "lib/**/*chain*", "lib/**/*fallback*"], "severity": "medium",
    "question": "Does an added fallback chain stop on a status it should retry, or retry a status it should stop on?",
    "source": "openrouter.ts 403/429 history" }
]
```

### `scripts/review/golden/expected.json`

```json
{
  "auth-from-body.diff": ["auth", "null-guard", "error-path"],
  "next-public-secret.diff": ["secret"],
  "webhook-no-sig.diff": ["webhook-sig"],
  "clean-refactor.diff": []
}
```

### `scripts/review/golden/auth-from-body.diff`

```diff
diff --git a/app/api/x/route.ts b/app/api/x/route.ts
+++ b/app/api/x/route.ts
@@ -0,0 +1,6 @@
+export async function POST(req: Request) {
+  const body = await req.json();
+  const userId = body.userId;
+  const rows = await sql`SELECT id FROM portfolios WHERE user_id = ${userId}`;
+  const first = rows[0].id;
+}
```

### `scripts/review/golden/next-public-secret.diff`

```diff
diff --git a/lib/config.ts b/lib/config.ts
+++ b/lib/config.ts
@@ -0,0 +1,2 @@
+export const stripeKey = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;
+export const label = "billing";
```

### `scripts/review/golden/webhook-no-sig.diff`

```diff
diff --git a/app/api/webhooks/stripe/route.ts b/app/api/webhooks/stripe/route.ts
+++ b/app/api/webhooks/stripe/route.ts
@@ -0,0 +1,5 @@
+export async function POST(req: Request) {
+  const event = await req.json();
+  if (event.type === "invoice.paid") await grantAccess(event.data.object.customer);
+  return new Response("ok");
+}
```

### `scripts/review/golden/clean-refactor.diff`

```diff
diff --git a/lib/format.ts b/lib/format.ts
+++ b/lib/format.ts
@@ -0,0 +1,3 @@
+export function formatPct(value: number): string {
+  return `${(value * 100).toFixed(1)}%`;
+}
```

### `__tests__/free-pr-review.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { addedLineNumber, anchorQuote, globToRegExp, isFree, lensesForPath, splitDiff } from "../scripts/review/core.mjs";
import { calledIdentifiers } from "../scripts/review/context-pack.mjs";
import { verifierChain } from "../scripts/review/verify.mjs";

const DIFF = [
  "diff --git a/app/api/x/route.ts b/app/api/x/route.ts",
  "+++ b/app/api/x/route.ts",
  "@@ -3,2 +10,4 @@",
  " context line",
  "-removed line here",
  "+  const userId = body.userId;",
  "+  const first = rows[0].id;",
].join("\n");

describe("isFree", () => {
  it("requires prompt and completion priced at 0", () => {
    expect(isFree({ prompt: "0", completion: "0" })).toBe(true);
    expect(isFree({ prompt: "0", completion: "0", request: "0" })).toBe(true);
    expect(isFree({ prompt: "0" })).toBe(false);
    expect(isFree({ prompt: "0", completion: "0.000001" })).toBe(false);
    expect(isFree({ prompt: "0", completion: "0", request: "0.01" })).toBe(false);
    expect(isFree(undefined)).toBe(false);
  });
});

describe("quote anchoring", () => {
  it("returns the new-file line of the matching + line", () => {
    expect(addedLineNumber(DIFF, "const first = rows[0].id;")).toBe(12);
  });
  it("rejects quotes from removed lines and short quotes", () => {
    expect(anchorQuote(DIFF, "removed line here").anchored).toBe(false);
    expect(anchorQuote(DIFF, "+x").anchored).toBe(false);
    expect(anchorQuote(DIFF, "+  const userId = body.userId;").line).toBe(11);
  });
});

describe("path routing", () => {
  it("routes by glob and skips non-code files", () => {
    const lenses = [{ id: "a", paths: ["app/api/**"] }, { id: "b", paths: ["**/*.ts"] }];
    expect(lensesForPath(lenses, "app/api/x/route.ts").map((l: { id: string }) => l.id)).toEqual(["a", "b"]);
    expect(lensesForPath(lenses, "lib/x.ts").map((l: { id: string }) => l.id)).toEqual(["b"]);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(splitDiff(DIFF.replace(/route\.ts/g, "notes.md"))[0].skipped).toBe(true);
  });
});

describe("context pack and verifier routing", () => {
  it("collects called identifiers from + lines only", () => {
    expect(calledIdentifiers("+ hasActiveBetaGrant(meta)\n- oldThing(x)\n+ if (ok)")).toEqual(["hasActiveBetaGrant"]);
  });
  it("prefers a different vendor for the verifier", () => {
    const chain = ["nvidia/a:free", "nvidia/b:free", "liquid/c:free"];
    expect(verifierChain(chain, "nvidia/a:free")[0]).toBe("liquid/c:free");
  });
});
```

### `.claude/commands/freereview.md`

```md
# /freereview [PR] — Free-model PR review (preview first, post only on a yes)

Reviews a PR with verified-$0 OpenRouter models. Read
`docs/free-model-pr-review.md` for the design. Output is unverified triage, not
a replacement for CodeRabbit.

1. **Preflight.** `cd` to the repo, run `gh auth status`, and confirm
   `grep -cE '^OPENROUTER_API_KEY=.+' .env.local` prints `1`. Never print the key.
2. **Tools first.** `npx tsc --noEmit` and `npx eslint` on the PR's changed `.ts/.tsx` files.
3. **Golden check** (skip if run in the last day):
   `node scripts/review/eval.mjs` — stop if a model's recall is below 0.5.
4. **Review.** Source the key from `.env.local` without printing it, then
   `gh pr diff <PR> | node scripts/free-pr-review.mjs | tee <scratchpad>/free-review-pr<PR>.json`.
   Exit `2` or `3` means the free-ness check stopped the run — report it, don't retry blindly.
5. **Report** the tally, `verifyTally`, `skipped`, `truncated` and `served`. If
   `unanswered > 0` or any file was truncated, say the review is **partial**.
6. **Preview** the inline comments (doc §5 Step 6a). Findings with
   `verdict: "false"` or `anchored: false` are never posted. `secret` findings
   get a generic comment with no quote.
7. **Post only after the user says yes** (doc §5 Step 6b). Event is always `COMMENT`.
```

### `docs/review-invariants.md`

```md
# Review invariants — short cards for the free-model reviewer

Each card is ≤5 bullets so a small model can hold it. A lens in
[`scripts/review/lenses.json`](../scripts/review/lenses.json) pulls **one** card
into its prompt. They mirror [`.coderabbit.yaml`](../.coderabbit.yaml).

## auth
- The Clerk session is the source of truth for who is calling.
- A user id, org id or role in the body or query is untrusted input.
- Check it against the session before using it in a query.

## secret
- `NEXT_PUBLIC_*` ships to the client bundle; secrets never go there.
- Backend and internal service URLs use server-only env vars.
- Secrets never appear in logs or responses.

## webhook-sig
- Verify the signature before trusting the body.
- Read the raw body for verification, then parse.

## shared-drift
- Mirrored files in `lib/shared/` are byte-identical with `gcp3-mobile/lib/`.
- Only the declared base-URL seam may differ.

## timeout / fallthrough
- Every model or vendor fetch gets an `AbortSignal` and counts toward `MODEL_CHAIN_WALK_BUDGET_MS`.
- Retry on 402, 429 and 5xx; stop on other 4xx.
```

---

## See also

- [`lib/openrouter.ts`](../lib/openrouter.ts): the chain, the fallback walk and the timeout budget
- [`scripts/refresh-free-models.mjs`](../scripts/refresh-free-models.mjs): weekly rotation and live probing
- [`docs/free-model-rotation-status.md`](free-model-rotation-status.md): rotation history and the reachability gap
- [`docs/wiki-portal/concept-small-model-prompting.md`](wiki-portal/concept-small-model-prompting.md): the prompt contract these lenses follow
- [`.coderabbit.yaml`](../.coderabbit.yaml): the invariants the lenses should mirror
