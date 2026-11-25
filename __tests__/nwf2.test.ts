import { describe, expect, it } from "vitest";
import { NWF2_MESSAGE, nwf2Withheld } from "@/lib/nwf2";

describe("NWF 2.0 withheld surfaces", () => {
  it("uses Adam's wording", () => {
    expect(NWF2_MESSAGE).toBe("See these features in NWF 2.0");
  });

  it("withholds followed tickers and paper portfolios only", () => {
    expect(nwf2Withheld("followed-tickers")).toBe(true);
    expect(nwf2Withheld("paper-portfolios")).toBe(true);
  });
});
