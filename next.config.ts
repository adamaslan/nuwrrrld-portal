import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  // The canonical replay seed is read at runtime; it is not reachable via
  // static import tracing, so include it explicitly for standalone output.
  outputFileTracingIncludes: {
    "/api/research/historical-replay": ["./lib/replay/universe_symbols.csv"],
    // The owner-only SSR page calls the same loader (and reads the same seed)
    // per request, so it needs its own tracing entry.
    "/dashboard/research/historical-replay": ["./lib/replay/universe_symbols.csv"],
  },
  async headers() {
    return [
      {
        // Apple requires application/json for AASA (the file has no extension,
        // so Next would otherwise serve it as octet-stream).
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
    ];
  },
};

export default nextConfig;
