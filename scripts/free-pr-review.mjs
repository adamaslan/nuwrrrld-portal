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
