#!/usr/bin/env node
/**
 * engine-run — drive /api/pipeline/engine-run through every chunk of the
 * universe, then /api/pipeline/engine-label until nothing is left to label.
 *
 *   node scripts/engine-run.mjs                    # shadow mode
 *   node scripts/engine-run.mjs --mode=live --feed=iex --limit=400
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = {};
try {
  for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]+)"?$/);
    if (m) env[m[1]] = m[2];
  }
} catch {
  /* .env.local absent */
}
const get = (k) => process.env[k] ?? env[k];
const fail = (message) => {
  console.error(`engine-run: ${message}`);
  process.exit(1);
};

const PORTAL_URL = (get("PORTAL_URL") ?? "http://localhost:3000").replace(/\/$/, "");
{
  const { protocol, hostname } = new URL(PORTAL_URL);
  if (protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    fail(`PORTAL_URL (${PORTAL_URL}) is not HTTPS and not loopback — refusing to send the push secret in cleartext.`);
  }
}
const SECRET = get("PORTAL_PUSH_SECRET");
if (!SECRET) fail("PORTAL_PUSH_SECRET is not set");

const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const MODE = flag("mode") ?? "shadow";
const FEED = flag("feed") ?? "iex";
const LIMIT = Number(flag("limit") ?? 400);
if (!["shadow", "live"].includes(MODE)) fail("--mode must be shadow or live");
if (!["iex", "sip"].includes(FEED)) fail("--feed must be iex or sip");
if (!Number.isInteger(LIMIT) || LIMIT < 1) fail("--limit must be a positive integer");
const MAX_LABEL_ROUNDS = 200;

async function call(path, body) {
  const res = await fetch(`${PORTAL_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const runId = `engine-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const total = { written: 0, skipped: 0, failed: 0, degraded: 0, hits: 0 };
  let offset = 0;
  while (offset !== null) {
    const out = await call("/api/pipeline/engine-run", { runId, mode: MODE, feed: FEED, offset, limit: LIMIT });
    for (const k of Object.keys(total)) total[k] += out[k] ?? 0;
    console.log(`[chunk] offset=${offset} processed=${out.processed} written=${out.written} skipped=${out.skipped} failed=${out.failed} hits=${out.hits}`);
    offset = out.nextOffset;
  }

  let labeled = 0;
  for (let round = 0; round < MAX_LABEL_ROUNDS; round++) {
    const out = await call("/api/pipeline/engine-label", {});
    labeled += out.written;
    if (!out.remaining) break;
  }
  console.log(`[done] runId=${runId} mode=${MODE} written=${total.written} skipped=${total.skipped} failed=${total.failed} degraded=${total.degraded} hits=${total.hits} labeled=${labeled}`);
  if (total.written === 0) fail("wrote no structure rows — are daily_bars populated for this feed?");
}

main().catch((e) => fail(e.message));
