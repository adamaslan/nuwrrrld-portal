import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConsentBanner from "./ConsentBanner";

vi.mock("./ConsentPreferences", () => ({ default: () => null }));

let resize: ResizeObserverCallback;
const disconnect = vi.fn();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ record: null }) }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 230 } as DOMRect);
}

describe("undecided consent footer clearance", () => {
  it("reserves the actual banner height, tracks wrapping/errors and disconnects on unmount without changing consent", async () => {
    setup();
    const { container, unmount } = render(<ConsentBanner />);
    await screen.findByRole("button", { name: "Accept all" });
    await waitFor(() => expect(container.querySelector<HTMLElement>(".consent-banner-space")?.style.height).toBe("230px"));
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ height: 310 } as DOMRect);
    act(() => resize([], {} as ResizeObserver));
    expect(container.querySelector<HTMLElement>(".consent-banner-space")?.style.height).toBe("310px");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/consent");
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("removes the reserved space only after a successful existing consent action", async () => {
    setup();
    const { container } = render(<ConsentBanner />);
    const reject = await screen.findByRole("button", { name: "Reject all" });
    expect(container.querySelector(".consent-banner-space")).not.toBeNull();
    act(() => reject.click());
    await waitFor(() => expect(container.querySelector(".consent-banner")).toBeNull());
    expect(container.querySelector(".consent-banner-space")).toBeNull();
  });
});
