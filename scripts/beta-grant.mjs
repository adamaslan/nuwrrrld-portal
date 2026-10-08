#!/usr/bin/env node
/**
 * Grant / revoke a beta-tester Pro grant on a Clerk user's publicMetadata.
 * docs/beta-testers-robust-plan.md §4b.
 *
 *   node scripts/beta-grant.mjs <email> [--days N | --no-expiry] [--note "..."] [--revoke] [--dry-run]
 *
 * Reads CLERK_SECRET_KEY from the environment or .env.local (never printed).
 * The key's instance (dev vs prod) decides where the grant lands.
 */
import { readFileSync, existsSync } from "node:fs";

const DEFAULT_DAYS = 90;
const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--days" && args[args.indexOf(a) - 1] !== "--note")?.trim().toLowerCase();
const flag = (n) => args.includes(`--${n}`);
const value = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);

if (!email || !email.includes("@")) {
  console.error('usage: node scripts/beta-grant.mjs <email> [--days N | --no-expiry] [--note "..."] [--revoke] [--dry-run]');
  process.exit(2);
}

function loadKey() {
  if (process.env.CLERK_SECRET_KEY) return process.env.CLERK_SECRET_KEY;
  if (!existsSync(".env.local")) return null;
  const line = readFileSync(".env.local", "utf8").split("\n").find((l) => l.startsWith("CLERK_SECRET_KEY="));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "") : null;
}
const key = loadKey();
if (!key) {
  console.error("CLERK_SECRET_KEY not found in env or .env.local");
  process.exit(2);
}

const api = (path, init = {}) =>
  fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });

const lookup = await api(`/users?email_address=${encodeURIComponent(email)}&limit=2`);
if (!lookup.ok) {
  console.error(`lookup failed: HTTP ${lookup.status}`);
  process.exit(1);
}
const [user] = await lookup.json();
if (!user) {
  console.error("No account with that email on this Clerk instance — ask them to sign up first.");
  process.exit(1);
}

let beta = null;
if (!flag("revoke")) {
  const days = flag("no-expiry") ? null : Number(value("days") ?? DEFAULT_DAYS);
  if (days !== null && !(Number.isInteger(days) && days > 0 && days <= 3650)) {
    console.error("--days must be a whole number 1–3650");
    process.exit(2);
  }
  const now = new Date();
  beta = {
    tier: "pro",
    grantedAt: now.toISOString().slice(0, 10),
    expiresAt: days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10),
    grantedBy: "admin",
    ...(value("note") ? { note: value("note").slice(0, 120) } : {}),
  };
}

console.log(`${flag("revoke") ? "revoke" : "grant"} user=${user.id}`, beta ?? "");
if (flag("dry-run")) {
  console.log("dry run — nothing written");
  process.exit(0);
}

const res = await api(`/users/${user.id}/metadata`, {
  method: "PATCH",
  body: JSON.stringify({ public_metadata: { beta } }),
});
if (!res.ok) {
  console.error(`update failed: HTTP ${res.status}`);
  process.exit(1);
}
console.log("done:", JSON.stringify((await res.json()).public_metadata.beta ?? null));
