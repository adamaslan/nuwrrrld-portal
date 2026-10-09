#!/usr/bin/env node
/**
 * Grant or revoke a beta-tester Pro grant (Clerk publicMetadata.beta) from a terminal.
 * Same effect as the nulogdash "Beta testers" panel, for when the panel is down or you
 * need to reach the dev Clerk instance from a laptop.
 *
 *   node scripts/beta-grant.mjs <email> [--expires YYYY-MM-DD] [--note "text"] [--dry-run]
 *   node scripts/beta-grant.mjs <email> --revoke [--dry-run]
 *
 * Reads CLERK_SECRET_KEY from the environment (e.g. `set -a; source .env.local; set +a`)
 * and never prints it. A key from .env.local reaches the DEV instance only.
 */
const API = 'https://api.clerk.com/v1';

const args = process.argv.slice(2);
const email = args[0]?.trim().toLowerCase();
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const dryRun = flag('--dry-run');
const revoke = flag('--revoke');
const expiresAt = value('--expires') ?? null;
const note = value('--note');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('usage: beta-grant.mjs <email> [--expires YYYY-MM-DD] [--note text] [--revoke] [--dry-run]');
if (expiresAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresAt);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const real = d && d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  if (!real) fail('--expires must be a real date in YYYY-MM-DD form');
  if (expiresAt <= new Date().toISOString().slice(0, 10)) fail('--expires must be a future date');
}
const key = process.env.CLERK_SECRET_KEY;
if (!key) fail('CLERK_SECRET_KEY is not set in the environment');

async function clerk(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  });
  if (!res.ok) fail(`Clerk ${init.method ?? 'GET'} ${path.split('?')[0]} returned ${res.status}`);
  return res.json();
}

const users = await clerk(`/users?email_address=${encodeURIComponent(email)}`);
const isVerifiedOwner = (u) =>
  u.email_addresses.some((e) => e.email_address.toLowerCase() === email && e.verification?.status === 'verified');
if (users.length === 0) fail('no account with that email on this Clerk instance (they must sign up first)');
// Prefer the account that verified the address; only a revoke may fall back to an unverified match.
const user = users.find(isVerifiedOwner) ?? (revoke ? users[0] : undefined);
if (!user) fail('that email is not verified on the account');

const beta = revoke
  ? null
  : { tier: 'pro', grantedAt: new Date().toISOString().slice(0, 10), expiresAt, grantedBy: 'admin', note: note || null };

console.log(`${dryRun ? '[dry-run] ' : ''}${revoke ? 'revoke' : 'grant'} user ${user.id}`, beta ?? '');
if (dryRun) process.exit(0);

const updated = await clerk(`/users/${user.id}/metadata`, {
  method: 'PATCH',
  body: JSON.stringify({ public_metadata: { beta } }),
});
console.log('public_metadata.beta =', updated.public_metadata?.beta ?? null);
