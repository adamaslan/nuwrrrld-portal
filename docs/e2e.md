When frontend features fail silently in production across **OpenRouter**, **Firebase**, and **GCP**, the root cause is almost always unhandled API rejections, unclosed streams, expired tokens, or missing UI error states.

The following Playwright test suite is specifically structured to intercept network boundaries and expose broken or silent frontend failure modes in shipped code.

> **Note on scope.** Playwright is *not* currently a dependency of this repo — the suites below are the target state. The shipped test runner is vitest (`unit` / `components` / `live` projects, see `vitest.config.ts`), and the shipped end-to-end sweep is `scripts/nulogdash.mjs`. Sections 0 and 4–6 describe what already works today; sections 1–3 describe the browser tier still to be added.

---

### 0. Preflight: Prove the Keys Are Real Before Trusting a Green Run

A suite that mocks every network boundary will pass with **zero** working credentials. That is the single most expensive failure mode in this repo: a green CI run that proves nothing about the models, the database, or billing. Run the credential preflight *first*, and treat its output as a gate on how much the rest of the run is worth.

**Never print secret values.** Assert on *presence, shape, and liveness* — the variable name, the key prefix, the HTTP status the provider returns. Every helper below is written to fail without echoing the material it checks.

#### Environment variable contract

These are the names only. Real values live in `.env.local` (git-ignored) and in the Vercel project settings per environment; `.env.example` is the canonical list.

| Variable | Surface | Failure mode if missing/wrong |
| --- | --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | client | Auth completely dead. A `pk_test_` prefix in production silently caps MAU. |
| `CLERK_SECRET_KEY` | server | Every `auth()` call fails; API routes 401 uniformly. |
| `NULOGDASH_ADMIN_EMAILS` | server | Empty ⇒ admin console 404s for *everyone*. Reads as broken, not as open. |
| `OPENROUTER_API_KEY` | server | Nu AI / council / health-AI routes return 503. Live vitest project skips itself. |
| `MCP_BACKEND_URL` | server | Signals/market data fall back to a hardcoded Cloud Run URL. |
| `DATABASE_URL` | server | Hard failure — every persisted feature breaks. |
| `STRIPE_SECRET_KEY` | server | Checkout/portal 500. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | client | Checkout redirect never initializes. |
| `STRIPE_WEBHOOK_SECRET` | server | Placeholder value ⇒ webhook rejects every event; subscription sync dies quietly. |
| `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL` | server | Checkout 500s on "price not configured". |
| `PORTAL_PUSH_SECRET` | server | `/api/signals/refresh` rejects all pushes with CONFIG_ERROR. |
| `CRON_SECRET` | server | Retention digest / trial-nudge crons unauthorized. |
| `RESEND_API_KEY` | server | Retention emails silently undelivered. |
| `IP_HASH_SECRET` | server | Public council demo returns 503 rather than hashing IPs unkeyed. |
| `DISCORD_FEEDBACK_WEBHOOK_URL` | server | Optional. Feedback posts no-op. |
| `NULOGDASH_SESSION_COOKIE` | test only | Auth-required features report `blocked` instead of running. |
| `NULOGDASH_BASE_URL` | test only | Defaults to `http://localhost:3000`. |

#### Shape assertions (no values echoed)

```typescript
import { test, expect } from '@playwright/test';

/** Assert a var exists and matches an expected prefix — never logs the value. */
function expectKeyShape(name: string, prefixes: string[]): void {
  const value = process.env[name];
  expect(value, `${name} is not set`).toBeTruthy();
  expect(
    prefixes.some((p) => value!.startsWith(p)),
    `${name} does not start with any of ${prefixes.join('|')} (value not shown)`,
  ).toBe(true);
  // Catches the copy-paste classic: a trailing newline that produces
  // "Invalid character in header content [Authorization]" at request time.
  expect(value, `${name} has leading/trailing whitespace`).toBe(value!.trim());
}

test.describe('Credential preflight', () => {
  test('AI + auth + billing keys are present and well-formed', () => {
    expectKeyShape('OPENROUTER_API_KEY', ['sk-or-v1-']);
    expectKeyShape('CLERK_SECRET_KEY', ['sk_test_', 'sk_live_']);
    expectKeyShape('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', ['pk_test_', 'pk_live_']);
    expectKeyShape('STRIPE_SECRET_KEY', ['sk_test_', 'sk_live_']);
    expectKeyShape('STRIPE_WEBHOOK_SECRET', ['whsec_']);
    expectKeyShape('DATABASE_URL', ['postgres://', 'postgresql://']);
  });

  test('EXPOSE: placeholder values that pass a presence check but fail at runtime', () => {
    const placeholderish = /(placeholder|changeme|your[-_]?key|xxx+|TODO)/i;
    for (const name of [
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRICE_MONTHLY',
      'STRIPE_PRICE_ANNUAL',
      'PORTAL_PUSH_SECRET',
      'IP_HASH_SECRET',
    ]) {
      const value = process.env[name] ?? '';
      expect(placeholderish.test(value), `${name} is still a placeholder`).toBe(false);
    }
  });

  test('EXPOSE: production running on development-tier keys', () => {
    test.skip(process.env.VERCEL_ENV !== 'production', 'production-only guard');
    expect(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!.startsWith('pk_live_')).toBe(true);
    expect(process.env.STRIPE_SECRET_KEY!.startsWith('sk_live_')).toBe(true);
  });
});
```

