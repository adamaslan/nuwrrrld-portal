/**
 * Public-page GET timing, from request start through response headers (no body).
 * npm run ttfb:guard -- --base-url http://localhost:3000 --urls /,/pricing,/signals
 * Options: --threshold-ms 2000, --timeout-ms 10000; corresponding env vars:
 * BASE_URL, TTFB_URLS (comma separated), TTFB_THRESHOLD_MS, TTFB_TIMEOUT_MS.
 * One cold connection per URL; redirects fail rather than hiding a login hop.
 */
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_URLS = "/,/pricing,/signals";

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return number;
}

function publicUrl(value, base) {
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("URLs must use HTTP(S) without embedded credentials");
  }
  return url;
}

export function parseOptions(args, env = process.env) {
  const { values } = parseArgs({ args, options: {
    "base-url": { type: "string" }, urls: { type: "string" },
    "threshold-ms": { type: "string" }, "timeout-ms": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) return { help: true };
  const base = values["base-url"] ?? env.BASE_URL;
  if (!base) throw new Error("Set BASE_URL or pass --base-url http://localhost:3000");
  publicUrl(base);
  const paths = (values.urls ?? env.TTFB_URLS ?? DEFAULT_URLS).split(",").map((s) => s.trim());
  if (paths.some((s) => !s)) throw new Error("--urls / TTFB_URLS must contain a non-empty comma-separated URL list");
  return {
    urls: paths.map((value) => publicUrl(value, base).href),
    thresholdMs: positiveNumber(values["threshold-ms"] ?? env.TTFB_THRESHOLD_MS ?? 2000, "threshold-ms"),
    timeoutMs: positiveNumber(values["timeout-ms"] ?? env.TTFB_TIMEOUT_MS ?? 10000, "timeout-ms"),
  };
}

export function evaluateResult(result, thresholdMs) {
  if (result.error) return "ERROR";
  if (!Number.isFinite(result.ttfbMs) || result.ttfbMs < 0) return "ERROR";
  if (result.statusCode < 200 || result.statusCode >= 300 || !result.statusCode) return "HTTP FAIL";
  return result.ttfbMs > thresholdMs ? "SLOW" : "PASS";
}

export function formatResults(results, thresholdMs) {
  const rows = results.map((result) => [
    result.url, String(result.statusCode ?? "-"),
    Number.isFinite(result.ttfbMs) ? result.ttfbMs.toFixed(1) : "-",
    evaluateResult(result, thresholdMs), result.error ?? "",
  ]);
  const headings = ["URL", "HTTP", "TTFB (ms)", "RESULT", "DETAIL"];
  const widths = headings.map((heading, i) => Math.max(heading.length, ...rows.map((row) => row[i].length)));
  const line = (row) => row.map((cell, i) => cell.replace(/[\r\n\t]/g, " ").padEnd(widths[i])).join(" | ").trimEnd();
  return [`TTFB limit: ${thresholdMs} ms (GET through response headers)`, line(headings),
    widths.map((width) => "-".repeat(width)).join("-+-"), ...rows.map(line)].join("\n");
}

export function measureTtfb(url, timeoutMs) {
  return new Promise((resolveResult) => {
    const start = performance.now();
    const client = new URL(url).protocol === "https:" ? https : http;
    const request = client.get(url, { agent: false }, (response) => {
      clearTimeout(timer);
      resolveResult({ url, statusCode: response.statusCode, ttfbMs: performance.now() - start });
      response.destroy();
    });
    // A wall-clock deadline also bounds DNS/connect stalls, not just socket idle time.
    const timer = setTimeout(() => request.destroy(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
    request.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ url, error: error.message });
    });
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args, env);
  if (options.help) {
    console.log("Usage: npm run ttfb:guard -- --base-url URL [--urls /,/pricing,/signals] [--threshold-ms 2000] [--timeout-ms 10000]\nEnv: BASE_URL, TTFB_URLS, TTFB_THRESHOLD_MS, TTFB_TIMEOUT_MS");
    return 0;
  }
  const results = [];
  for (const url of options.urls) results.push(await measureTtfb(url, options.timeoutMs));
  console.log(formatResults(results, options.thresholdMs));
  return results.some((result) => evaluateResult(result, options.thresholdMs) !== "PASS") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`TTFB guard: ${error.message}`);
    process.exitCode = 1;
  });
}
