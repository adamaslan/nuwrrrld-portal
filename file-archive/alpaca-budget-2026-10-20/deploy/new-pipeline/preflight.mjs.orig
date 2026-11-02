import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 10_000;

function alpacaUrl(now) {
  const end = new Date(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 14);
  const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
  url.searchParams.set("symbols", "SPY");
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());
  url.searchParams.set("sort", "desc");
  url.searchParams.set("limit", "1");
  url.searchParams.set("feed", "iex");
  return url;
}

// One manual read only. This deliberately skips the shared nwf_rate_budget
// counter, so it must not be copied as the pattern for scheduled ingestion.
async function checkAlpaca(env, fetchImpl, now) {
  const response = await fetchImpl(alpacaUrl(now), {
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return false;
  const body = await response.json();
  return Array.isArray(body?.bars?.SPY) && body.bars.SPY.length > 0;
}

async function checkOpenRouter(env, fetchImpl) {
  const response = await fetchImpl("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return false;
  const body = await response.json();
  return body?.data != null && typeof body.data === "object";
}

async function statusFor(credentialsPresent, check) {
  if (!credentialsPresent) return "missing_credentials";
  try {
    return await check() ? "ok" : "request_failed";
  } catch {
    // Do not print response bodies, request headers, or error objects: provider
    // errors can contain account metadata or credential-bearing context.
    return "request_failed";
  }
}

export async function runPreflight({ env = process.env, fetchImpl = fetch, now = Date.now(), log = console.log } = {}) {
  const alpaca = await statusFor(Boolean(env.ALPACA_API_KEY && env.ALPACA_API_SECRET),
    () => checkAlpaca(env, fetchImpl, now));
  const openrouter = await statusFor(Boolean(env.OPENROUTER_API_KEY),
    () => checkOpenRouter(env, fetchImpl));
  log(`preflight alpaca=${alpaca} openrouter=${openrouter}`);
  return alpaca === "ok" && openrouter === "ok";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!(await runPreflight())) process.exitCode = 1;
}
