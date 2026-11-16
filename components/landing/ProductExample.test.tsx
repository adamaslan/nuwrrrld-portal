import {describe,it,expect} from "vitest";
import {render,screen,cleanup} from "@testing-library/react";
import ProductExample from "./ProductExample";
describe("ProductExample",()=>{
 it.each(["signals","portfolio","assistant","paper","record"] as const)("labels %s as illustrative, without numerical performance promises",kind=>{
  const {container}=render(<ProductExample kind={kind}/>);
  expect(screen.getByText("Illustrative reading guide - not live data or a recommendation")).toBeInTheDocument();
  expect(container.querySelectorAll("dl dt")).toHaveLength(3);
  expect(container.querySelectorAll("h2")).toHaveLength(1);
  cleanup();
 });
});
