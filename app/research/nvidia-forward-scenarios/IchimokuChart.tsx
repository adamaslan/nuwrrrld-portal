import article from "@/lib/research/nvidia-scenarios.json";

/** Spans already shifted +26 observed daily bars by the source indicator. Never shift again. */
export function IchimokuChart() {
  const data = article.chart;
  const left=48, top=24, width=640, height=280;
  const low=140, high=250;
  const x=(i:number)=>left+i*width/(data.length-1);
  const y=(v:number)=>top+height-(v-low)*height/(high-low);
  const line=(key:"close"|"tenkan"|"kijun"|"spanA"|"spanB")=>data.map((r,i)=>`${x(i)},${y(r[key])}`).join(" ");
  const cloud=data.map((r,i)=>`${x(i)},${y(r.spanA)}`).concat(data.map((r,i)=>`${x(i)},${y(r.spanB)}`).reverse()).join(" ");
  const last=data[data.length-1];
  return <figure className="nvda-chart" aria-labelledby="ichimoku-title">
    <h2 id="ichimoku-title">Price below the cloud, despite its green label</h2>
    <p>Historical daily bars · {data[0].date} to {last.date} · USD</p>
    <svg viewBox="0 0 720 354" role="img" aria-labelledby="chart-title chart-description">
      <title id="chart-title">NVIDIA daily close, Tenkan, Kijun and Ichimoku cloud through November 12, 2026</title>
      <desc id="chart-description">The last close is166.19, Tenkan179.39, Kijun192.935, cloud bottom216.69 and top229.70 dollars. Both spans are displaced26 observed bars using only earlier data. No future price is shown. Exact endpoint values are also below.</desc>
      {[150,175,200,225,250].map(v=><g key={v}><line x1={left} x2={left+width} y1={y(v)} y2={y(v)} stroke="#ddd"/><text x={left-8} y={y(v)+4} textAnchor="end" fontSize="13">{v}</text></g>)}
      <polygon points={cloud} fill="#d6e2dc" stroke="#8d9e93" strokeWidth="1"/>
      <polyline points={line("tenkan")} fill="none" stroke="#777" strokeWidth="1.8" strokeDasharray="5 3"/>
      <polyline points={line("kijun")} fill="none" stroke="#414141" strokeWidth="1.8" strokeDasharray="2 3"/>
      <polyline points={line("close")} fill="none" stroke="#111" strokeWidth="2.7"/>
      {[0,Math.floor(data.length/2),data.length-1].map(i=><text key={i} x={x(i)} y={332} textAnchor={i===0?"start":i===data.length-1?"end":"middle"} fontSize="13">{data[i].date}</text>)}
    </svg>
    <figcaption>Solid black: close. Dashed gray: Tenkan9. Dotted dark gray: Kijun26. Shaded band: SpanA/SpanB cloud, calculated with9/26/52 periods and already shifted forward26 observed daily bars. The band is shaded uniformly to show its range, not to label every historic cloud bullish. No future prices or projections are drawn.</figcaption>
    <dl className="nvda-chart-values"><div><dt>Nov12 close</dt><dd>$166.19</dd></div><div><dt>Tenkan</dt><dd>$179.39</dd></div><div><dt>Kijun</dt><dd>$192.935</dd></div><div><dt>Cloud range</dt><dd>$216.69-$229.70</dd></div></dl>
    <p className="nvda-caption">On this frozen endpoint, price is below both lines and the cloud; no new Tenkan/Kijun cross fired that day. SpanA is above SpanB, so the detector also labels the displaced cloud bullish. That color is not a reversal or buy signal. Levels change as new completed bars arrive. This chart is historical context, not a validated trading strategy or12-month forecast. Input basis and sources4-6 are below.</p>
  </figure>;
}