#### Liveness assertions (one cheap authenticated call per provider)

Shape is necessary but not sufficient — a well-formed *revoked* key passes every check above. One cheap call per provider is what actually proves the credential works.

```typescript
test.describe('Credential liveness', () => {
  // Cheapest authenticated OpenRouter call: list models. No tokens consumed.
  test('OPENROUTER_API_KEY is accepted by the provider', async ({ request }) => {
    const res = await request.get('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    expect(res.status(), 'OpenRouter rejected the key (401 = revoked/typo)').toBe(200);
  });

  // Balance retrieval is free and does not mutate anything.
  test('STRIPE_SECRET_KEY is accepted by Stripe', async ({ request }) => {
    const res = await request.get('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    expect(res.status()).toBe(200);
  });

  test('MCP_BACKEND_URL points at a live GCP Cloud Run service', async ({ request }) => {
    const base = process.env.MCP_BACKEND_URL;
    test.skip(!base, 'MCP_BACKEND_URL unset — falls back to the hardcoded default');
    const res = await request.get(`${base}/health`, { timeout: 15_000 });
    // First hit may be a cold start; 5xx here is the cold-start signature.
    expect(res.status(), 'MCP backend unhealthy or cold-starting past timeout').toBe(200);
  });
});
```

---

### 1. OpenRouter Tests: Stream Stalls & Rate Limit Swallowing

When streaming responses from OpenRouter stall or hit rate limits (HTTP 429), the frontend frequently leaves generation spinners active indefinitely or crashes due to unhandled JSON parsing.

```typescript
import { test, expect } from '@playwright/test';

test.describe('OpenRouter Frontend Resiliency', () => {
  // Capture unhandled JS errors and console errors on the window
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (exception) => {
      throw new Error(`Unhandled Client Exception: ${exception.message}`);
    });
  });

  test('EXPOSE: Stalled SSE stream leaves UI stuck in loading state', async ({ page }) => {
    // Intercept OpenRouter API call and simulate an abruptly terminated SSE stream
    await page.route('**/api/openrouter/chat', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        // Send initial chunk but do NOT send [DONE] signal or close stream cleanly
        body: 'data: {"choices":[{"delta":{"content":"Generating response..."}}]}\n\n',
      });
    });

    await page.goto('/ai-chat');
    await page.getByPlaceholder('Ask anything...').fill('Generate code');
    await page.getByRole('button', { name: 'Send' }).click();

    // Verify UI handles stalled streams (should timeout and display error/retry button)
    const errorAlert = page.getByRole('alert');
    const sendButton = page.getByRole('button', { name: 'Send' });

    // EXPECTED TO FAIL if frontend lacks SSE timeout logic:
    await expect(errorAlert).toBeVisible({ timeout: 10000 });
    await expect(sendButton).toBeEnabled();
  });

  test('EXPOSE: OpenRouter HTTP 429 Rate Limit shows raw stack trace or infinite spinner', async ({ page }) => {
    await page.route('**/api/openrouter/chat', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Rate limit reached', code: 429 } }),
      });
    });

    await page.goto('/ai-chat');
    await page.getByPlaceholder('Ask anything...').fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();

    // EXPECTED TO FAIL if frontend swallows catch block or fails to notify user
    await expect(page.getByText(/rate limit/i)).toBeVisible();
    await expect(page.getByTestId('loading-spinner')).not.toBeVisible();
  });
});

```

---

### 2. Firebase Tests: Expired Tokens & Security Rule Blockades

Shipped frontends often fail when Firebase ID tokens expire mid-session or when Firestore security rules reject queries, resulting in frozen skeleton loaders.

```typescript
import { test, expect } from '@playwright/test';

test.describe('Firebase Auth & Firestore Fault Injection', () => {
  test('EXPOSE: Expired Firebase Auth JWT causes silent 401 on backend calls', async ({ page }) => {
    await page.goto('/dashboard');

    // Force Firebase client SDK to hold an expired JWT token
    await page.evaluate(() => {
      const authKey = Object.keys(localStorage).find((k) => k.startsWith('firebase:authUser'));
      if (authKey) {
        const authData = JSON.parse(localStorage.getItem(authKey) || '{}');
        authData.stsTokenManager.accessToken = 'EXPIRED_MOCK_JWT_TOKEN';
        authData.stsTokenManager.expirationTime = Date.now() - 3600000;
        localStorage.setItem(authKey, JSON.stringify(authData));
      }
    });

    // Intercept backend API call to GCP/Next.js route returning 401
    await page.route('**/api/user/data', (route) => route.fulfill({ status: 401 }));

    await page.getByRole('button', { name: 'Fetch Data' }).click();

    // EXPECTED TO FAIL if UI fails to prompt re-authentication or refresh token
    await expect(page.getByText(/session expired/i)).toBeVisible();
  });

  test('EXPOSE: Firestore permission-denied leaves infinite skeleton loading state', async ({ page }) => {
    // Intercept Firestore RPC/REST endpoint with Security Rule denial
    await page.route('**/google.firestore.v1.Firestore/Listen/**', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify([{ error: { code: 403, message: 'Missing or insufficient permissions.' } }]),
      });
    });

    await page.goto('/projects');

    // EXPECTED TO FAIL if component ignores Firestore listener onError callback
    await expect(page.getByTestId('skeleton-loader')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/access denied/i)).toBeVisible();
  });
});

```

