import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";

vi.mock("@/lib/nulogdash-beta-actions", () => ({
  grantBeta: vi.fn(),
  revokeBeta: vi.fn(),
  revokePendingBeta: vi.fn(),
}));

import { grantBeta } from "@/lib/nulogdash-beta-actions";
import { GrantForm, RevokeButton } from "./BetaControls";

describe("GrantForm", () => {
  it("disables granting when the admin has no second factor", () => {
    render(<GrantForm canMutate={false} />);
    expect(screen.getByRole("button", { name: /add to beta/i })).toBeDisabled();
  });

  it("enables granting for an MFA'd admin", () => {
    render(<GrantForm canMutate />);
    expect(screen.getByRole("button", { name: /add to beta/i })).toBeEnabled();
  });

  it("keeps optional fields collapsed and submits only the email by default", async () => {
    vi.mocked(grantBeta).mockResolvedValue({ ok: true, message: "Added" });
    render(<GrantForm canMutate />);
    expect(screen.getByText("Optional expiry and note").closest("details")).not.toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "tester@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to beta" }));
    await waitFor(() => expect(grantBeta).toHaveBeenCalledWith({ email: "tester@example.com", expiresAt: "", note: "" }));
  });

  it("shows a normal signup link only after an explicit successful submission", async () => {
    vi.mocked(grantBeta).mockResolvedValue({ ok: true, message: "Email added", signupUrl: "/sign-up?redirect_url=/dashboard" });
    render(<GrantForm canMutate />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "tester@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to beta" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Signup link (no access token)" })).toHaveAttribute("href", "/sign-up?redirect_url=/dashboard"));
    expect(screen.getByText(/Beta requires a verified primary email/)).toBeVisible();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<GrantForm canMutate />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("RevokeButton", () => {
  it("is disabled without MFA", () => {
    render(<RevokeButton userId="user_abc" canMutate={false} />);
    expect(screen.getByRole("button", { name: /revoke/i })).toBeDisabled();
  });
});
