import { describe, expect, it } from "vitest";
import { classifyBudgetCliFailure } from "../lib/alpaca-budget.mjs";

describe("Alpaca shared budget CLI diagnostics", () => {
  it.each([
    [{ code: "ENOENT" }, "aws_cli_missing"],
    [{ stderr: "Unable to locate credentials" }, "credentials_missing"],
    [{ stderr: "ExpiredToken: secret-shaped detail" }, "credentials_invalid"],
    [{ stderr: "AccessDeniedException: detail" }, "access_denied"],
    [{ stderr: "ResourceNotFoundException: detail" }, "table_missing"],
    [{ stderr: "ThrottlingException: detail" }, "dynamodb_throttled"],
    [{ stderr: "Could not connect to the endpoint URL" }, "network_unavailable"],
    [{ code: "ETIMEDOUT" }, "request_timeout"],
    [{ stderr: "ConditionalCheckFailedException" }, "capacity_exhausted"],
    [{ stderr: "unrecognized secret-shaped detail" }, "unknown"],
  ])("classifies failures without exposing details", (failure, expected) => {
    expect(classifyBudgetCliFailure(failure)).toBe(expected);
    expect(classifyBudgetCliFailure(failure)).not.toContain("secret-shaped");
  });
});
