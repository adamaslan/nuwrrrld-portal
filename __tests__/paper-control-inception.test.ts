import { describe,it,expect } from "vitest";
import { planControlInception, controlTickers, CONTROL_CORE_50 } from "@/lib/shared/paper-control-core";
import { fillOrders } from "@/lib/shared/paper-engine-core";
import { CORE_50 } from "../scripts/seed-paper-portfolios.mjs";
describe("fixed control inception",()=>{
 it("freezes exactly the seeder Core50, not today's ranked universe",()=>expect([...CONTROL_CORE_50]).toEqual(CORE_50));
 for(const account of ["equal","spy"] as const){
  const tickers=controlTickers(account),watch=new Set(tickers),prices=new Map(tickers.map(t=>[t,137.91]));
  it(`${account} buys the entire fixed book once, fractional6dp and within cash including normal slippage`,()=>{
   const p=planControlInception(account,10000,10000,0,0,watch,prices);expect(p.ok).toBe(true);if(!p.ok)return;
   expect(p.orders).toHaveLength(tickers.length);expect(p.orders.every(o=>o.reason==="control_seed"&&o.quantity>0)).toBe(true);
   const fills=fillOrders(p.orders,new Map());expect(fills.reduce((s,f)=>s+f.notional,0)).toBeLessThanOrEqual(10000);
   for(const f of fills)expect(f.notional).toBeCloseTo(10000/tickers.length,2);
  });
  it(`${account} never rebalances or refills a held book`,()=>expect(planControlInception(account,1,10000,1,4,watch,prices)).toEqual({ok:true,orders:[]}));
  it(`${account} refuses partial price data, changed watchlist, nonpristine cash or previous orders`,()=>{
   const bad=new Map(prices);bad.delete(tickers[0]);expect(planControlInception(account,10000,10000,0,0,watch,bad).ok).toBe(false);
   for(const price of [0,-2,NaN,Infinity]){const b=new Map(prices);b.set(tickers[0],price);expect(planControlInception(account,10000,10000,0,0,watch,b).ok).toBe(false);}
   expect(planControlInception(account,10000,10000,0,0,new Set([...watch,"FAKE"]),prices).ok).toBe(false);
   expect(planControlInception(account,9999,10000,0,0,watch,prices).ok).toBe(false);
   expect(planControlInception(account,10000,10000,0,1,watch,prices).ok).toBe(false);
  });
 }
});

import { buildArenaView, type ArenaAccountInput } from "@/lib/shared/paper-arena-view";
import type { NavPoint } from "@/lib/paper-db";
const nav=(account:"spy"|"equal",positionsN=0):NavPoint=>({account,tradeDate:"2026-11-10",slot:"settle",nav:10000,cash:10000,positionsMv:0,dayReturn:0,totalReturn:0,positionsN,turnover:0});
function arenaInput(account:"spy"|"equal",positionsN=0):ArenaAccountInput{return {account,seat:null,label:account,cash:10000,metrics:null,nav:[nav(account,positionsN)],latestNav:nav(account,positionsN),positions:[],orders:[]};}
it("cash-only controls are visibly pending, not0% benchmarks or flat invested curves",()=>{
 const vm=buildArenaView([arenaInput("spy"),arenaInput("equal")]);
 for(const r of vm.rows){expect(r.nav).toBe(10000);expect(r.baselineStatus).toBe("awaiting_inception");expect(r.totalReturnPct).toBeNull();expect(r.dayReturnPct).toBeNull();expect(r.activeReturnVsEqualPct).toBeNull();expect(r.activeReturnVsSpyPct).toBeNull();}
 expect(vm.curves.spy).toEqual([]);expect(vm.curves.equal).toEqual([]);
});
it("a real invested zero return remains0, not unknown",()=>{const r=buildArenaView([arenaInput("spy",1)]).rows[0];expect(r.totalReturnPct).toBe(0);expect(r.baselineStatus).toBe("invested");});
