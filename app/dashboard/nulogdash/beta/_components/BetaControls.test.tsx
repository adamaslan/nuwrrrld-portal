import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";

vi.mock("@/lib/nulogdash-beta-actions", () => ({
  grantBeta: vi.fn(),
  revokeBeta: vi.fn(),
  revokeBetaInvitation: vi.fn(),
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

  it("shows a private invite link only after an explicit successful submission", async () => {
    vi.mocked(grantBeta).mockResolvedValue({ ok: true, message: "Invite created", inviteUrl: "https://example.com/invite" });
    render(<GrantForm canMutate />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "tester@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to beta" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Private beta invitation link" })).toHaveAttribute("href", "https://example.com/invite"));
    expect(screen.getByText(/Anyone with this link can use it/)).toBeVisible();
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
