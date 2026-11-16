import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLatestReport, MAX_REPORT_BYTES } from "@/lib/nulogdash-report";
const roots: string[] = [];
function file(value?: unknown) {
 const root=mkdtempSync(join(tmpdir(),"nld-test-")); roots.push(root);
 const path=join(root,"latest.json"); if(value!==undefined) writeFileSync(path,JSON.stringify(value)); return path;
}
const row={feature:"signals",label:"Signals",entrypoints:["/signals"],tier:"api",dependencies:[],latencyMs:1,status:"pass",reason:null};
const good={runId:"r1",runAt:"2026-11-11T23:00:00Z",gitSha:"abc",branch:"main",baseUrl:"https://example.com",tiers:["api"],results:[row],excluded:[],driftWarnings:[]};
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe("bounded nulogdash report evidence",()=>{
 it("distinguishes missing from a valid empty run",()=>{expect(loadLatestReport(file())).toEqual({status:"missing"});expect(loadLatestReport(file({...good,results:[]})).status).toBe("ready");});
 it("accepts valid reports without rewriting source",()=>{expect(loadLatestReport(file(good))).toEqual({status:"ready",run:good});});
 it.each([null,[],{}, {...good,results:{}}, {...good,results:[{...row,status:"green"}]}, {...good,runAt:"not-a-date"}, {...good,results:[{...row,latencyMs:-1}]}])("rejects malformed shape",value=>{expect(loadLatestReport(file(value))).toEqual({status:"unavailable",reason:"invalid"});});
 it("does not count duplicate feature/tier rows twice",()=>{expect(loadLatestReport(file({...good,results:[row,row]})).status).toBe("unavailable");});
 it("allows separate browser and api records for a feature",()=>{expect(loadLatestReport(file({...good,results:[row,{...row,tier:"browser"}]})).status).toBe("ready");});
 it("marks malformed JSON invalid, not missing",()=>{const p=file();writeFileSync(p,"{broken");expect(loadLatestReport(p)).toEqual({status:"unavailable",reason:"invalid"});});
 it("bounds input size before parsing",()=>{const p=file();writeFileSync(p," ".repeat(MAX_REPORT_BYTES+1));expect(loadLatestReport(p)).toEqual({status:"unavailable",reason:"oversized"});});
 it("does not expose filesystem paths or errors",()=>{const p=file();mkdirSync(p);expect(loadLatestReport(p)).toEqual({status:"unavailable",reason:"read_failed"});});
});