---

### 3. GCP Tests: Signed URL CORS & Cloud Run Cold Starts

Frontend file uploads via Google Cloud Storage (GCS) signed URLs fail silently if bucket CORS policies are misconfigured, while GCP Cloud Run cold starts trigger client-side fetch timeouts.

```typescript
import { test, expect } from '@playwright/test';

test.describe('GCP Integration Diagnostics', () => {
  test('EXPOSE: GCS Signed URL Direct Upload fails due to CORS or Bucket Permissions', async ({ page }) => {
    await page.goto('/upload');

    // 1. Mock backend generating signed URL successfully
    await page.route('**/api/gcp/signed-url', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ url: 'https://storage.googleapis.com/my-bucket/file.png?signature=123' }),
      })
    );

    // 2. Mock direct PUT request to GCS failing due to CORS / 403 Forbidden
    await page.route('https://storage.googleapis.com/**', (route) =>
      route.fulfill({
        status: 403,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '<Error><Code>AccessDenied</Code></Error>',
      })
    );

    // Trigger upload
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByText('Select File').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from('mock-file-content'),
    });

    // EXPECTED TO FAIL if UI progress bar stays stuck at 0% without error notification
    await expect(page.getByText(/upload failed/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry Upload' })).toBeVisible();
  });

  test('EXPOSE: Cloud Run 504 Cold-Start Timeout triggers uncaught promise rejection', async ({ page }) => {
    // Intercept Cloud Run backend service with a Gateway Timeout
    await page.route('**/api/v1/heavy-process', async (route) => {
      await route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Gateway Timeout - Container Cold Start' }),
      });
    });

    await page.goto('/analytics');
    await page.getByRole('button', { name: 'Run Report' }).click();

    // EXPECTED TO FAIL if app crashes or fails to offer retry state
    await expect(page.getByText(/server took too long to respond/i)).toBeVisible();
  });
});

```

---

### 4. Backend Aggregate Health: One Request That Grades Every Dependency

`GET /api/health` already fans out to MCP, Neon, Stripe, OpenRouter, and Clerk in parallel and returns a per-dependency verdict (`ok` / `degraded` / `down` / `not_configured`) plus latency. It returns **503** when anything is `down`, **200** otherwise. Assert against it before assuming any feature-level failure is a frontend bug — a red feature test on top of a red dependency is noise, not a finding.

```typescript
import { test, expect } from '@playwright/test';

type DepStatus = 'ok' | 'degraded' | 'down' | 'not_configured';

test.describe('Backend dependency health', () => {
  test('every dependency is reachable and configured', async ({ request }) => {
    const res = await request.get('/api/health');
    const body = await res.json();

    // Print the whole verdict on failure — it contains statuses and latencies,
    // never key material (see app/api/health/route.ts).
    const summary = JSON.stringify(body, null, 2);

    expect(res.status(), `health returned 503:\n${summary}`).toBe(200);

    for (const dep of ['mcp', 'neon', 'stripe', 'openrouter', 'clerk'] as const) {
      const status: DepStatus = body[dep].status;
      expect(status, `${dep} is ${status}:\n${summary}`).toBe('ok');
    }
  });

  test('EXPOSE: latency budget — a dependency slow enough to time out user requests', async ({ request }) => {
    const body = await (await request.get('/api/health')).json();
    const BUDGET_MS = 2_000;
    for (const dep of ['mcp', 'neon', 'stripe', 'openrouter'] as const) {
      const latency = body[dep].latencyMs;
      if (latency === null) continue; // not measured / not configured
      expect(latency, `${dep} took ${latency}ms (budget ${BUDGET_MS}ms)`).toBeLessThan(BUDGET_MS);
    }
  });

  test('EXPOSE: frontend renders a usable page when /api/health reports down', async ({ page }) => {
    await page.route('**/api/health', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'down', neon: { status: 'down', latencyMs: null } }),
      }),
    );
    await page.goto('/dashboard');
    // EXPECTED TO FAIL if a degraded backend produces a blank page instead of a banner
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
```

### 5. AI Route Contract Tests: Real Models, Bounded Cost

The `live` vitest project already exists for this (`npm run test:live`) and deliberately sits outside the default suite: real model calls are slow, cost quota, and are legitimately flaky. `test/live-setup.ts` loads `.env.local` and — critically — **warns loudly and skips** when `OPENROUTER_API_KEY` is absent, because a green live run with no key proves nothing.

Rules that keep this tier honest:

* **Never fabricate a key to make the suite pass.** Skipping is the correct outcome; a fake key turns a missing-credential bug into a green run.
* **`fileParallelism: false`** — free-tier providers rate-limit on concurrency. Serial execution keeps the 429s to the ones the fallback chain is *meant* to absorb rather than manufacturing your own.
* **`retry: 1`** absorbs single transient 429s without hiding a genuinely broken model chain.
* **Assert on structure, not prose.** Model output varies run to run; assert the response parses, carries the required fields, and respects the schema — never that it contains a specific sentence.

