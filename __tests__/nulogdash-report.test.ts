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
 it("accepts valid legacy reports and marks their quality as unrecorded",()=>{const loaded=loadLatestReport(file(good));expect(loaded.status).toBe("ready");if(loaded.status==="ready")expect(loaded.run.qualityEvaluation?.displayReason).toMatch(/quality not recorded/i);});
 it("preserves the versioned quality artifact through the bounded reader",()=>{const artifact={schemaVersion:"nulogdash-quality/v1",source:{name:"fixture",version:"v1",runId:"r1",evaluatorVersion:"e1"},cutoffAt:"2026-11-20T00:00:00Z",evidenceScope:"Synthetic fixture.",workload:{eligible:1,attempted:1,useful:1,skipped:0,deferred:0,errors:0,items:[{id:"one",status:"useful"}]},metrics:[{id:"zero",label:"Zero",observed:0,eligibleDenominator:1,measuredDenominator:1,target:{operator:">=",value:0,rationale:"Synthetic target."}}]};const loaded=loadLatestReport(file({...good,artifactVersion:"nulogdash-run/v2",transportOutcome:{pass:1,fail:0,blocked:0,not_run:0},qualityEvaluation:artifact}));expect(loaded.status).toBe("ready");if(loaded.status==="ready"){expect(loaded.run.artifactVersion).toBe("nulogdash-run/v2");expect(loaded.run.transportOutcome?.pass).toBe(1);expect(loaded.run.qualityEvaluation?.metrics[0].observed).toBe(0);expect(loaded.run.qualityEvaluation?.metrics[0].verdict).toBe("meets_target");}});
 it.each([null,[],{}, {...good,results:{}}, {...good,results:[{...row,status:"green"}]}, {...good,runAt:"not-a-date"}, {...good,results:[{...row,latencyMs:-1}]}])("rejects malformed shape",value=>{expect(loadLatestReport(file(value))).toEqual({status:"unavailable",reason:"invalid"});});
 it("does not count duplicate feature/tier rows twice",()=>{expect(loadLatestReport(file({...good,results:[row,row]})).status).toBe("unavailable");});
 it("allows separate browser and api records for a feature",()=>{expect(loadLatestReport(file({...good,results:[row,{...row,tier:"browser"}]})).status).toBe("ready");});
 it("marks malformed JSON invalid, not missing",()=>{const p=file();writeFileSync(p,"{broken");expect(loadLatestReport(p)).toEqual({status:"unavailable",reason:"invalid"});});
 it("bounds input size before parsing",()=>{const p=file();writeFileSync(p," ".repeat(MAX_REPORT_BYTES+1));expect(loadLatestReport(p)).toEqual({status:"unavailable",reason:"oversized"});});
 it("does not expose filesystem paths or errors",()=>{const p=file();mkdirSync(p);expect(loadLatestReport(p)).toEqual({status:"unavailable",reason:"read_failed"});});
});
