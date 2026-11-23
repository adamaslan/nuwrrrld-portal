/** Lossless browser-only review. No persistence, market lookup, deduplication or inferred values. */
export const HOLDINGS_MAX_BYTES = 1024 * 1024;
export const HOLDINGS_MAX_ROWS = 4000;
export const HOLDINGS_MAX_COLUMNS = 256;
export type HoldingField = 'account' | 'symbol' | 'description' | 'purchaseDate' | 'quantity' | 'costPerShare' | 'costBasis' | 'currentPrice' | 'marketValue' | 'unrealizedPnl' | 'unrealizedPnlPercent';
export const HOLDING_FIELDS: readonly HoldingField[] = ['account','symbol','description','purchaseDate','quantity','costPerShare','costBasis','currentPrice','marketValue','unrealizedPnl','unrealizedPnlPercent'];
const ALIASES: Record<HoldingField, readonly string[]> = {
  account:['account','account name','account number'], symbol:['symbol','ticker','security symbol'], description:['description','security description','name'],
  purchaseDate:['purchase date','acquired date','date acquired'], quantity:['quantity','shares','units'], costPerShare:['cost/share','cost per share','unit cost'],
  costBasis:['cost basis','total cost'], currentPrice:['current price','price'], marketValue:['market value','current value'],
  unrealizedPnl:['unrealized p&l','unrealized gain/loss','unrealized pnl'], unrealizedPnlPercent:['unrealized p&l %','unrealized gain/loss %','unrealized pnl %'],
};
const key = (s: string) => s.replace(/^\uFEFF/,'').trim().toLowerCase().replace(/\s+/g,' ');
export interface ReviewRow { rowNumber: number; cells: string[]; values: Partial<Record<HoldingField,string>>; kind: 'ticker'|'option'|'unresolved'; option?: {underlying:string; expiry:string; right:'C'|'P'; strike:string}; duplicateOf?:number; issues:string[] }
export interface HoldingsReview { sourceText:string; delimiter:string; headers:string[]; mapping:Partial<Record<HoldingField,number>>; rows:ReviewRow[]; issues:string[]; error:string|null }
function tokenize(text:string, delimiter:string) {
  const rows:{line:number;cells:string[]}[]=[];let cells:string[]=[],cell='',quoted=false,afterQuote=false,line=1,start=1;
  function end(){cells.push(cell);rows.push({line:start,cells});cells=[];cell='';afterQuote=false;start=line+1;}
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;afterQuote=true;}}else{cell+=c;if(c==='\n'||(c==='\r'&&text[i+1]!=='\n'))line++;}continue;}
    if(c==='"'){if(cell!=='')return {rows,error:'Unexpected quote in an unquoted field.'};quoted=true;continue;}
    if(c===delimiter){cells.push(cell);cell='';afterQuote=false;continue;}
    if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;end();line++;start=line;continue;}
    if(afterQuote)return {rows,error:'Unexpected text after a closing quote.'};
    cell+=c;
  }
  if(quoted)return {rows,error:'A quoted field is not closed. Nothing was imported.'};
  if(cell!==''||cells.length||afterQuote)end();
  return {rows,error:null};
}
function isoDate(v:string):boolean{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;
  const [y,m,d]=v.split('-').map(Number);const dt=new Date(Date.UTC(y,m-1,d));return dt.getUTCFullYear()===y&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d;
}
export function reviewHoldingsCsv(text:string, overrides?:Partial<Record<HoldingField,number|null>>, delimiterOverride?:','|'\t'|';'):HoldingsReview{
  const result:HoldingsReview={sourceText:text,delimiter:',',headers:[],mapping:{},rows:[],issues:[],error:null};
  if(new TextEncoder().encode(text).byteLength>HOLDINGS_MAX_BYTES)return {...result,error:'File too large (max 1 MB).'};
  // Detect only from a complete header row. A tie remains explicit rather than guessed.
  const candidates=([',','\t',';'] as const).map(d=>({d,p:tokenize(text.replace(/^\uFEFF/,''),d)}));
  const scores=candidates.map(x=>({ ...x, score:x.p.rows[0]?.cells.length??0})).sort((a,b)=>b.score-a.score);
  const chosen=delimiterOverride?candidates.find(x=>x.d===delimiterOverride)!:scores[0];result.delimiter=chosen.d;
  if(chosen.p.error)return {...result,error:chosen.p.error};
  const all=chosen.p.rows;if(!all.length)return {...result,error:'The file is empty.'};
  result.headers=[...all[0].cells];
  if(all.some(entry=>entry.cells.length>HOLDINGS_MAX_COLUMNS))return {...result,error:`Too many columns (limit ${HOLDINGS_MAX_COLUMNS}). Source text is retained unchanged. Export fewer columns for this review; nothing was imported.`};
  if(!delimiterOverride&&scores[0].score===scores[1].score)return {...result,error:'Delimiter is ambiguous. Select comma, tab or semicolon.'};
  if(all.length-1>HOLDINGS_MAX_ROWS)return {...result,error:'Too many rows (limit 4000).'};
  for(const field of HOLDING_FIELDS){
    const matches=result.headers.flatMap((h,i)=>ALIASES[field].includes(key(h))?[i]:[]);
    if(matches.length===1)result.mapping[field]=matches[0];
    const explicitIndex=overrides?.[field];
    const explicitValid=typeof explicitIndex==='number'&&Number.isInteger(explicitIndex)&&explicitIndex>=0&&explicitIndex<result.headers.length;
    if(matches.length>1&&!explicitValid)result.issues.push(`Multiple columns match ${field}; choose the intended column.`);
    if(overrides&&Object.prototype.hasOwnProperty.call(overrides,field)){
      const index=overrides[field];
      if(index===null||index===undefined)delete result.mapping[field];
      else if(Number.isInteger(index)&&index>=0&&index<result.headers.length)result.mapping[field]=index;
      else result.issues.push(`Invalid column selection for ${field}.`);
    }
  }
  for(const field of ['symbol','quantity'] as const)if(result.mapping[field]===undefined)result.issues.push(`Choose a ${field} column before interpreting holdings.`);
  const used=new Map<number,HoldingField>();
  for(const field of HOLDING_FIELDS){const i=result.mapping[field];if(i!==undefined){if(used.has(i))result.issues.push(`One column is mapped to both ${used.get(i)} and ${field}; review mapping.`);used.set(i,field);}}
  const seen=new Map<string,number>();
  for(const entry of all.slice(1)){
    const row:ReviewRow={rowNumber:entry.line,cells:[...entry.cells],values:{},kind:'unresolved',issues:[]};
    if(entry.cells.length!==result.headers.length)row.issues.push('Column count differs from header; original cells retained.');
    if(entry.cells.every(x=>!x.trim()))row.issues.push('Blank source row retained.');
    for(const field of HOLDING_FIELDS){const i=result.mapping[field];if(i!==undefined)row.values[field]=entry.cells[i]??'';}
    const symbol=row.values.symbol?.trim()??'';
    if(/^[A-Za-z][A-Za-z.\-]{0,9}$/.test(symbol))row.kind='ticker';
    else{
      const m=/^([A-Z]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{5})(\d{3})$/.exec(symbol);
      if(m){const expiry=`20${m[2]}-${m[3]}-${m[4]}`;if(isoDate(expiry)){row.kind='option';row.option={underlying:m[1],expiry,right:m[5] as 'C'|'P',strike:`${m[6]}.${m[7]}`};}else row.issues.push('Option-like symbol has an invalid expiry date.');}
    }
    if(row.kind==='unresolved')row.issues.push('Instrument unresolved; raw identifier retained, no underlying conversion.');
    if(row.kind==='option')row.issues.push('Option syntax recognized only; contract identity, multiplier and valuation are unverified.');
    for(const field of ['quantity','costPerShare','costBasis','currentPrice','marketValue','unrealizedPnl','unrealizedPnlPercent'] as const){
      const value=row.values[field];if(value!==undefined&&!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()))row.issues.push(`${field}: blank or ambiguous number retained as text; review locale/currency/percent notation.`);
    }
    if(row.values.purchaseDate!==undefined&&!isoDate(row.values.purchaseDate.trim()))row.issues.push('Purchase date requires review; expected unambiguous YYYY-MM-DD.');
    if(row.values.account===undefined||row.values.account.trim()==='')row.issues.push('Account not identified; do not combine with another account.');
    const signature=JSON.stringify(entry.cells);if(seen.has(signature)){row.duplicateOf=seen.get(signature);row.issues.push(`Exact duplicate of source row ${row.duplicateOf}; retained, not removed.`);}else seen.set(signature,row.rowNumber);
    result.rows.push(row);
  }
  result.issues.push('Review only. All rows and source values retained. No database, watchlist, AI or provider request. No aggregation, inferred currency, option multiplier or recalculated financial values.');
  return result;
}

/** Reject undecodable bytes rather than silently changing source identifiers or values. */
export function decodeHoldingsCsv(bytes:ArrayBuffer):string{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
