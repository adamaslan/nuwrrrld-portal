import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../scripts/council-langsmith-eval.mjs", import.meta.url),
);

describe("Council LangSmith synthetic evaluation", () => {
  it("scores each fallback fixture locally without requiring LangSmith credentials", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--local"], {
      encoding: "utf8",
      env: {
        ...process.env,
        LANGSMITH_API_KEY: "",
        LANGSMITH_API_URL: "",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS empty-primary-then-answer");
    expect(result.stdout).toContain("PASS all-completions-empty");
    expect(result.stdout).toContain("PASS retired-primary-then-answer");
    expect(result.stdout).toContain("PASS provider-chain-unavailable");
    expect(result.stdout).not.toContain("FAIL");
  });
});
