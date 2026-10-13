import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateResult, formatResults, parseOptions } from "../scripts/ttfb-guard.mjs";

test("only timings strictly above the threshold fail", () => {
  const result = { url: "http://localhost/", statusCode: 200 };
  for (const ttfbMs of [0, 1999.9, 2000]) {
    assert.equal(evaluateResult({ ...result, ttfbMs }, 2000), "PASS");
  }
  assert.equal(evaluateResult({ ...result, ttfbMs: 2000.01 }, 2000), "SLOW");
  assert.equal(evaluateResult({ ...result, ttfbMs: 11 }, 10), "SLOW");
});

test("errors, invalid timings, and non-success HTTP statuses fail closed", () => {
  assert.equal(evaluateResult({ error: "connection refused" }, 2000), "ERROR");
  for (const ttfbMs of [NaN, Infinity, -1, undefined]) {
    assert.equal(evaluateResult({ statusCode: 200, ttfbMs }, 2000), "ERROR");
  }
  for (const statusCode of [301, 404, 500, undefined]) {
    assert.equal(evaluateResult({ statusCode, ttfbMs: 1 }, 2000), "HTTP FAIL");
  }
});

test("table shows URL, status, precise timing, verdict, and error detail", () => {
  const table = formatResults([
    { url: "http://localhost/", statusCode: 200, ttfbMs: 12.34 },
    { url: "http://localhost/pricing", statusCode: 200, ttfbMs: 2001 },
    { url: "http://localhost/signals", error: "Timed out\nafter 10000 ms" },
  ], 2000);
  assert.match(table, /TTFB limit: 2000 ms/);
  assert.match(table, /URL\s+\| HTTP \| TTFB \(ms\) \| RESULT/);
  assert.match(table, /localhost\/\s+\| 200\s+\| 12\.3\s+\| PASS/);
  assert.match(table, /pricing\s+\| 200\s+\| 2001\.0\s+\| SLOW/);
  assert.match(table, /signals\s+\| -\s+\| -\s+\| ERROR\s+\| Timed out after 10000 ms/);
  assert.equal(table.split("\n").length, 6);
});

test("defaults and environment options resolve public URLs", () => {
  assert.deepEqual(parseOptions([], { BASE_URL: "http://localhost:3000" }), {
    urls: ["http://localhost:3000/", "http://localhost:3000/pricing", "http://localhost:3000/signals"],
    thresholdMs: 2000, timeoutMs: 10000,
  });
  assert.equal(parseOptions([], { BASE_URL: "http://localhost", TTFB_THRESHOLD_MS: "123" }).thresholdMs, 123);
});

test("CLI values override environment and allow absolute URLs", () => {
  assert.deepEqual(parseOptions([
    "--base-url", "http://localhost:4000", "--urls", "/one, https://example.com/two",
    "--threshold-ms", "50", "--timeout-ms", "100",
  ], { BASE_URL: "http://localhost:3000", TTFB_URLS: "/ignored", TTFB_THRESHOLD_MS: "9" }), {
    urls: ["http://localhost:4000/one", "https://example.com/two"], thresholdMs: 50, timeoutMs: 100,
  });
});

test("invalid configuration is rejected before requests", () => {
  assert.throws(() => parseOptions([], {}), /Set BASE_URL/);
  for (const value of ["0", "-1", "Infinity", "oops", ""]) {
    assert.throws(() => parseOptions([`--threshold-ms=${value}`], { BASE_URL: "http://localhost" }), /positive finite/);
  }
  for (const urls of ["", "/,", "ftp://example.com", "http://user:password@example.com"]) {
    assert.throws(() => parseOptions(["--urls", urls], { BASE_URL: "http://localhost" }));
  }
  assert.throws(() => parseOptions(["--typo"], { BASE_URL: "http://localhost" }));
  assert.deepEqual(parseOptions(["--help"], {}), { help: true });
});
