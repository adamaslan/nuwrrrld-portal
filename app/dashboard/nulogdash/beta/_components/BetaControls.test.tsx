import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";

vi.mock("@/lib/nulogdash-beta-actions", () => ({
  grantBeta: vi.fn(),
  revokeBeta: vi.fn(),
}));

import { GrantForm, RevokeButton } from "./BetaControls";

describe("GrantForm", () => {
  it("disables granting when the admin has no second factor", () => {
    render(<GrantForm canMutate={false} />);
    expect(screen.getByRole("button", { name: /grant pro/i })).toBeDisabled();
  });

  it("enables granting for an MFA'd admin", () => {
    render(<GrantForm canMutate />);
    expect(screen.getByRole("button", { name: /grant pro/i })).toBeEnabled();
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
