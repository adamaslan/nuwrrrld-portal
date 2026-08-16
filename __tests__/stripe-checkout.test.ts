import { describe, expect, it, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
const mockCurrentUser = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => mockAuth(),
  currentUser: () => mockCurrentUser(),
}));

const mockCreate = vi.fn();

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: mockCreate } } }),
  PRICES: { monthly: "price_monthly_test", annual: "price_annual_test" },
}));

// Regression test for the 2026-07-27 production incident: a malformed
// STRIPE_SECRET_KEY caused stripe.checkout.sessions.create to throw
// (ERR_INVALID_CHAR on the Authorization header), which was unhandled and
// produced a bare 500 with no JSON body. The frontend couldn't tell that
// apart from a network failure, so it showed a generic, undiagnosable alert.
// This pins the fix: any Stripe SDK throw here must come back as a JSON
// error body the caller can actually read.
describe("POST /api/stripe/checkout", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockCurrentUser.mockReset();
    mockCreate.mockReset();
  });

  function makeRequest(body: Record<string, unknown> = { plan: "monthly" }) {
    return {
      nextUrl: { origin: "https://financial.nuwrrrld.com" },
      json: async () => body,
    } as never;
  }

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { POST } = await import("@/app/api/stripe/checkout/route");

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
  });

  it("returns 502 with a JSON error body when the Stripe SDK throws", async () => {
    mockAuth.mockResolvedValue({ userId: "user_123" });
    mockCurrentUser.mockResolvedValue({
      publicMetadata: {},
      emailAddresses: [{ emailAddress: "a@example.com" }],
    });
    mockCreate.mockRejectedValue(
      new Error('Invalid character in header content ["Authorization"]'),
    );
    const { POST } = await import("@/app/api/stripe/checkout/route");

    const res = await POST(makeRequest());
    const body = await res.json();

    // Public error contract is stable and user-safe — must never leak the
    // raw Stripe SDK diagnostic text (internal header/config details).
    expect(res.status).toBe(502);
    expect(body.error).toBe("Unable to reach the payment processor. Please try again or contact support.");
    expect(body.error).not.toContain("Invalid character in header content");
  });

  it("returns a checkout URL on success", async () => {
    mockAuth.mockResolvedValue({ userId: "user_123" });
    mockCurrentUser.mockResolvedValue({
      publicMetadata: {},
      emailAddresses: [{ emailAddress: "a@example.com" }],
    });
    mockCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session/abc" });
    const { POST } = await import("@/app/api/stripe/checkout/route");

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.com/session/abc");
  });
});