```typescript
// __tests__/live/ai-routes.live.test.ts — vitest, not Playwright
import { describe, it, expect } from 'vitest';

const hasKey = Boolean(process.env.OPENROUTER_API_KEY);
const BASE = process.env.NULOGDASH_BASE_URL ?? 'http://localhost:3000';

describe.skipIf(!hasKey)('AI routes against real models', () => {
  it('POST /api/nuai returns a structured, non-empty completion', async () => {
    const res = await fetch(`${BASE}/api/nuai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Summarize AAPL in one sentence.' }),
    });

    // 503 here means the key is missing server-side even though it is present
    // in this process — a real, common env-plumbing bug worth failing on.
    expect(res.status, 'route reported the AI provider unconfigured').not.toBe(503);
    expect(res.ok).toBe(true);

    const body = await res.json();
    expect(typeof body.text).toBe('string');
    expect(body.text.length).toBeGreaterThan(0);
  });

  it('EXPOSE: the fallback chain actually falls back rather than surfacing 429', async () => {
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(`${BASE}/api/council/sample`).then((r) => r.status),
      ),
    );
    // A raw 429 reaching the client means the model fallback chain didn't engage.
    expect(results).not.toContain(429);
  });
});
```

### 6. Running the Whole Thing

Order matters: credentials → dependencies → mocked frontend suites → live model calls. Each tier is only meaningful if the one above it passed.

```bash
# 1. Credentials + dependency graph. Cheap, and gates everything else.
curl -fsS http://localhost:3000/api/health | jq '.status, (.mcp,.neon,.stripe,.openrouter,.clerk|.status)'

# 2. Fast deterministic suites — no network, no keys required.
npm test                     # unit + components

# 3. Feature-level end-to-end sweep against a running `next dev`.
npm run nulogdash            # writes .nulogdash/latest.json

# 4. Browser-tier fault injection (sections 1–3 above, once Playwright lands).
npx playwright test

