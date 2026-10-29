import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HealthBanner } from "./HealthBanner";

describe("HealthBanner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names stale signal cards when they are the only degraded dependency", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        status: "degraded",
        mcp: { status: "ok" },
        neon: { status: "ok" },
        cards: { status: "degraded" },
        stripe: { status: "ok" },
        openrouter: { status: "ok" },
        clerk: { status: "ok" },
      }),
    }));

    render(<HealthBanner />);

    expect(await screen.findByTestId("health-banner")).toHaveTextContent("signal cards");
  });
});
