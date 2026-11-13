import { describe, expect, it } from "vitest";
import {render,screen} from "@testing-library/react";
import TwoAudiences from "./TwoAudiences";

describe("TwoAudiences editorial layout",()=>{
 it("preserves both audience texts without inline presentation or fixed minimum widths",()=>{
  const {container}=render(<TwoAudiences title="Two paths" beginner={{heading:"Learn",paragraphs:["Beginner explanation.","Beginner limit."]}} trader={{heading:"Investigate",paragraphs:["Trader explanation."]}}/>);
  expect(screen.getByRole("heading",{name:"Two paths"})).toBeInTheDocument();
  expect(screen.getByRole("heading",{name:"New to markets?"})).toBeInTheDocument();
  expect(screen.getByRole("heading",{name:"Trade actively?"})).toBeInTheDocument();
  expect(screen.getByRole("heading",{name:"Learn"})).toBeInTheDocument();
  expect(screen.getByRole("heading",{name:"Investigate"})).toBeInTheDocument();
  expect(screen.getByText("Beginner explanation.")).toBeInTheDocument();
  expect(screen.getByText("Trader explanation.")).toBeInTheDocument();
  expect(screen.getByText("Beginner limit.")).toHaveClass("audience-detail");
  expect(container.querySelectorAll("[style]")).toHaveLength(0);
  expect(container.querySelectorAll(".audience-path")).toHaveLength(2);
 });
});
