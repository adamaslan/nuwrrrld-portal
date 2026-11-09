import { describe, expect, it } from "vitest";
import { GET } from "@/app/llms.txt/route";

describe("GET /llms.txt (I1)", () => {
  it("serves plain text that is honest about status and advertises no API or key", async () => {
    const res = GET();
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("of 200 planned scan cards are written");
    expect(body).toContain("There is no public API or MCP endpoint yet");
    expect(body).toContain("/scans/gaps");
    expect(body).not.toMatch(/api[_-]?key|bearer/i);
  });
});
