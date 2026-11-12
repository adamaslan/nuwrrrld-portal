import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { ReportNotice } from "./ReportNotice";
describe("ReportNotice",()=>{
 it("explains local/deployed separation without claiming no run exists",()=>{render(<ReportNotice state={{status:"missing"}}/>);expect(screen.getByRole("heading",{name:"No feature-sweep report on this server"})).toBeInTheDocument();expect(screen.getByText(/another computer does not publish/)).toBeInTheDocument();expect(screen.getByRole("link",{name:"View recorded pipeline runs"})).toHaveAttribute("href","/dashboard/nulogdash/pipelines");expect(screen.queryByRole("button")).not.toBeInTheDocument();});
 it.each(["invalid","oversized","read_failed"] as const)("shows unavailable rather than no-run for %s",reason=>{render(<ReportNotice state={{status:"unavailable",reason}}/>);expect(screen.getByRole("heading",{name:"Feature-sweep report unavailable"})).toBeInTheDocument();expect(screen.queryByText("No run yet.")).not.toBeInTheDocument();});
 it("has no accessibility violations",async()=>{const{container}=render(<ReportNotice state={{status:"missing"}}/>);expect(await axe(container)).toHaveNoViolations();});
});
