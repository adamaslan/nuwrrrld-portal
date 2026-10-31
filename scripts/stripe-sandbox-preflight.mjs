/** Read-only guard for a separately configured local/preview billing test.
 * Never creates customers, checkout sessions, subscriptions or webhooks. */
import Stripe from 'stripe';
const e = process.env;
const fail = message => { console.error(`[sandbox-preflight] ${message}`); process.exit(1); };
if (e.VERCEL_ENV === 'production' || e.BILLING_TEST_ENV !== 'isolated') fail('Use a nonproduction environment explicitly marked BILLING_TEST_ENV=isolated.');
if (!e.STRIPE_SECRET_KEY?.startsWith('sk_test_')) fail('An existing sandbox/test Stripe secret key is required. Live keys refused.');
if (!e.CLERK_SECRET_KEY?.startsWith('sk_test_') || !e.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_')) fail('Both Clerk keys must belong to a nonproduction development instance.');
if (!e.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_') || /placeholder|fixture/i.test(e.STRIPE_WEBHOOK_SECRET)) fail('A real isolated listener/endpoint signing secret is required; this script cannot verify its pairing.');
const base = e.BILLING_TEST_BASE_URL;
if (!base) fail('BILLING_TEST_BASE_URL must explicitly name the isolated app.');
const url = new URL(base);
if (url.hostname === 'financial.nuwrrrld.com' || url.hostname === 'nuwrrrld.com' || url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) fail('Live app domains and nonlocal HTTP are refused.');
const stripe = new Stripe(e.STRIPE_SECRET_KEY);
try {
  for (const name of ['STRIPE_PRICE_MONTHLY','STRIPE_PRICE_ANNUAL']) {
    if (!e[name]?.startsWith('price_') || /placeholder/i.test(e[name])) fail(`${name} must refer to an isolated test price.`);
    const price = await stripe.prices.retrieve(e[name]);
    if (price.livemode || !price.active || !price.recurring) fail(`${name} is not an active sandbox recurring price.`);
  }
  console.info('PASS: nonproduction key shapes and two active recurring sandbox prices verified read-only.');
  console.info('NOT VERIFIED: Clerk key pairing, app deployment env, webhook secret pairing/delivery, checkout, entitlement sync. Verify those before any test mutation.');
} catch {
  fail('Stripe read-only price lookup failed. Check the existing isolated config privately; no raw provider error or secret is logged.');
}
