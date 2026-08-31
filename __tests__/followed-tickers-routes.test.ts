/**
 * followed-tickers pipeline routes — auth-contract tests.
 *
 * These assert the CRON_SECRET gate only (the path that returns before any DB
 * call). `@/lib/db` is mocked so no DATABASE_URL is needed and no query can
 * run. The selection/observation/judge logic is covered by the pure-module
 * tests (eval-scoring, eval-judge, followed-tickers-policy) and would need a
 * Neon branch to exercise end-to-end.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// A no-op tagged-template stand-in for the `neon()` sql client. If any test
// path actually reaches a query this rejects loudly rather than hanging.
vi.mock("@/lib/db", () => ({
  default: () => Promise.reject(new Error("DB query attempted in an auth-gate test")),
}));

const { POST: selectPOST } = await import("@/app/api/pipeline/followed-tickers-select/route");
const { POST: trackPOST } = await import("@/app/api/pipeline/followed-tickers/route");
const { POST: judgePOST } = await import("@/app/api/pipeline/followed-tickers-judge/route");

const ROUTES: Array<{ name: string; path: string; fn: (r: NextRequest) => Promise<Response> }> = [
  { name: "followed-tickers-select", path: "followed-tickers-select", fn: selectPOST },
  { name: "followed-tickers", path: "followed-tickers", fn: trackPOST },
  { name: "followed-tickers-judge", path: "followed-tickers-judge", fn: judgePOST },
];

function req(path: string, auth?: string): NextRequest {
  return new NextRequest(`https://financial.nuwrrrld.com/api/pipeline/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: "{}",
  });
}

const ORIGINAL = process.env.CRON_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe("CRON_SECRET gate", () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      it("503s when CRON_SECRET is unconfigured", async () => {
        delete process.env.CRON_SECRET;
        const res = await route.fn(req(route.path, "Bearer whatever"));
        expect(res.status).toBe(503);
      });

      it("401s on a missing bearer", async () => {
        process.env.CRON_SECRET = "s3cr3t";
        const res = await route.fn(req(route.path));
        expect(res.status).toBe(401);
      });

      it("401s on a wrong bearer", async () => {
        process.env.CRON_SECRET = "s3cr3t";
        const res = await route.fn(req(route.path, "Bearer nope"));
        expect(res.status).toBe(401);
      });
    });
  }
});
