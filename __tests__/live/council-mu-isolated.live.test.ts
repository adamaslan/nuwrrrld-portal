/** Opt-in REAL models + REAL grounding; auth and persistence isolated. SQL is screened by a SELECT-prefix check only; that is not a read-only guarantee.
 * Never sends HTTP to the portal's publishing API. Not a deployed-auth test. */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const evidence = vi.hoisted(() => ({
  calls: [] as Array<{ seat: string; model?: string; latencyMs?: number; ok: boolean }>,
  briefs: [] as Array<{ seat: string; characters: number; datedSourceLines: string[] }>,
  attempts: [] as Array<{ model: string; status: number; responseModel?: string; cost?: number }>,
}));
vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: 'isolated-local-mu-test' }),
  currentUser: async () => ({ publicMetadata: {} }),
}));
vi.mock('@/lib/subscription', () => ({ hasEntitlement: () => true }));
vi.mock('@/lib/subscription-admin', () => ({ resolveTier: () => 'free' }));
// SQL must start with SELECT. SELECT functions can still mutate, so this is a screen, not a read-only guarantee.
vi.mock('@/lib/db', async () => {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL || 'postgresql://invalid:invalid@invalid.invalid/db');
  return { default: async (parts: TemplateStringsArray, ...values: unknown[]) => {
    if (!/^\s*SELECT\b/i.test(parts.join('?'))) throw new Error('isolated harness: non-SELECT SQL rejected');
    return sql(parts, ...values as Parameters<typeof sql> extends [unknown, ...infer R] ? R : never);
  } };
});
vi.mock('@/lib/council-db', () => ({
  recentVerdicts: async () => [], // no private/user history needed
  checkAndBumpQuota: async () => ({ allowed: true, used: 0, limit: 1, bumped: false }),
  refundQuota: async () => undefined,
  createSession: async () => null,
  saveMessage: vi.fn(() => { throw new Error('persistence must not run'); }),
  saveVerdict: vi.fn(() => { throw new Error('persistence must not run'); }),
}));
vi.mock('@/lib/council-grounding', async (original) => {
  const actual = await original<typeof import('@/lib/council-grounding')>();
  return { ...actual, buildGroundedBrief: async (...args: Parameters<typeof actual.buildGroundedBrief>) => {
    const text = await actual.buildGroundedBrief(...args);
    evidence.briefs.push({ seat: String(args[2]), characters: text.length, datedSourceLines: text.split("\n").filter(l => /date|as.of|generated|stale/i.test(l)).map(l => l.slice(0, 240)).slice(0, 6) });
    return text;
  } };
});
vi.mock('@/lib/openrouter', async (original) => {
  const actual = await original<typeof import('@/lib/openrouter')>();
  return { ...actual, runSeat: async (...args: Parameters<typeof actual.runSeat>) => {
    try {
      const result = await actual.runSeat(...args);
      evidence.calls.push({ seat: args[0], model: result.model, latencyMs: result.latencyMs, ok: !!result.answer.trim() });
      return result;
    } catch {
      evidence.calls.push({ seat: args[0], ok: false });
      throw new Error(`live seat ${args[0]} failed; inspect safe attempt status evidence`);
    }
  } };
});

it.skipIf(process.env.RUN_ISOLATED_MU !== '1')('MU real council, free-only and no persistence', async () => {
  if (!process.env.OPENROUTER_API_KEY || /dummy|placeholder|test-key|changeme/i.test(process.env.OPENROUTER_API_KEY)) {
    throw new Error('A working existing OPENROUTER_API_KEY is required; no call made');
  }
  if (!process.env.DATABASE_URL && !process.env.MCP_BACKEND_URL) {
    throw new Error('Existing DATABASE_URL or MCP_BACKEND_URL needed for actual MU grounding');
  }
  const realFetch = globalThis.fetch;
  const catalogRes = await realFetch('https://openrouter.ai/api/v1/models');
  expect(catalogRes.ok).toBe(true);
  const catalog = await catalogRes.json() as { data: Array<{ id: string; pricing: Record<string, string> }> };
  const zeroIds = new Set(catalog.data.filter(m => m.id.endsWith(':free') &&
    m.pricing.prompt === '0' && m.pricing.completion === '0' &&
    Object.values(m.pricing).every(p => Number(p) === 0)).map(m => m.id));
  let posts = 0;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://openrouter.ai/')) {
      if (url !== 'https://openrouter.ai/api/v1/chat/completions' || init?.method !== 'POST') throw new Error('unexpected OpenRouter operation blocked');
      const body = JSON.parse(String(init.body));
      if (!zeroIds.has(body.model)) return new Response('{}', { status: 404 });
      if (++posts > 80) throw new Error('80-attempt safety ceiling reached');
      body.provider = { ...(body.provider || {}), max_price: { prompt: 0, completion: 0, request: 0, image: 0 } };
      delete body.plugins; delete body.tools; delete body.models;
      const response = await realFetch(input, { ...init, body: JSON.stringify(body) });
      const copy = await response.clone().json().catch(() => ({}));
      const cost = copy.usage?.cost;
      evidence.attempts.push({ model: body.model, status: response.status, responseModel: typeof copy.model === "string" ? copy.model : undefined, ...(typeof cost === 'number' ? { cost } : {}) });
      if (typeof cost === 'number' && cost !== 0) throw new Error('nonzero usage cost returned; stop and inspect account');
      return response;
    }
    return realFetch(input, init); // existing data sources; SQL is SELECT-screened only
  });
  try {
    const { POST } = await import('@/app/api/council/deliberate/route');
    const { saveMessage, saveVerdict } = await import('@/lib/council-db');
    const res = await POST(new NextRequest('http://isolated.local/api/council/deliberate', {
      method: 'POST', body: JSON.stringify({ ticker: 'MU', question: 'Assess MU using only the supplied dated evidence. State data age and missing evidence; do not invent current prices or news.' }),
    }));
    const body = await res.json();
    console.info('MU_RESULT', JSON.stringify({ status: res.status, degradedSeats: body.degradedSeats, verdict: body.verdict }));
    expect(res.status).toBe(200);
    for (const seat of ['T1', 'T2', 'RISK', 'MACRO', 'QUANT']) {
      expect(evidence.calls.some(c => c.seat === seat && c.ok), `${seat} genuine response`).toBe(true);
    }
    expect(evidence.calls.filter(c => c.seat === 'CHAIR' && c.ok).length).toBe(4);
    expect(body.degradedSeats).toEqual([]);
    expect(body.verdict?.direction).toMatch(/^(bullish|bearish|neutral)$/);
    expect(saveMessage).not.toHaveBeenCalled();
    expect(saveVerdict).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    console.info('MU_EVIDENCE', JSON.stringify({ ...evidence, monetaryPriceCap: 0, quotaMocked: true, persistenceDisabled: true, successfulRealResponses: evidence.calls.filter(c => c.ok).length }));
  }
}, 600_000);
