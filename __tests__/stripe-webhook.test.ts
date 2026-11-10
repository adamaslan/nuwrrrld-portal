/** Offline webhook regression tests: real SDK signature verification, fake
 * customer/subscription lookups and Clerk writes. Never touches Stripe/Clerk. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Stripe from 'stripe';
const f = vi.hoisted(() => ({ customerRetrieve: vi.fn(), customerUpdate: vi.fn(), subscriptionRetrieve: vi.fn(), metadata: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ clerkClient: async () => ({ users: { updateUserMetadata: f.metadata } }) }));
vi.mock('@/lib/stripe', async () => {
  const { default: SDK } = await import('stripe');
  const sdk = new SDK('sk_test_offline_fixture');
  return { getStripe: () => ({ webhooks: sdk.webhooks, customers: { retrieve: f.customerRetrieve, update: f.customerUpdate }, subscriptions: { retrieve: f.subscriptionRetrieve } }) };
});
import { POST } from '@/app/api/webhooks/stripe/route';
const secret = 'whsec_offline_fixture_only';
const sdk = new Stripe('sk_test_offline_fixture');
const sub = (status = 'trialing') => ({ id: 'sub_fixture', customer: 'cus_fixture', status, trial_end: 1900000000, items: { data: [{ current_period_end: 1900604800 }] } });
function req(type: string, object: unknown, signature: 'valid' | 'invalid' | 'missing' = 'valid') {
  const payload = JSON.stringify({ id: 'evt_fixture', object: 'event', type, data: { object } });
  const sig = sdk.webhooks.generateTestHeaderString({ payload, secret: signature === 'invalid' ? 'whsec_wrong_fixture' : secret });
  return new NextRequest('http://localhost/api/webhooks/stripe', { method: 'POST', body: payload, headers: signature === 'missing' ? {} : { 'stripe-signature': sig } });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
  f.customerRetrieve.mockResolvedValue({ id: 'cus_fixture', metadata: { clerk_user_id: 'user_fixture' } });
  f.customerUpdate.mockResolvedValue({}); f.subscriptionRetrieve.mockResolvedValue(sub()); f.metadata.mockResolvedValue({});
});
afterEach(() => { vi.unstubAllEnvs(); });
describe('Stripe webhook offline signatures and retries', () => {
  it.each(['missing', 'invalid'] as const)('rejects %s signature without side effects', async kind => {
    expect((await POST(req('customer.subscription.created', sub(), kind))).status).toBe(400);
    expect(f.metadata).not.toHaveBeenCalled(); expect(f.customerRetrieve).not.toHaveBeenCalled();
  });
  it('fails closed on missing webhook configuration', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    expect((await POST(req('customer.subscription.created', sub()))).status).toBe(500);
    expect(f.metadata).not.toHaveBeenCalled();
  });
  it.each(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'])('%s sync failure is retryable, redelivery recovers', async type => {
    f.metadata.mockRejectedValueOnce(new Error('offline Clerk outage'));
    const status = type.endsWith('deleted') ? 'canceled' : 'active';
    const first = await POST(req(type, sub(status)));
    expect(first.status).toBe(500); expect(await first.json()).toEqual({ error: 'sync failed, will retry' });
    expect((await POST(req(type, sub(status)))).status).toBe(200);
    expect(f.metadata).toHaveBeenLastCalledWith('user_fixture', expect.objectContaining({ publicMetadata: expect.objectContaining({ subscription_status: status, subscription_tier: status === 'canceled' ? 'free' : 'pro' }) }));
  });
  it.each([['trialing','pro'],['active','pro'],['past_due','pro'],['canceled','free'],['paused','free']])('maps %s to %s only after a valid signed event', async (status,tier) => {
    expect((await POST(req('customer.subscription.updated', sub(status)))).status).toBe(200);
    expect(f.metadata).toHaveBeenCalledWith('user_fixture', expect.objectContaining({ publicMetadata: expect.objectContaining({ subscription_status: status, subscription_tier: tier }) }));
  });
  it('checkout sync failure retries and then recovers with matching customer metadata', async () => {
    const session = { customer: 'cus_fixture', subscription: 'sub_fixture', metadata: { clerk_user_id: 'user_fixture' } };
    f.customerUpdate.mockRejectedValueOnce(new Error('offline update outage'));
    expect((await POST(req('checkout.session.completed', session))).status).toBe(500);
    expect((await POST(req('checkout.session.completed', session))).status).toBe(200);
    expect(f.customerUpdate).toHaveBeenLastCalledWith('cus_fixture', { metadata: { clerk_user_id: 'user_fixture' } });
    expect(f.subscriptionRetrieve).toHaveBeenCalledWith('sub_fixture'); expect(f.metadata).toHaveBeenCalledTimes(1);
  });
  it('subscription-created uses subscription binding before checkout stamps customer metadata', async () => {
    f.customerRetrieve.mockResolvedValue({ id: 'cus_fixture', metadata: {} });
    expect((await POST(req('customer.subscription.created', { ...sub(), metadata: { clerk_user_id: 'user_fixture' } }))).status).toBe(200);
    expect(f.metadata).toHaveBeenCalledWith('user_fixture', expect.anything());
  });
  it('missing both bindings returns 500; redelivery after checkout binding recovers', async () => {
    f.customerRetrieve.mockResolvedValueOnce({ id: 'cus_fixture', metadata: {} });
    expect((await POST(req('customer.subscription.created', sub()))).status).toBe(500);
    expect(f.metadata).not.toHaveBeenCalled();
    expect((await POST(req('customer.subscription.created', sub()))).status).toBe(200);
    expect(f.metadata).toHaveBeenCalledTimes(1);
  });
  it('deleted customer is not falsely acknowledged as a completed sync', async () => {
    f.customerRetrieve.mockResolvedValue({ id: 'cus_fixture', deleted: true });
    expect((await POST(req('customer.subscription.deleted', sub('canceled')))).status).toBe(500);
    expect(f.metadata).not.toHaveBeenCalled();
  });
  it('revokes via subscription binding even after the Stripe customer is deleted', async () => {
    f.customerRetrieve.mockResolvedValue({ id: 'cus_fixture', deleted: true });
    const canceled = { ...sub('canceled'), metadata: { clerk_user_id: 'user_subscription' } };
    expect((await POST(req('customer.subscription.deleted', canceled))).status).toBe(200);
    expect(f.customerRetrieve).not.toHaveBeenCalled();
    expect(f.metadata).toHaveBeenCalledWith('user_subscription', expect.objectContaining({ publicMetadata: expect.objectContaining({ subscription_status: 'canceled', subscription_tier: 'free' }) }));
  });
  it('duplicate event converges to identical metadata (does not claim deduplication)', async () => {
    await POST(req('customer.subscription.updated', sub())); await POST(req('customer.subscription.updated', sub()));
    expect(f.metadata).toHaveBeenCalledTimes(2);
    expect(f.metadata.mock.calls[0]).toEqual(f.metadata.mock.calls[1]);
  });
  it('unknown events acknowledge without entitlement mutation', async () => {
    expect((await POST(req('unhandled.fixture', {}))).status).toBe(200); expect(f.metadata).not.toHaveBeenCalled();
  });
});
