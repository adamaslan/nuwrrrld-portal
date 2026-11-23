import {it,expect} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
it('counts only accepted responses in accepted-response coverage, offline synthetic report',()=>{
 const root=mkdtempSync(join(tmpdir(),'nld-coverage-'));
 try{
  mkdirSync(join(root,'.nulogdash'));
  const run={runId:'synthetic',runAt:'2026-11-22T20:00:00Z',gitSha:'fixture',branch:'fixture',baseUrl:'https://example.invalid',tiers:['api'],syntheticFixture:true,excluded:[],driftWarnings:[],results:['pass','fail','blocked','not_run'].map((status,i)=>({feature:'fixture-'+i,label:'Synthetic '+i,status,reason:null,entrypoints:[],dependencies:[],tier:'api',latencyMs:null}))};
  writeFileSync(join(root,'.nulogdash/latest.json'),JSON.stringify(run));
  const result=spawnSync(process.execPath,[resolve('scripts/nulogdash-report.mjs')],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH}});
  expect(result.status).toBe(0);
  const dir=join(root,'docs/nulogdash-runs');
  const html=readFileSync(join(dir,readdirSync(dir).find(f=>f.endsWith('.html'))!),'utf8');
  expect(html).toContain('<b>1 of 4</b> endpoint probes returned an accepted response');
  expect(html).toContain('>25%</div>');
 }finally{rmSync(root,{recursive:true,force:true});}
});
