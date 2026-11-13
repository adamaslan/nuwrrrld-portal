import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ call: vi.fn(), create: vi.fn(), message: vi.fn(), verdict: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: 'fixture' }), currentUser: async () => ({ publicMetadata: {} }) }));
vi.mock('@/lib/subscription', () => ({ hasEntitlement: () => true }));
vi.mock('@/lib/subscription-admin', () => ({ resolveTier: () => 'pro' }));
vi.mock('@/lib/openrouter', async (original) => ({ ...await original<typeof import('@/lib/openrouter')>(), callCouncilSeat: m.call }));
vi.mock('@/lib/council-db', () => ({ createSession: m.create, saveMessage: m.message, saveVerdict: m.verdict }));
import { CouncilUnavailableError } from '@/lib/openrouter';
import { POST } from '@/app/api/council/route';
const request = () => new NextRequest('https://fixture.test/api/council', { method: 'POST', body: JSON.stringify({ prompt: 'Fixture signal', seat: 'T1' }) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('OPENROUTER_API_KEY', 'fixture-not-real'); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('quick ask failure boundaries', () => {
 it('returns a stable truthful code and writes no fake answer on empty chain', async () => {
  m.call.mockRejectedValue(new CouncilUnavailableError('council_no_content', 'T1', 429));
  const res = await POST(request());
  expect(res.status).toBe(503); expect(await res.json()).toEqual({ error: 'council_no_content' });
  expect(m.call).toHaveBeenCalledTimes(1); expect(m.create).not.toHaveBeenCalled(); expect(m.message).not.toHaveBeenCalled(); expect(m.verdict).not.toHaveBeenCalled();
 });
 it('does not disguise missing config as a transient retry', async () => {
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const res = await POST(request()); expect(res.status).toBe(503); expect(await res.json()).toEqual({ error: 'council_not_configured' }); expect(m.call).not.toHaveBeenCalled();
 });
 it('never publishes malformed output after the existing single format retry', async () => {
  m.call.mockResolvedValue({ answer: 'not a structured verdict', model: 'fixture', seat: 'T1', latencyMs: 1 });
  const res = await POST(request()); expect(res.status).toBe(502); expect(await res.json()).toEqual({ error: 'council_response_invalid' }); expect(m.call).toHaveBeenCalledTimes(2); expect(m.create).not.toHaveBeenCalled();
 });
});
