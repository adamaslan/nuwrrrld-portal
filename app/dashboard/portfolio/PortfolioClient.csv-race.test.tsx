import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {PortfolioClient} from './PortfolioClient';

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async()=>{if(root)await act(()=>root!.unmount());document.body.innerHTML='';vi.unstubAllGlobals();});
it('ignores an old file read after a newer selection, including cancel and read failure',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const imports: string[][]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string,opts?:RequestInit)=>{
  if(url.includes('/import')){const body=JSON.parse(String(opts?.body));imports.push(body.tickers);return {status:200,json:async()=>({added:body.tickers,skipped:{already_present:0,unknown_symbol:0,invalid:0,crypto_unsupported:0},rejectedSample:[]})};}
  return {ok:true,json:async()=>[]};
 }));
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);
 await act(async()=>{root!.render(<PortfolioClient initialWatchlist={[]} gainers={[]} losers={[]}/>);});
 const input=host.querySelectorAll<HTMLInputElement>('input[type=file]')[1];
 const select=async(file:object|undefined)=>{Object.defineProperty(input,'files',{configurable:true,value:file?[file]:[]});await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});};
 let finish!:(value:string)=>void;
 await select({size:20,text:()=>new Promise<string>(r=>finish=r)});
 await select({size:20,text:async()=> 'Symbol\nNEW\n'});
 await act(async()=>{finish('Symbol\nOLD\n');});
 expect(imports).toEqual([['NEW']]);expect(host.textContent).toContain('Will add 1');
 await select({size:20,text:()=>new Promise<string>(r=>finish=r)});
 await select(undefined);
 await act(async()=>{finish('Symbol\nOLD\n');});
 expect(imports).toEqual([['NEW']]);expect(host.textContent).not.toContain('Will add');
 await select({size:20,text:async()=>{throw new Error('read failed');}});
 expect(host.textContent).toContain('Could not read file. Nothing was saved.');
 expect(imports).toEqual([['NEW']]);
});