# 5. Real model calls. Slow, quota-consuming, serial. Run last, run deliberately.
npm run test:live
```

**Secret hygiene in test output.** `scripts/nulogdash.mjs` redacts at *write* time, not render time — reasons are persisted to `.nulogdash/latest.json` and later rendered on a dashboard page, so scrubbing late would leak into the file on disk. Reuse the same pattern set in any new test reporter:

```javascript
const SECRET_PATTERNS = [
  /sk_(live|test)_[A-Za-z0-9]+/g,
  /pk_(live|test)_[A-Za-z0-9]+/g,
  /whsec_[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];
```

Also: `.nulogdash/` and `.env.local` must stay git-ignored, and Playwright traces/videos capture request headers — scope trace retention to `retain-on-failure` and scrub before attaching artifacts to CI.

**`blocked` is not `fail`.** When a dependency is `down` or `not_configured`, every feature depending on it reports **blocked**, not failed. Collapsing the two produces a wall of red that hides the one real regression underneath it — the distinction is the whole point of running the preflight first.

---

### 7. Playwright Test for VS Code: Running These From the Editor

The [Playwright Test for VS Code](https://playwright.dev/docs/getting-started-vscode) extension (`ms-playwright.playwright`, requires Playwright **v1.38+**) turns everything above into gutter play buttons, a Test Explorer tree, and breakpoint debugging inside the editor. It is the fastest way to run *one* fault-injection test in isolation, which matters here because the live tier is serial and quota-consuming.

Since Playwright isn't installed in this repo yet, start from the command palette: **`Test: Install Playwright`**. It scaffolds `playwright.config.ts`, lets you pick default browsers, and optionally adds a GitHub Action. Replace the generated config with the one below, which wires in this repo's env contract.

The extension has one hard constraint worth knowing before you fight it: **it discovers config and env through `playwright.config.ts`, not through your shell.** A test that passes in `npx playwright test` and fails in the editor is almost always this — the editor process never saw `.env.local`.

#### Config that makes the extension work with this repo's env contract

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// The VS Code extension spawns its own Node process and does NOT inherit the
// shell that has .env.local loaded. Load it here or every §0 preflight test
// fails in the editor while passing on the CLI.
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '.env.local') });

const BASE_URL = process.env.NULOGDASH_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  // Serial in the editor: the live/AI tiers rate-limit on concurrency, same
  // reason vitest's live project sets fileParallelism: false.
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? [['github'], ['html']] : [['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // retain-on-failure, never 'on' — traces capture request headers, which
    // means Authorization: Bearer <key> lands in the artifact.
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // Lets you hit "run test" in the gutter without a dev server already up.
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },

  projects: [
    // Ordered so the Test Explorer tree mirrors the §6 pipeline. Named
    // projects also give you a per-tier filter in the extension sidebar.
    { name: 'preflight', testMatch: /preflight\.spec\.ts/ },
    { name: 'health', testMatch: /health\.spec\.ts/, dependencies: ['preflight'] },
    {
      name: 'frontend',
      testMatch: /\.(openrouter|firebase|gcp)\.spec\.ts/,
      dependencies: ['preflight'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

`dependencies: ['preflight']` is the piece that pays off in the editor: hitting "Run all tests" in the Test Explorer runs the credential gate *first* and skips the rest if it fails, so you get "the key is revoked" instead of forty red frontend tests.

#### Recommend the extension to anyone opening the repo

```jsonc
// .vscode/extensions.json
{
  "recommendations": [
    "ms-playwright.playwright",
    "vitest.explorer",        // the unit/components/live projects, same tree
    "dbaeumer.vscode-eslint"
  ]
}
```

#### Running: which click, and when

The **green triangle** in the editor gutter runs the test at your cursor. The **grey triangle** in the Testing sidebar runs a test, file, or whole project. While a run is in flight the **execution line is highlighted**, and once it completes **each step shows its duration inline** — which is how you tell a stalled-SSE test apart from a slow one without opening a trace.

Those per-step durations are the fastest read on this stack's two dominant latency sources:

| What you see | Almost always means |
| --- | --- |
| `page.goto('/dashboard')` slow, rest fast | `next dev` compiling the route on first hit. Re-run; it won't repeat. |
| A single `expect` eating ~10s then passing | The assertion is winning on retry, not on first paint. Real, and it will flake in CI. |
| `page.route` handler step ~0ms, assertion times out | The route pattern never matched — the real request went to the network. Breakpoint the handler. |
| Everything fast, one MCP-backed step slow | Cloud Run cold start, not a frontend bug. Check `/api/health` latency first. |

By default the extension selects the first Playwright project as the run profile. Because the config above names projects by *tier* rather than by browser, "run all" walks `preflight → health → frontend` in dependency order. Set browser coverage in the Test Explorer instead, where a single test can be sent to multiple browsers.

At install time you're asked to pick default browsers and whether to add a GitHub Action. For this repo: **Chromium is enough** for the fault-injection suites — they assert on network interception and error-state UI, neither of which is engine-specific. Add WebKit only if you start testing the Lenis/Framer Motion scroll work, where Safari genuinely diverges. Say yes to the GitHub Action only once §0's secrets exist as repo secrets; without them the workflow goes red on every PR for the wrong reason.

#### Sidebar controls, mapped to this suite

These are checkboxes and buttons in the **Playwright sidebar** (under the Testing view), not `settings.json` keys — there is no `playwright.reuseBrowser` setting to add.

| Control | Why it matters for fault injection |
| --- | --- |
| **Show browsers** (checkbox) | The single biggest win for §§1–3. Re-run the stalled-SSE test and *watch* the spinner hang instead of inferring it from an assertion timeout. "Close all browsers" tears them down. |
| **Show trace viewer** (checkbox) | Full trace of the run inline. Best for the GCS signed-URL upload test, where the failure is a request you need to inspect rather than a visible UI state. |
| **Watch mode** (eye icon) | Re-runs on save. Use it on a *single* frontend test while iterating on error-state UI. Never enable it on the `preflight` or live tiers — it will burn provider quota on every keystroke-save. |
| **Project checkboxes** | The `preflight` / `health` / `frontend` projects from the config appear here. Uncheck `frontend` to run just the credential gate when you only want to know if a key is live. |
| **Gear icon** | Switches between multiple `playwright.config.ts` files if this repo ever gains a second one. |
| **Global setup trigger** | Runs setup manually, so you can re-establish an auth state without a full test run. |

#### Debugging a fault-injection test in the editor

1. Set a breakpoint inside the `page.route(...)` handler — this confirms the interception actually fired. A test that "fails to expose the bug" is frequently a route pattern that never matched.
2. Right-click the test → **Debug Test**. Hover a value while paused to inspect it; when the cursor sits on a Playwright action or locator, the corresponding element is **highlighted in the browser**.
3. **Tune locators at a breakpoint.** Edit the locator in the source while paused and watch the highlight update live — this is how you confirm `getByTestId('loading-spinner')` matches something real before committing an assertion that would otherwise pass vacuously.
4. On failure the extension shows **expected vs. received plus the full call log inline in the editor**, which usually removes the need to open the HTML report at all.

#### Recording tests against real error states

**Record new** (sidebar button) opens a browser and writes your actions to a new spec. **Record at cursor** generates actions into an existing test at the cursor position — run the test, park the cursor at the end, keep generating.

The genuinely useful trick for this suite: a `page.route(...)` fault injection is *already active* while recording. Stub OpenRouter to a 429, then record your clicks through the resulting broken UI — you capture the real error-state selectors rather than guessing at markup that only renders on failure.

**Pick locator** (button) — hover the browser to see available locators, click an element to store it in the locators box, Enter copies it to the clipboard, Escape cancels. Use this instead of hand-writing selectors like `getByText(/rate limit/i)` and discovering at runtime that the copy differs.

#### Gitignore additions

Playwright writes report and trace artifacts into the repo root. Traces embed request headers, so these must not be committed:

```gitignore
# playwright — reports and traces (traces embed request headers, incl. bearer tokens)
/test-results/
/playwright-report/
/blob-report/
/playwright/.cache/
```

Note that `.gitignore` already has a broad `.env*` rule, so `.env.local` is covered — but the extension's "run test" will happily load it, which is exactly what you want locally and exactly what must *not* happen in CI (CI supplies secrets via environment, and `dotenv.config()` above no-ops when the file is absent).

#### Known friction

* **Test Explorer shows zero tests.** The extension needs `playwright.config.ts` at the workspace root. Multi-root workspaces need the config's folder added as a root; the sidebar gear icon switches between configs.
* **Tests pass on CLI, fail in editor.** Env not loaded — see the `dotenv.config()` line above.
* **`webServer` times out on first run.** `next dev` cold-starts slower than the 60s default; the config above raises it to 120s.
* **The Vitest and Playwright extensions both claim `__tests__/`.** Keep Playwright specs in `e2e/` (the `testDir` above) so the two trees never overlap.
* **Watch mode re-running the live tier.** The eye icon watches whatever is selected. Uncheck every project except `frontend` before enabling it, or a save loop will hammer OpenRouter.
* **Extension requires Playwright v1.38+.** Older pinned versions load the config but show an empty tree.

---

### 8. CI: Sharded Execution, Keyless GCP Auth, and PR-Level Diagnostics

`.github/workflows/playwright.yml` currently holds the **scaffolded default** — one runner, `npx playwright test`, no env, no secrets, no PR feedback. Against this repo it fails immediately: every §0 preflight test needs credentials the workflow never supplies, and the whole suite runs serially on a single node. This section is the production replacement.

`ci.yml` already covers lint + `npm test` (unit/components) and the shared-core drift check against `gcp3-mobile`. Keep that as-is — this workflow owns the browser tier only, so the two don't overlap.

#### Matrix parallel sharding

Playwright splits the suite by shard index. Four runners cut wall-clock time substantially on a suite this size, since fault-injection tests are dominated by waiting on timeouts rather than CPU.

```yaml
strategy:
  fail-fast: false          # one shard's failure must not cancel the others,
                            # or you lose the diagnostic value of the rest
  matrix:
    shard: [1, 2, 3, 4]
```

```yaml
- run: npx playwright test --shard=${{ matrix.shard }}/4
```

Two constraints specific to this suite:

* **Sharding is per-file.** The `preflight` project must therefore run as a `dependencies` gate inside each shard (it's cheap — shape checks are pure string work), not as a separate job, or shards 2–4 start before credentials are known good.
* **`workers: 1` still applies to the live tier.** Sharding gives you cross-*node* parallelism while keeping within-node concurrency at 1, which is exactly what free-tier provider rate limits want. Four nodes × 1 worker won't trip 429s the way 1 node × 4 workers does.

#### Keyless GCP auth via Workload Identity Federation

The MCP backend is Cloud Run. Do **not** put a service-account JSON key in repo secrets — WIF exchanges GitHub's OIDC token for short-lived GCP credentials, so there is no long-lived key to leak or rotate.

```yaml
permissions:
  contents: read
  id-token: write        # REQUIRED — without it the OIDC token is never minted
                         # and google-github-actions/auth fails with a confusing
                         # "unable to get credentials" rather than a clear cause
  pull-requests: write   # for the diagnostic reporter below
```

```yaml
- name: Authenticate to GCP (keyless)
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
    service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

# Now MCP_BACKEND_URL can be called with an identity token rather than
# an unauthenticated fetch, if the Cloud Run service requires auth.
- name: Mint Cloud Run identity token
  run: |
    echo "MCP_ID_TOKEN=$(gcloud auth print-identity-token \
      --audiences=${{ secrets.MCP_BACKEND_URL }})" >> "$GITHUB_ENV"
```

`GCP_WIF_PROVIDER` and `GCP_SERVICE_ACCOUNT` are resource *identifiers*, not credentials — but keep them in secrets anyway so the project number isn't published in logs.

#### Browser binary caching

`npx playwright install --with-deps` downloads ~400MB per run. Cache it, keyed on the resolved Playwright version so a version bump invalidates cleanly:

```yaml
- name: Resolve Playwright version
  run: echo "PW_VERSION=$(node -p "require('@playwright/test/package.json').version")" >> "$GITHUB_ENV"

- uses: actions/cache@v4
  id: pw-cache
  with:
    path: ~/.cache/ms-playwright
    key: ${{ runner.os }}-playwright-${{ env.PW_VERSION }}

- name: Install browsers
  if: steps.pw-cache.outputs.cache-hit != 'true'
  run: npx playwright install --with-deps chromium

# System deps are NOT in the cached path — install them even on a cache hit.
- name: Install OS deps
  if: steps.pw-cache.outputs.cache-hit == 'true'
  run: npx playwright install-deps chromium
```

#### The full workflow

```yaml
# .github/workflows/e2e-resiliency.yml
name: E2E Resiliency

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Kills stale runs when a new commit lands on the same PR. Without this, a
# branch pushed three times in five minutes occupies 12 runners racing to
# report on code nobody is looking at anymore.
concurrency:
  group: e2e-resiliency-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  id-token: write
  pull-requests: write

jobs:
  e2e:
    timeout-minutes: 30
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - run: npm ci

      - name: Resolve Playwright version
        run: echo "PW_VERSION=$(node -p "require('@playwright/test/package.json').version")" >> "$GITHUB_ENV"

      - uses: actions/cache@v4
        id: pw-cache
        with:
          path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-playwright-${{ env.PW_VERSION }}

      - name: Install browsers
        if: steps.pw-cache.outputs.cache-hit != 'true'
        run: npx playwright install --with-deps chromium

      - name: Install OS deps (cache hit)
        if: steps.pw-cache.outputs.cache-hit == 'true'
        run: npx playwright install-deps chromium

      - name: Authenticate to GCP (keyless)
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

      # Step-level id + continue-on-error so the reporter can distinguish
      # "tests failed" from "the job died before tests ran".
      - name: Run Playwright tests
        id: pw
        continue-on-error: true
        env:
          # Names only — values live in repo secrets. Mirrors §0's contract.
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}
          CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}
          NULOGDASH_ADMIN_EMAILS: ${{ secrets.NULOGDASH_ADMIN_EMAILS }}
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          MCP_BACKEND_URL: ${{ secrets.MCP_BACKEND_URL }}
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}
          NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: ${{ secrets.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY }}
          STRIPE_WEBHOOK_SECRET: ${{ secrets.STRIPE_WEBHOOK_SECRET }}
          STRIPE_PRICE_MONTHLY: ${{ secrets.STRIPE_PRICE_MONTHLY }}
          STRIPE_PRICE_ANNUAL: ${{ secrets.STRIPE_PRICE_ANNUAL }}
          PORTAL_PUSH_SECRET: ${{ secrets.PORTAL_PUSH_SECRET }}
          IP_HASH_SECRET: ${{ secrets.IP_HASH_SECRET }}
        # --reporter=blob overrides the config's html reporter. Required:
        # HTML reports cannot be merged across shards, blob reports can.
        run: npx playwright test --reporter=blob --shard=${{ matrix.shard }}/4

      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: blob-report-${{ matrix.shard }}
          path: blob-report/
          # 1 day, not 7 — these are intermediate inputs to the merge job and
          # are worthless once it has run. Only the merged report needs a week.
          retention-days: 1

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: traces-shard-${{ matrix.shard }}
          path: test-results/
          retention-days: 7

      - name: Fail the job if tests failed
        if: steps.pw.outcome == 'failure'
        run: exit 1

  report:
    needs: e2e
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci

      - uses: actions/download-artifact@v4
        with:
          path: all-blob-reports
          pattern: blob-report-*
          merge-multiple: true

      # html for humans, json for the reporter below to parse exact counts.
      # PLAYWRIGHT_JSON_OUTPUT_NAME is how the json reporter is told to write a
      # file instead of dumping to stdout.
      - name: Merge shard reports
        env:
          PLAYWRIGHT_JSON_OUTPUT_NAME: consolidated-summary.json
        run: npx playwright merge-reports --reporter=html,json ./all-blob-reports

      - uses: actions/upload-artifact@v4
        with:
          name: playwright-report-merged
          path: |
            playwright-report/
            consolidated-summary.json
          retention-days: 7

      - name: Post diagnostic summary to the PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const url = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}` +
                        `/actions/runs/${context.runId}`;

            // An invisible HTML comment is the durable identity for this
            // comment — matching on a visible heading breaks the moment
            // someone edits the wording, and then it spams a new comment
            // on every push.
            const MARKER = '<!-- e2e-resiliency-bot -->';

            let stats = null;
            try {
              const raw = JSON.parse(fs.readFileSync('consolidated-summary.json', 'utf8'));
              stats = raw.stats ?? null;
            } catch { /* summary absent — the job died before merge */ }

            const passed  = stats?.expected   ?? 0;
            const failed  = stats?.unexpected ?? 0;
            const flaky   = stats?.flaky      ?? 0;
            const skipped = stats?.skipped    ?? 0;

            const badge = !stats  ? '⚠️ **NO RESULTS** — suite did not report'
                        : failed  ? '❌ **FAILED** — unhandled client state exposed'
                                  : '✅ **PASSED**';

            const body = [
              MARKER,
              `### E2E Resiliency Results: ${badge}`,
              '',
              `**${passed} passed** · **${failed} failed** · ${flaky} flaky · ${skipped} skipped`,
              '',
              `Sharded across 4 runners. [Full run](${url})`,
              '',
              '<details><summary>Diagnostics</summary>',
              '',
              '- `playwright-report-merged` — merged HTML report + JSON summary (7 days)',
              '- `traces-shard-N` — Trace Viewer `.zip` files, failures only',
              '- Open a trace with: `npx playwright show-trace <file>.zip`',
              '',
              'A **blocked** result means a dependency was down or unconfigured,',
              'not that the feature regressed — check `/api/health` first.',
              '',
              `Flaky (${flaky}) means it passed on retry. Real, and it will bite in prod.`,
              '</details>',
            ].join('\n');

            // Update in place rather than appending a comment per push.
            const { data: comments } = await github.rest.issues.listComments({
              ...context.repo, issue_number: context.issue.number,
            });
            const existing = comments.find((c) => c.body?.includes(MARKER));

            if (existing) {
              await github.rest.issues.updateComment({
                ...context.repo, comment_id: existing.id, body,
              });
            } else {
              await github.rest.issues.createComment({
                ...context.repo, issue_number: context.issue.number, body,
              });
            }
