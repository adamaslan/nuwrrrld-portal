import {test,expect} from 'vitest';
import assert from 'node:assert/strict';
import {reviewHoldingsCsv as review,decodeHoldingsCsv} from '../lib/holdings-csv-review';
test('lossless mixed rows and duplicates',()=>{const s='Account,Symbol,Quantity,Cost Basis,Extra\r\nA,AAPL,0.12345678901234567,100.00,keep\r\nB,XYZ   261218C00100000,2,250.00,"x,y"\r\nB,XYZ   261218C00100000,2,250.00,"x,y"\r\nA,CUSTOM_ID,1,2,raw\r\n';const r=review(s);assert.equal(r.error,null);assert.equal(r.sourceText,s);assert.equal(r.rows.length,4);assert.equal(r.rows[0].values.quantity,'0.12345678901234567');assert.equal(r.rows[1].kind,'option');assert.equal(r.rows[1].values.symbol,'XYZ   261218C00100000');assert.equal(r.rows[2].duplicateOf,3);assert.equal(r.rows[3].kind,'unresolved');assert.equal(r.rows[1].cells[4],'x,y');});
test('malformed quotes fail closed',()=>assert.equal(review('Symbol,Quantity\nA,"1').rows.length,0));
test('row cap before duplicates',()=>assert(review('Symbol,Quantity\n'+Array(4001).fill('A,1').join('\n')).error?.includes('4000')));
test('byte cap',()=>assert(review('x'.repeat(1048577)).error?.includes('1 MB')));
test('quoted multiline source line',()=>{const r=review('Account,Symbol,Quantity,Description\nA,A,1,"hello\nworld"\nB,B,2,ok');assert.equal(r.rows[0].cells[3],'hello\nworld');assert.equal(r.rows[1].rowNumber,4);});
test('semicolon mapping override',()=>{const r=review('Acct;Code;Units\nA;AAPL;3',{account:0,symbol:1});assert.equal(r.delimiter,';');assert.equal(r.rows[0].values.symbol,'AAPL');});
test('duplicate ambiguous header no silent selection',()=>{const r=review('Symbol,Ticker,Quantity\nA,B,1');assert.equal(r.mapping.symbol,undefined);assert(r.issues.some(x=>x.includes('Multiple')));});
test('invalid date not repaired',()=>{const r=review('Account,Symbol,Quantity,Purchase Date\nA,A,1,2026-02-30');assert(r.rows[0].issues.some(x=>x.includes('Purchase date')))});
test('blank rows retained',()=>assert.equal(review('Account,Symbol,Quantity\nA,A,1\n,,\nB,B,2').rows.length,3));
test('formula-looking cells inert preserved',()=>{const r=review('Account,Symbol,Quantity\nA,=EVIL(),1');assert.equal(r.rows[0].values.symbol,'=EVIL()');assert.equal(r.rows[0].kind,'unresolved')});
test('account-separated identical positions not deduped',()=>{const r=review('Account,Symbol,Quantity\nA,A,1\nB,A,1');assert(r.rows.every(x=>x.duplicateOf===undefined))});
test('unknown financial conventions retained no parseFloat',()=>{const r=review('Account,Symbol,Quantity,Cost Basis\nA,A,1,"$1,000.00"');assert.equal(r.rows[0].values.costBasis,'$1,000.00');assert(r.rows[0].issues.some(x=>x.includes('costBasis')))});

test('final quoted empty source row retained at EOF',()=>{const r=review('Symbol,Quantity\n""',undefined,',');assert.equal(r.rows.length,1);assert.deepEqual(r.rows[0].cells,['']);});

test('UTF-8 decoding rejects invalid bytes rather than replacing values',()=>{assert.throws(()=>decodeHoldingsCsv(new Uint8Array([0x53,0x79,0x6d,0x62,0x6f,0x6c,10,0x80]).buffer));assert.equal(decodeHoldingsCsv(new TextEncoder().encode('Symbol\nÉ').buffer),'Symbol\nÉ');});

test('bare CR and CRLF inside quotes preserve cells and physical source lines',()=>{for(const newline of ['\r','\r\n']){const text=['Account,Symbol,Quantity,Description','A,AAPL,1,"first'+newline+'second"','B,MSFT,2,ok','B,MSFT,2,ok'].join(newline);const r=review(text);expect(r.rows[0].cells[3]).toBe('first'+newline+'second');expect(r.rows[1].rowNumber).toBe(4);expect(r.rows[2].duplicateOf).toBe(4);}});
test('explicit valid mapping resolves ambiguity but invalid or cleared mapping does not',()=>{const text='Symbol,Ticker,Quantity\nA,B,1';expect(review(text,{symbol:0}).issues.some(x=>x.startsWith('Multiple'))).toBe(false);for(const symbol of [null,999])expect(review(text,{symbol}).issues.some(x=>x.startsWith('Multiple'))).toBe(true);});
test('excessive columns fail before row interpretation without losing source',()=>{const text=Array(50000).fill('x').join(',')+'\n'+Array(50000).fill('raw').join(',');const r=review(text);expect(r.error).toContain('limit 256');expect(r.sourceText).toBe(text);expect(r.headers.length).toBe(50000);expect(r.rows).toEqual([]);});
