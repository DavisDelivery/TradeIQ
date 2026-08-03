#!/usr/bin/env python3
"""Render out/signals.json (+ optional backtest.json, tickets.json) into a
single self-contained dashboard.html."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"


def load(name, default=None):
    p = OUT / name
    return json.loads(p.read_text()) if p.exists() else default


def main():
    sig = load("signals.json")
    if not sig:
        raise SystemExit("run `python3 -m tradeiq.pipeline` first")
    bt = load("backtest.json")
    tk = load("tickets.json")
    html = TEMPLATE.replace("__SIGNALS__", json.dumps(sig)) \
                   .replace("__BACKTEST__", json.dumps(bt)) \
                   .replace("__TICKETS__", json.dumps(tk))
    (OUT / "dashboard.html").write_text(html)
    print(f"wrote {OUT / 'dashboard.html'}  ({len(html)//1024} KB)")


TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trade IQ — social arbitrage scanner</title>
<style>
:root{color-scheme:light dark}
.viz-root{
  --surface-1:#fcfcfb; --plane:#f9f9f7;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a;
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --seq100:#cde2fb; --seq250:#86b6ef; --seq450:#2a78d6; --seq600:#184f95;
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme=light])) .viz-root{
  --surface-1:#1a1a19; --plane:#0d0d0d;
  --text-primary:#fff; --text-secondary:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --s1:#3987e5; --s2:#d95926; --s3:#199e70;
}}
:root[data-theme=dark] .viz-root{
  --surface-1:#1a1a19; --plane:#0d0d0d;
  --text-primary:#fff; --text-secondary:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --s1:#3987e5; --s2:#d95926; --s3:#199e70;
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--text-primary);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 18px 64px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;margin-bottom:4px}
h1{font-size:26px;margin:0;letter-spacing:-.02em}
h2{font-size:16px;margin:34px 0 10px;letter-spacing:-.01em}
.sub{color:var(--text-secondary);font-size:13px}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.tile .k{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.tile .v{font-size:28px;font-weight:650;letter-spacing:-.02em;margin-top:4px}
.tile .d{font-size:12px;color:var(--text-secondary);margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;
  text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;border-bottom:1px solid var(--grid);white-space:nowrap;cursor:pointer}
td{padding:9px 10px;border-bottom:1px solid var(--grid);vertical-align:middle}
tr:last-child td{border-bottom:none}
.tk{font-weight:650}
.co{color:var(--text-secondary);font-size:12px}
.bar{position:relative;height:8px;border-radius:4px;background:var(--grid);min-width:70px}
.bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:4px;display:block}
.num{font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;
  padding:3px 8px;border-radius:999px;border:1px solid var(--border);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.pos{color:var(--good)} .neg{color:var(--critical)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--text-secondary);margin:8px 0 12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
svg{display:block;width:100%;height:auto;overflow:visible}
.tip{position:fixed;pointer-events:none;background:var(--surface-1);border:1px solid var(--border);
  border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.14);
  opacity:0;transition:opacity .1s;max-width:280px;z-index:9}
.note{font-size:12.5px;color:var(--text-secondary);margin-top:8px}
button.tog{font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;
  border:1px solid var(--border);background:var(--surface-1);color:var(--text-primary);cursor:pointer}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.scroll{overflow-x:auto}
.warn{border-left:3px solid var(--warning);padding:10px 14px;background:var(--surface-1);
  border-radius:0 8px 8px 0;font-size:13px;color:var(--text-secondary);margin-top:14px}
</style></head>
<body class="viz-root"><div class="wrap">

<header>
  <h1>Trade&nbsp;IQ</h1>
  <span class="sub" id="meta"></span>
  <span style="flex:1"></span>
  <button class="tog" onclick="tog()">Toggle theme</button>
</header>
<div class="sub">Social-arbitrage scanner — consumer attention accelerating, market attention not yet.</div>

<div class="tiles" id="tiles"></div>

<h2>The edge quadrant</h2>
<div class="legend">
  <span><i class="dot" style="background:var(--good)"></i>▲ Early — candidate entry</span>
  <span><i class="dot" style="background:var(--warning)"></i>◆ Building</span>
  <span><i class="dot" style="background:var(--muted)"></i>● Neutral</span>
  <span><i class="dot" style="background:var(--serious)"></i>⚠ Event risk — just repriced on news</span>
  <span><i class="dot" style="background:var(--critical)"></i>✕ Crowded / decaying</span>
</div>
<div class="card"><div id="quad"></div>
<div class="note">Horizontal: consumer-attention velocity (z of the last 4 weeks vs its own 26-week baseline).
Vertical: investor saturation — how far the market has already responded.
The bottom-right is the trade the strategy is looking for. Marker size is the composite score.</div></div>

<h2>Ranked signals</h2>
<div class="row"><button class="tog" onclick="setF('all')">All</button>
<button class="tog" onclick="setF('act')">Actionable only</button>
<span class="sub" id="cnt"></span></div>
<div class="card scroll"><table id="tbl"><thead><tr>
<th data-k="ticker">Name</th><th data-k="sas">SAS</th><th data-k="saturation">Saturation</th>
<th data-k="convergence">Conv.</th><th data-k="consumer_z">Consumer z</th><th data-k="investor_z">Investor z</th>
<th data-k="ret_1m">1&nbsp;mo</th><th data-k="price">Price</th><th data-k="action">Read</th>
</tr></thead><tbody></tbody></table></div>

<div id="btsec"></div>
<div id="tksec"></div>

<div class="warn"><b>Not investment advice.</b> Trade IQ measures attention, not value. A signal is a
research prompt — the strategy still needs you to work out <i>why</i> a trend is happening and whether
the listed company actually monetises it. Position sizing here assumes you can lose the full risk budget.</div>

</div><div class="tip" id="tip"></div>
<script>
const SIG=__SIGNALS__, BT=__BACKTEST__, TK=__TICKETS__;
const $=s=>document.querySelector(s), tip=$("#tip");
function tog(){const r=document.documentElement;
  r.dataset.theme=(r.dataset.theme==="dark")?"light":"dark"; draw();}
function show(e,h){tip.innerHTML=h;tip.style.opacity=1;
  tip.style.left=Math.min(e.clientX+14,innerWidth-292)+"px";
  tip.style.top=Math.max(8,e.clientY-12)+"px";}
function hide(){tip.style.opacity=0}
const fmt=(v,d=1)=>v==null?"—":(+v).toFixed(d);

/* ---- meta + tiles ---- */
$("#meta").textContent = `run ${SIG.run_date} · ${SIG.rows.length} themes · equity $${SIG.equity.toLocaleString()}`;
const early=SIG.rows.filter(r=>r.action.startsWith("EARLY"));
const feeds=Object.entries(SIG.paid_feeds).filter(([,v])=>v).map(([k])=>k);
const avg=SIG.rows.reduce((a,r)=>a+r.sas,0)/SIG.rows.length;
$("#tiles").innerHTML=[
 ["Early candidates",early.length,early.map(r=>r.ticker).join(" ")||"none today"],
 ["Median score",fmt(SIG.rows.map(r=>r.sas).sort((a,b)=>a-b)[Math.floor(SIG.rows.length/2)]),`mean ${fmt(avg)}`],
 ["Undiscovered",SIG.rows.filter(r=>r.saturation<45).length,"saturation under 45"],
 ["Paid feeds live",feeds.length+" / 4",feeds.join(", ")||"free sources only"],
].map(([k,v,d])=>`<div class="card tile"><div class="k">${k}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`).join("");

/* ---- quadrant scatter ---- */
function colorFor(a){return a.startsWith("EARLY")?"var(--good)":a.startsWith("BUILDING")?"var(--warning)"
  :a.startsWith("EVENT")?"var(--serious)"
  :(a.startsWith("CROWDED")||a.startsWith("DECAYING"))?"var(--critical)":"var(--muted)";}
function markFor(a){return a.startsWith("EARLY")?"▲":a.startsWith("BUILDING")?"◆"
  :a.startsWith("EVENT")?"⚠"
  :(a.startsWith("CROWDED")||a.startsWith("DECAYING"))?"✕":"●";}
function drawQuad(){
  const W=900,H=420,m={l:52,r:18,t:14,b:44};
  const xs=SIG.rows.map(r=>r.consumer_z);
  const x0=Math.min(-1.5,Math.min(...xs)-.3), x1=Math.max(2.5,Math.max(...xs)+.3);
  const X=v=>m.l+(v-x0)/(x1-x0)*(W-m.l-m.r), Y=v=>m.t+(v/100)*(H-m.t-m.b);
  let g="";
  for(let v=0;v<=100;v+=25) g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>
    <text x="${m.l-8}" y="${Y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`;
  for(let v=Math.ceil(x0);v<=x1;v++) g+=`<line y1="${m.t}" y2="${H-m.b}" x1="${X(v)}" x2="${X(v)}" stroke="var(--grid)" stroke-width="1"/>
    <text y="${H-m.b+16}" x="${X(v)}" text-anchor="middle" font-size="11" fill="var(--muted)">${v}</text>`;
  g+=`<rect x="${X(1)}" y="${Y(0)}" width="${W-m.r-X(1)}" height="${Y(45)-Y(0)}" fill="var(--good)" opacity=".07"/>`;
  g+=`<text x="${X(1)+8}" y="${Y(45)-8}" font-size="11" fill="var(--text-secondary)">edge zone</text>`;
  g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${H-m.b}" y2="${H-m.b}" stroke="var(--axis)" stroke-width="1"/>`;
  const pts=[...SIG.rows].sort((a,b)=>a.sas-b.sas);
  pts.forEach(r=>{
    const R=5+Math.max(0,(r.sas-30))/12, c=colorFor(r.action);
    g+=`<circle cx="${X(r.consumer_z)}" cy="${Y(r.saturation)}" r="${R}" fill="${c}" fill-opacity=".85"
      stroke="var(--surface-1)" stroke-width="2" data-i="${SIG.rows.indexOf(r)}" class="pt" style="cursor:pointer"/>`;
    if(r.sas>=62||r.consumer_z>=1.2)
      g+=`<text x="${X(r.consumer_z)}" y="${Y(r.saturation)-R-5}" text-anchor="middle" font-size="11"
        font-weight="600" fill="var(--text-primary)">${markFor(r.action)} ${r.ticker}</text>`;
  });
  g+=`<text x="${(W)/2}" y="${H-4}" text-anchor="middle" font-size="11.5" fill="var(--text-secondary)">consumer attention velocity (z)</text>`;
  g+=`<text transform="translate(13,${H/2}) rotate(-90)" text-anchor="middle" font-size="11.5" fill="var(--text-secondary)">investor saturation</text>`;
  $("#quad").innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Consumer velocity vs investor saturation">${g}</svg>`;
  document.querySelectorAll(".pt").forEach(el=>{
    const r=SIG.rows[+el.dataset.i];
    el.onmousemove=e=>show(e,`<b>${r.ticker}</b> — ${r.company}<br>${r.theme}<br>
      score <b>${r.sas}</b> · saturation ${r.saturation}<br>
      consumer z ${r.consumer_z} vs investor z ${r.investor_z}<br>
      ${r.convergence} of ${r.sources_used} sources converging<br><i>${r.action}</i>`);
    el.onmouseleave=hide;});
}

/* ---- table ---- */
let filt="all", sortK="sas", asc=false;
function setF(f){filt=f;drawTable()}
document.querySelectorAll("th").forEach(th=>th.onclick=()=>{
  const k=th.dataset.k; asc=(sortK===k)?!asc:false; sortK=k; drawTable();});
function drawTable(){
  let rows=SIG.rows.filter(r=>filt==="all"||r.action.startsWith("EARLY")||r.action.startsWith("BUILDING"));
  rows=[...rows].sort((a,b)=>{const x=a[sortK],y=b[sortK];
    const c=(typeof x==="string")?String(x).localeCompare(String(y)):(x??-1e9)-(y??-1e9);return asc?c:-c;});
  $("#cnt").textContent=`${rows.length} shown`;
  $("#tbl tbody").innerHTML=rows.map(r=>{
    const sat=r.saturation, satc = sat<45?"var(--good)":sat<70?"var(--warning)":"var(--critical)";
    const rm=r.ret_1m;
    return `<tr>
    <td><span class="tk">${r.ticker}</span><div class="co">${r.company} · ${r.theme}</div></td>
    <td><div class="bar" title="${r.sas}"><i style="width:${r.sas}%;background:var(--seq450)"></i></div>
        <span class="num" style="font-size:12px">${r.sas}</span></td>
    <td><div class="bar"><i style="width:${sat}%;background:${satc}"></i></div>
        <span class="num" style="font-size:12px">${sat}</span></td>
    <td class="num">${r.convergence}<span class="co">/${r.sources_used}</span></td>
    <td class="num">${fmt(r.consumer_z,2)}</td>
    <td class="num">${fmt(r.investor_z,2)}</td>
    <td class="num ${rm>0?"pos":rm<0?"neg":""}">${rm==null?"—":(rm>0?"+":"")+fmt(rm)+"%"}</td>
    <td class="num">${r.price==null?"—":"$"+fmt(r.price,2)}</td>
    <td><span class="badge" title="${r.action}"><i class="dot" style="background:${colorFor(r.action)}"></i>${markFor(r.action)} ${r.action.split(" —")[0]}</span></td>
    </tr>`;}).join("");
}

/* ---- backtest ---- */
function drawBT(){
  if(!BT){$("#btsec").innerHTML="";return}
  const H=["1w","4w","12w"], C=["var(--s1)","var(--s2)","var(--s3)"];
  const S=BT.summary, W=900, Ht=320, m={l:52,r:16,t:20,b:72};
  const vals=S.flatMap(s=>H.map(h=>s["mean_exc_"+h]));
  const lo=Math.min(0,...vals), hi=Math.max(0,...vals), pad=(hi-lo)*.15||1;
  const Y=v=>m.t+(hi+pad-v)/((hi+pad)-(lo-pad))*(Ht-m.t-m.b);
  const bw=(W-m.l-m.r)/S.length, iw=bw*0.74/H.length;
  let g="";
  for(let i=0;i<=4;i++){const v=lo-pad+i*((hi+pad)-(lo-pad))/4;
    g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/>
      <text x="${m.l-8}" y="${Y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)">${v.toFixed(1)}%</text>`;}
  g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--axis)" stroke-width="1.5"/>`;
  S.forEach((s,si)=>{
    H.forEach((h,hi2)=>{
      const v=s["mean_exc_"+h], x=m.l+si*bw+bw*0.13+hi2*iw, y=Math.min(Y(0),Y(v)), hh=Math.abs(Y(v)-Y(0));
      g+=`<rect x="${x+1}" y="${y}" width="${iw-2}" height="${Math.max(hh,1)}" rx="3" fill="${C[hi2]}"
        class="bt" data-t="<b>${s.cohort}</b><br>horizon ${h} · n=${s.n}<br>mean excess <b>${v}%</b><br>median ${s["median_exc_"+h]}% · win ${s["winrate_"+h]}%<br>t-stat ${s["t_"+h]}" style="cursor:pointer"/>`;
      g+=`<text x="${x+iw/2}" y="${v>=0?y-6:y+hh+13}" text-anchor="middle" font-size="10.5"
        fill="var(--text-secondary)" font-variant-numeric="tabular-nums">${v>0?"+":""}${v}</text>`;
    });
    const words=s.cohort.split(" "); const lines=[]; let cur="";
    words.forEach(w=>{ if((cur+" "+w).trim().length>16){lines.push(cur.trim());cur=w;} else cur+=" "+w; });
    if(cur.trim())lines.push(cur.trim());
    lines.slice(0,2).forEach((ln,li)=>{ g+=`<text x="${m.l+si*bw+bw/2}" y="${Ht-m.b+18+li*13}" text-anchor="middle" font-size="11" fill="var(--text-secondary)">${ln}</text>`;});
    g+=`<text x="${m.l+si*bw+bw/2}" y="${Ht-m.b+18+Math.min(lines.length,2)*13}" text-anchor="middle" font-size="10.5" fill="var(--muted)">n=${s.n}</text>`;
  });
  $("#btsec").innerHTML=`<h2>Does the signal pay? (out-of-sample event study)</h2>
   <div class="legend">${H.map((h,i)=>`<span><i class="dot" style="background:${C[i]}"></i>${h} forward</span>`).join("")}</div>
   <div class="card"><svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Mean excess return vs SPY by cohort">${g}</svg>
   <div class="note">Mean excess return vs SPY after a consumer-attention spike (z ≥ ${BT.z_threshold}),
   ${BT.events.length} events across ${BT.themes_tested} themes. Signal computed on trailing data only;
   entry the trading day after the signal week. Small n — read the t-stats, not the bar heights.</div></div>`;
  document.querySelectorAll(".bt").forEach(el=>{el.onmousemove=e=>show(e,el.dataset.t);el.onmouseleave=hide;});
}

/* ---- tickets ---- */
function drawTK(){
  if(!TK||!TK.tickets.length){$("#tksec").innerHTML=`<h2>Order tickets</h2>
    <div class="card"><div class="note">No positions pass the entry rules today
    (score ≥ ${TK?TK.rules.min_sas:70}, saturation ≤ ${TK?TK.rules.max_saturation:45}, ≥2 sources converging).
    Sitting out is the correct output of a filter that works.</div></div>`;return}
  $("#tksec").innerHTML=`<h2>Order tickets — awaiting your confirmation</h2>
  <div class="card scroll"><table><thead><tr><th>Name</th><th>Qty</th><th>Limit</th><th>Notional</th>
  <th>Stop</th><th>Target</th><th>Why</th></tr></thead><tbody>${TK.tickets.map(t=>`<tr>
  <td><span class="tk">${t.ticker}</span><div class="co">${t.theme}</div></td>
  <td class="num">${t.qty}</td><td class="num">$${t.limit_price}</td><td class="num">$${t.notional.toLocaleString()}</td>
  <td class="num">$${t.stop_loss}</td><td class="num">$${t.take_profit}</td>
  <td class="co" style="min-width:220px">${t.rationale}</td></tr>`).join("")}</tbody></table>
  <div class="note">Total notional $${TK.total_notional.toLocaleString()} ·
  max ${TK.rules.max_risk_pct}% equity risk per idea · ${TK.rules.stop_pct}% stop.
  Nothing is sent to a broker from this page.</div></div>`;
}

function draw(){drawQuad();drawTable();drawBT();drawTK();}
draw();
</script></body></html>"""


if __name__ == "__main__":
    main()