```

#### Artifact retention and the secret-leak boundary

**7 days, not the scaffold's 30.** Traces embed request headers — `Authorization: Bearer <key>` included — so every retention day is a day that material sits in artifact storage. Shorten the window and keep `trace: 'retain-on-failure'` (§7's config) so passing runs produce nothing to leak.

Retention is **tiered by how long the artifact is actually useful**:

* **`blob-report-*` — 1 day.** The only shardable format; HTML reports cannot be merged. Pure intermediate input to the merge job, worthless once it has run.
* **`traces-shard-N` — 7 days**, `if: failure()` only. Open locally with `npx playwright show-trace <file>.zip`.
* **`playwright-report-merged` — 7 days.** Merged HTML plus the JSON summary; the one humans actually read.

Two guardrails worth keeping: `persist-credentials: false` on checkout (matches `ci.yml`), and never `echo` an env var in a debug step — GitHub masks registered secrets in logs, but a *derived* value (a token minted from one, a key sliced for logging) is not masked.

#### Traps in the common "hardened workflow" templates

Several of these circulate as copy-paste blocks. They look right and fail in ways that cost an afternoon:

* **`hashFiles('package-lock.json')` as the browser cache key.** Invalidates the ~400MB browser cache on *every* dependency change, including ones that don't touch Playwright. Key on the resolved Playwright version instead (as above) — that's the only thing the binaries actually track.
* **Installing browsers only on a cache miss.** The cache covers `~/.cache/ms-playwright` but **not** the OS-level libraries `--with-deps` installs. On a cache hit you still need `npx playwright install-deps chromium`, or Chromium fails to launch with a missing-shared-library error.
* **`${{ process.env.PREVIEW_URL }}` inside a workflow.** Not a thing — `process.env` is Node, not GitHub Actions expression syntax. It silently evaluates to empty. Use `${{ vars.PREVIEW_URL || 'http://localhost:3000' }}`, or let §7's `webServer` block start `next dev` and skip the variable entirely.
* **`mv summary.json consolidated-summary.json || true`.** The json reporter doesn't write `summary.json` by default; it writes to stdout unless `PLAYWRIGHT_JSON_OUTPUT_NAME` is set. The `|| true` then swallows the failure, so the reporter silently posts zeros for every count — a green-looking comment on a suite that never ran.
* **Indented template literals in `github-script`.** A `const body = \`...\`` indented to match the YAML block puts leading spaces on every line; four or more renders the whole comment as a code block on GitHub. Build the string with an array `.join('\n')` (as above) rather than a multi-line literal.
* **`checks: write` for "inline annotations".** Grants permission but produces no annotations on its own — Playwright's `github` reporter is what emits them, and that only runs on the sharded job, not the merge job.

#### Migrating off the scaffold

The existing `playwright.yml` and this workflow will both run and both fail — the scaffold has no credentials. Delete `playwright.yml` when adding this one; don't leave the stub in place expecting it to be harmlessly redundant.

---

### Key Diagnostic Assertions Checklist

* **Credential Presence & Shape:** Assert every variable in the contract table exists, matches its expected prefix, and has no stray whitespace — asserting on shape, never echoing the value.
* **Credential Liveness:** One cheap authenticated call per provider. A well-formed but revoked key passes every shape check and fails at runtime.
* **Placeholder Detection:** Assert that `whsec_placeholder_*`-style values are absent — they pass presence checks and then reject every webhook event in silence.
* **Dependency Gating:** Assert `/api/health` is 200 with all five dependencies `ok` before trusting any feature-level result.
* **Unhandled Promise Rejections:** `page.on('pageerror')` forces Playwright to fail immediately if the frontend swallows `fetch()` errors without a catch block.
* **State Deadlocks:** Assert that interactive elements (`getByRole('button')`) return to an enabled state after any network error.
* **Orphaned Loaders:** Assert that `getByTestId('loading-spinner')` is **not** visible when network routes return non-200 HTTP statuses.
* **Skip Loudly:** A suite that skips on a missing key must say so in the output. A silent skip is indistinguishable from a pass.
* **Locators Verified, Not Guessed:** Use **Pick locator** or breakpoint locator-tuning to confirm every selector matches real markup. An assertion against a test id that doesn't exist fails for the wrong reason — or passes vacuously under `.not.toBeVisible()`.
* **Traces Scoped:** `trace`/`video` set to `retain-on-failure`, never `on` — traces embed request headers including bearer tokens. Retain artifacts 7 days, not 30.
* **Shards Fail Independently:** `fail-fast: false` — one shard's failure must not cancel the other three, or you lose the diagnostic value of the rest of the suite.
* **No Long-Lived Cloud Keys:** GCP auth via Workload Identity Federation with `id-token: write`, never a service-account JSON in repo secrets.
* **Idempotent PR Reporting:** Match on a hidden `<!-- e2e-resiliency-bot -->` marker and update in place. Matching on a visible heading breaks when the wording changes, and then it spams a comment per push.
* **Concurrency Cancellation:** `cancel-in-progress: true` on `github.ref`, or three quick pushes tie up twelve runners reporting on dead commits.