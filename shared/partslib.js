/* Shared parts library client for the MX design tools (Buck Designer, Buck Compensation).
   Parts live on the server (Cloudflare Worker + KV) so everyone sees the same data. This file keeps a local
   copy for offline use, queues saves made while the server is unreachable, and converts capacitor records
   between the two tools. Load it before the tool's own script:  a script tag pointing at ../shared/partslib.js */
(function(root){
"use strict";
const API=root.PARTSLIB_API||"https://mouser.mail-manu-mx.workers.dev";
const CK="mx.partslib.cache.v1",PK="mx.partslib.pending.v1",BYK="mx.partslib.by",ADK="mx.partslib.adopted.v1";
const TYPES=["cap","ctrl","conv","fet","ind"];
const ls={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
const jparse=(s,d)=>{try{const j=JSON.parse(s);return j==null?d:j}catch(e){return d}};

let cache=jparse(ls.get(CK),{}),pending=jparse(ls.get(PK),[]),state="idle",listeners=[];
if(!cache||typeof cache!=="object"||Array.isArray(cache))cache={};
if(!Array.isArray(pending))pending=[];
const persistCache=()=>ls.set(CK,JSON.stringify(cache)),persistPending=()=>ls.set(PK,JSON.stringify(pending));
const up=s=>String(s||"").toUpperCase();

function setCache(type,entry){const a=(cache[type]||[]).filter(x=>up(x.pn)!==up(entry.pn));a.push(entry);a.sort((x,y)=>x.pn.localeCompare(y.pn));cache[type]=a;persistCache()}
function dropCache(type,pn){cache[type]=(cache[type]||[]).filter(x=>up(x.pn)!==up(pn));persistCache()}

/* all parts of every type: the server copy, with anything still waiting to be saved laid over it */
function all(){
  const out={};TYPES.forEach(t=>out[t]=(cache[t]||[]).map(x=>x));
  for(const p of pending){
    const a=out[p.type]=out[p.type]||[];const i=a.findIndex(x=>up(x.pn)===up(p.entry.pn));
    if(i>=0)a[i]=Object.assign({},a[i],p.entry,{vals:Object.assign({},a[i].vals,p.entry.vals)});else a.push(p.entry);
  }
  TYPES.forEach(t=>out[t].sort((x,y)=>x.pn.localeCompare(y.pn)));
  return out;
}
const get=t=>all()[t]||[];
function status(){const a=all();return {state,count:TYPES.reduce((s,t)=>s+a[t].length,0),pending:pending.length}}
function emit(){listeners.forEach(f=>{try{f(status())}catch(e){}})}
function onChange(f){listeners.push(f)}

async function req(method,path,body){
  const res=await fetch(API+path,{method,headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});
  const j=await res.json().catch(()=>({}));
  if(!res.ok){const e=new Error(j.error||("Library returned "+res.status));e.status=res.status;throw e}
  return j;
}

/* quiet:true is a background refresh: no "loading" flicker, and listeners only hear about it if something changed */
let lastPull=0,pulling=null,live=false;
function pull(opts){
  if(pulling)return pulling;
  const quiet=!!(opts&&opts.quiet),before=quiet?snap():null;
  live=true;lastPull=Date.now();
  if(!quiet){state="loading";emit()}
  pulling=(async()=>{
    try{const j=await req("GET","/lib");cache=j.types||{};persistCache();state="ok";await flush()}
    catch(e){state=e.status===503?"nosetup":"offline"}
    pulling=null;
    if(!quiet||snap()!==before)emit();
    return all();
  })();
  return pulling;
}
const snap=()=>state+"|"+JSON.stringify(all());

/* ---------- live updates ----------
   Another tab in this browser (e.g. the parts library page) changed the library: its localStorage write fires a
   storage event here, so pick up the new copy straight away. Changes made on other devices arrive by re-asking the
   server when the tab comes back into view, and every few minutes while it is open. The server lists the library
   with a KV list call (1,000 a day on the free plan), so these refreshes are spaced out on purpose. */
const POLL_MS=3*60*1000,MIN_GAP_MS=20*1000;
function reloadLocal(){
  const before=snap();
  const c=jparse(ls.get(CK),{}),p=jparse(ls.get(PK),[]);
  cache=c&&typeof c==="object"&&!Array.isArray(c)?c:{};pending=Array.isArray(p)?p:[];
  if(snap()!==before)emit();
}
function refresh(){
  const doc=root.document;
  if(!live||(doc&&doc.hidden)||Date.now()-lastPull<MIN_GAP_MS)return;
  pull({quiet:true});
}
if(typeof root.addEventListener==="function"){
  root.addEventListener("storage",e=>{if(e.key===CK||e.key===PK)reloadLocal()});
  root.addEventListener("focus",refresh);
  if(root.document)root.document.addEventListener("visibilitychange",refresh);
  setInterval(refresh,POLL_MS);
}
/* send queued saves; stop at the first network failure, drop ones the server rejects as invalid */
async function flush(){
  for(const p of pending.slice()){
    try{const r=await req("PUT","/lib/part",{type:p.type,pn:p.entry.pn,entry:p.entry,by:p.by});setCache(p.type,r);pending=pending.filter(x=>x!==p)}
    catch(e){if(e.status===400){pending=pending.filter(x=>x!==p)}else break}
  }
  persistPending();
}
async function save(type,entry,by){
  by=by||getBy();
  try{const r=await req("PUT","/lib/part",{type,pn:entry.pn,entry,by});setCache(type,r);state="ok";emit();return {shared:true,entry:r}}
  catch(e){
    if(e.status===400||e.status===403||e.status===413)throw e;               /* the server refused this entry */
    pending=pending.filter(p=>!(p.type===type&&up(p.entry.pn)===up(entry.pn)));
    pending.push({type,entry,by});persistPending();state=e.status===503?"nosetup":"offline";emit();
    return {shared:false,entry};
  }
}
async function remove(type,pn){await req("DELETE",`/lib/part?type=${encodeURIComponent(type)}&pn=${encodeURIComponent(pn)}`);dropCache(type,pn);emit()}
async function history(type,pn){return (await req("GET",`/lib/history?type=${encodeURIComponent(type)}&pn=${encodeURIComponent(pn)}`)).history}

/* ---------- Mouser lookup: the worker only answers when it gets the owner's password ---------- */
const LKK="mx.lookupkey";
const getKey=()=>ls.get(LKK)||"",setKey=v=>ls.set(LKK,String(v||""));
const mouserReq=(path,key)=>fetch(API+path,{headers:{"X-Lookup-Key":key}});
async function mouserFetch(pn){
  const path="/part?pn="+encodeURIComponent(pn);
  let res=await mouserReq(path,getKey());
  if(res.status===401&&typeof root.prompt==="function"){
    const k=root.prompt(getKey()?"That password was not accepted. Enter the Mouser lookup password:":"Mouser lookups are password protected. Enter the lookup password:");
    if(k){res=await mouserReq(path,k);if(res.ok)setKey(k)}
  }
  return res;
}
/* Google search link: asks for ONE comma-separated line in a fixed field order, so the answer can be pasted into the
   parts library page. Values from an AI answer stay unverified until checked against the datasheet. */
const FIELDS={
 cap:[["subtype","technology: mlcc, poly, tant, alu or film"],["c","capacitance in µF"],["esr","ESR in mΩ"],["esl","ESL in nH"],["vr","rated voltage in V"],["irmsC","rated ripple current in A rms"],["tol","tolerance in ± %"],["df","loss tangent tanδ as a fraction, e.g. 0.025"],["fs","frequency in kHz at which the ESR is specified"]],
 fet:[["vds","Vds in V"],["id","continuous Id in A"],["rds","maximum Rds(on) at 25 °C in mΩ"],["qg","total gate charge in nC"],["qgs","Qgs in nC"],["qgd","Qgd in nC"],["vpl","Miller plateau in V"],["coss","Coss in pF"],["qrr","Qrr in nC"],["vf","body diode Vf in V"],["rth","RθJA in °C/W"],["tjmax","max junction temperature in °C"]],
 ind:[["L","inductance in µH"],["ltol","tolerance in ± %"],["isat","saturation current in A"],["irms","rated RMS current in A"],["dcr","maximum DCR in mΩ"],["dTr","temperature rise at rated current in °C"]],
 ctrl:[["vinMaxIc","maximum input voltage in V"],["fswMax","maximum switching frequency in kHz"],["tonMin","minimum on-time in ns"],["ilim","current limit in A"],["vref","reference voltage in V"],["vrefTol","reference tolerance in ± %"],["eaGbw","error amplifier gain-bandwidth in MHz"],["vdrv","gate drive voltage in V"],["iq","quiescent current in mA"],["iss","soft-start current in µA"],["eaGm","error amplifier transconductance gm in µS (empty if it is a voltage op-amp)"],["eaAol","error amplifier DC open-loop gain in dB"],["vramp","PWM ramp peak-peak amplitude in V (voltage mode)"],["ri","current-sense gain Ri in V/A, i.e. sense resistance times current-sense amplifier gain (current mode)"],["se","internal slope compensation as an equivalent inductor-current slope in A/µs"],["eaVos","error amplifier input offset in mV"]],
 conv:[["vinMaxIc","maximum input voltage in V"],["ioutMaxIc","rated output current in A"],["rdsHs","high-side Rds(on) in mΩ"],["rdsLs","low-side Rds(on) in mΩ"],["fswMax","maximum switching frequency in kHz"],["ilim","current limit in A"],["vref","reference voltage in V"],["iq","quiescent current in mA"],["rthIc","RθJA in °C/W"],["eaGm","error amplifier transconductance gm in µS (empty if it is a voltage op-amp)"],["eaAol","error amplifier DC open-loop gain in dB"],["vramp","PWM ramp peak-peak amplitude in V (voltage mode)"],["ri","current-sense gain Ri in V/A, i.e. sense resistance times current-sense amplifier gain (current mode)"],["se","internal slope compensation as an equivalent inductor-current slope in A/µs"],["eaVos","error amplifier input offset in mV"]]
};
const askKeys=t=>(FIELDS[t]||[]).map(x=>x[0]);
function googleUrl(type,pn){
  const f=FIELDS[type]||[];
  const q=`For part number ${pn}, reply with exactly ONE line of comma-separated values and nothing else: no table, no header, no explanation, no units, no code block. The line must be: ${pn},${f.map(x=>x[0]).join(",")}  where the fields are, in order: ${f.map(x=>x[0]+" = "+x[1]).join("; ")}. Use plain numbers only. If the datasheet only gives a curve or a range, give the typical number; if a value is not stated, leave that field empty.`;
  return "https://www.google.com/search?q="+encodeURIComponent(q);
}

/* ---------- DigiKey: structured parameters through the worker (same password as Mouser) ---------- */
async function digikeyFetch(pn){
  const path="/digikey?pn="+encodeURIComponent(pn);
  let res=await mouserReq(path,getKey());
  if(res.status===401&&typeof root.prompt==="function"){
    const k=root.prompt(getKey()?"That password was not accepted. Enter the lookup password:":"Lookups are password protected. Enter the lookup password:");
    if(k){res=await mouserReq(path,k);if(res.ok)setKey(k)}
  }
  return res;
}
/* "47 µF", "2.1mOhm @ 30A, 10V", "±20%", "Max 12mOhm", "100A (Tc)" -> number in the wanted unit; null if it is not a plain figure */
const SI={p:1e-12,n:1e-9,u:1e-6,"µ":1e-6,m:1e-3,k:1e3,M:1e6,G:1e9};
function dkNum(text,unit,scale){
  const m=String(text||"").replace(/,/g,"").match(/(-?\d+(?:\.\d+)?)\s*([pnuµmkMG]?)\s*(Ohms?|Ω|F|H|V|A|C|Hz|W|%|°C)/);
  if(!m)return null;
  const mult=m[2]?SI[m[2]]:1,u=m[3];
  if(unit==="%"){return u==="%"?+m[1]:null}
  const want={Ohm:/^(Ohms?|Ω)$/,F:/^F$/,H:/^H$/,V:/^V$/,A:/^A$/,C:/^C$/,Hz:/^Hz$/}[unit];
  if(!want||!want.test(u))return null;
  const v=+m[1]*mult*(scale||1);return isFinite(v)?+v.toPrecision(6):null;
}
const pick=(p,re)=>{const k=Object.keys(p).find(x=>re.test(x));return k?p[k]:undefined};
function dkMap(type,r){
  const p=r.parameters||{},vals={},out={vals,manufacturer:r.manufacturer||"",description:r.description||"",datasheet:r.datasheet||"",mpn:r.mpn||""};
  const put=(k,v)=>{if(v!=null&&isFinite(v))vals[k]=v};
  if(type==="cap"){
    put("c",dkNum(pick(p,/^Capacitance/),"F",1e6));put("vr",dkNum(pick(p,/^Voltage - Rated/),"V"));put("tol",dkNum(pick(p,/^Tolerance/),"%"));
    put("esr",dkNum(pick(p,/^ESR/),"Ohm",1e3));put("irmsC",dkNum(pick(p,/^Ripple Current/),"A"));
    const cat=(r.category||"").toLowerCase(),tc=String(pick(p,/^Temperature Coefficient|^Dielectric/)||"");
    out.type=/polymer/.test(cat)?"poly":/tantalum/.test(cat)?"tant":/alumin/.test(cat)?"alu":/film/.test(cat)?"film":/ceramic/.test(cat)||/X[5-8][RSTU]|C0G|NP0/i.test(tc)?"mlcc":null;
    if(/C0G|NP0/i.test(tc))out.dielectric="c0g";else if(/X[5-8][RSTU]/i.test(tc))out.dielectric="x7r";
  }else if(type==="fet"){
    put("vds",dkNum(pick(p,/^Drain to Source Voltage/),"V"));put("id",dkNum(pick(p,/^Current - Continuous Drain/),"A"));
    put("rds",dkNum(pick(p,/^Rds On/),"Ohm",1e3));put("qg",dkNum(pick(p,/^Gate Charge/),"C",1e9));
    const t=String(pick(p,/^Operating Temperature/)||"").match(/(-?\d+)\s*°C\s*~\s*(-?\d+)\s*°C/);if(t)put("tjmax",+t[2]);
  }else if(type==="ind"){
    put("L",dkNum(pick(p,/^Inductance/),"H",1e6));put("ltol",dkNum(pick(p,/^Tolerance/),"%"));
    put("isat",dkNum(pick(p,/Saturation/),"A"));put("irms",dkNum(pick(p,/^Current Rating/),"A"));put("dcr",dkNum(pick(p,/DC Resistance|DCR/),"Ohm",1e3));
  }else{
    put("vinMaxIc",dkNum(pick(p,/^Voltage - Input \(Max\)/),"V"));put("ioutMaxIc",dkNum(pick(p,/^Current - Output/),"A"));
    put("fswMax",dkNum(pick(p,/^Frequency - Switching/),"Hz",1e-3));
  }
  return out;
}

/* what Mouser's one-line description states plainly; the rest has to come from the datasheet */
function mouserMap(kind,r){
  const d=r.description||"",vals={};
  const all=(re,sc)=>[...d.matchAll(re)].map(m=>parseFloat(m[1])*(sc||1));
  const volts=all(/(\d+(?:\.\d+)?)\s*V(?:DC)?\b/g),amps=all(/(\d+(?:\.\d+)?)\s*A\b/g),mOhm=all(/(\d+(?:\.\d+)?)\s*m\s?Ohms?\b/gi);
  const uH=[...all(/(\d+(?:\.\d+)?)\s*[uµ]H\b/gi),...all(/(\d+(?:\.\d+)?)\s*nH\b/gi,1e-3)];
  const uF=[...all(/(\d+(?:\.\d+)?)\s*[uµ]F\b/gi),...all(/(\d+(?:\.\d+)?)\s*nF\b/gi,1e-3),...all(/(\d+(?:\.\d+)?)\s*pF\b/gi,1e-6)];
  const pct=all(/(\d+(?:\.\d+)?)\s*%/g);let type=null;
  if(kind==="fet"){if(volts.length)vals.vds=volts[0];if(amps.length)vals.id=amps[0]}
  else if(kind==="ind"){if(uH.length)vals.L=uH[0];if(pct.length)vals.ltol=pct[0];if(mOhm.length)vals.dcr=mOhm[0]}
  else if(kind==="cap"){if(uF.length)vals.c=uF[0];if(volts.length)vals.vr=volts[0];if(pct.length)vals.tol=pct[0];
    if(/polymer/i.test(d))type="poly";else if(/tantalum/i.test(d))type="tant";else if(/alumin(i)?um|electrolytic/i.test(d))type="alu";else if(/film/i.test(d))type="film";else if(/ceramic|mlcc|X5R|X7R|X6S|X7S|C0G|NP0/i.test(d))type="mlcc"}
  else if(volts.length)vals.vinMaxIc=Math.max.apply(null,volts);
  const out={vals,type,manufacturer:r.manufacturer||"",description:d,datasheet:r.datasheet||"",mpn:r.mpn||""};
  const di=(d.match(/\b(X5R|X7R|X6S|X7S|X7T|X8R|C0G|NP0|Y5V)\b/i)||[])[1];
  if(di)out.dielectric=/C0G|NP0/i.test(di)?"c0g":"x7r";
  return out;
}
/* One lookup everywhere: DigiKey first; Mouser only if DigiKey fails or has nothing; otherwise nothing found.
   Returns {ok,source,mpn,exact,manufacturer,description,datasheet,productUrl,type,dielectric,vals,raw,errors[],needPassword}.
   ok:false means neither source knew the part: the caller adds it with placeholders for the user to fill. */
async function lookupPart(kind,pn){
  const errors=[];
  const json=async res=>res.json().catch(()=>({}));
  let dk=null;
  try{
    const res=await digikeyFetch(pn);
    if(res.status===401)return {ok:false,needPassword:true,errors:["The lookup password is needed."]};
    const r=await json(res);
    if(!res.ok)errors.push("DigiKey: "+(r.error||("returned "+res.status)));
    else if(!r.found)errors.push("DigiKey does not list "+pn);
    else dk={r,m:dkMap(kind,r)};
  }catch(e){errors.push("DigiKey: could not reach the service")}
  if(dk&&Object.keys(dk.m.vals).length){
    return Object.assign({ok:true,source:"digikey",exact:!!dk.r.exact,productUrl:dk.r.productUrl||"",raw:dk.r,errors,otherMatches:dk.r.otherMatches||0},dk.m);
  }
  let mz=null;
  try{
    const res=await mouserFetch(pn);
    if(res.status===401)return {ok:false,needPassword:true,errors:["The lookup password is needed."]};
    const r=await json(res);
    if(!res.ok)errors.push("Mouser: "+(r.error||("returned "+res.status)));
    else if(!r.found)errors.push("Mouser does not list "+pn);
    else mz={r,m:mouserMap(kind,r)};
  }catch(e){errors.push("Mouser: could not reach the service")}
  if(dk&&!mz){   /* DigiKey knew the part but had no usable values; keep its text fields */
    return Object.assign({ok:true,source:"digikey",exact:!!dk.r.exact,productUrl:dk.r.productUrl||"",raw:dk.r,errors,otherMatches:dk.r.otherMatches||0},dk.m);
  }
  if(mz){
    const base=dk?Object.assign({},mz.m,{manufacturer:dk.m.manufacturer||mz.m.manufacturer,datasheet:dk.m.datasheet||mz.m.datasheet,type:dk.m.type||mz.m.type}):mz.m;
    return Object.assign({ok:true,source:dk?"digikey+mouser":"mouser",exact:dk?!!dk.r.exact:(mz.r.mpn||"").toUpperCase()===pn.toUpperCase(),productUrl:(dk&&dk.r.productUrl)||mz.r.productUrl||"",raw:mz.r,errors,otherMatches:mz.r.otherMatches||0},base);
  }
  return {ok:false,errors};
}

/* ---------- filtering parts in the pickers ----------
   kind narrows by technology: for capacitors "mlcc", "x7r" (MLCC X7R/X5R), "c0g", "poly", "tant", "alu", "film".
   q is the little filter box. Its words all have to match:
     plain text      murata, x7r, 0805, verified       part number, maker, description, type
     value + unit    47u  10n  25V  5m  3A  4.7uH  500k  capacitance/inductance near that value, voltage and current
                                                        at least that rating, mΩ at most that resistance
     comparison      c>=10  vr>16  esr<5  L=4.7          any stored value by its key (as in the parts library columns)  */
const UNITS={
  cap:{u:["c","eq"],uf:["c","eq"],"µ":["c","eq"],"µf":["c","eq"],n:["c","eq",1e-3],nf:["c","eq",1e-3],p:["c","eq",1e-6],pf:["c","eq",1e-6],v:["vr","ge"],m:["esr","le"],mohm:["esr","le"],"mω":["esr","le"],a:["irmsC","ge"],nh:["esl","le"]},
  ind:{u:["L","eq"],uh:["L","eq"],"µ":["L","eq"],"µh":["L","eq"],n:["L","eq",1e-3],nh:["L","eq",1e-3],a:["isat","ge"],m:["dcr","le"],mohm:["dcr","le"],"mω":["dcr","le"]},
  fet:{v:["vds","ge"],a:["id","ge"],m:["rds","le"],mohm:["rds","le"],"mω":["rds","le"],nc:["qg","le"]},
  ctrl:{v:["vinMaxIc","ge"],a:["ilim","ge"],us:["eaGm","ge"],"µs":["eaGm","ge"],k:["fswMax","ge"],khz:["fswMax","ge"],mhz:["fswMax","ge",1e3]},
  conv:{v:["vinMaxIc","ge"],a:["ioutMaxIc","ge"],us:["eaGm","ge"],"µs":["eaGm","ge"],k:["fswMax","ge"],khz:["fswMax","ge"],mhz:["fswMax","ge",1e3]}
};
const near=(a,b)=>isFinite(a)&&Math.abs(a-b)<=Math.abs(b)*0.02+1e-12;
function ofKind(e,kind){
  if(!kind||kind==="custom"||kind==="all")return true;
  if(kind==="x7r")return e.type==="mlcc"&&e.dielectric!=="c0g";
  if(kind==="c0g")return (e.type==="mlcc"&&e.dielectric==="c0g")||e.type==="film";
  return e.type===kind;
}
function textOf(e){
  const t=[e.pn,e.manufacturer,e.description,e.type,e.dielectric,e.verified?"verified ✓":"unverified ○"];
  if(e.type==="mlcc")t.push("ceramic",e.dielectric==="c0g"?"c0g np0":"x7r x5r");
  return t.join(" ").toLowerCase();
}
function valOf(e,key){const v=e.vals||{},k=Object.keys(v).find(x=>x.toLowerCase()===key.toLowerCase());return k==null?NaN:+v[k]}
function tokenOk(type,e,tok){
  let m=tok.match(/^([a-z][a-z0-9_]*)(>=|<=|>|<|=)(-?\d*\.?\d+)$/i);
  if(m){const x=valOf(e,m[1]),n=+m[3];if(!isFinite(x))return false;
    return m[2]===">="?x>=n:m[2]==="<="?x<=n:m[2]===">"?x>n:m[2]==="<"?x<n:near(x,n)}
  m=tok.match(/^(-?\d*\.?\d+)([a-zµω]+)$/i);
  const u=m&&(UNITS[type]||{})[m[2].toLowerCase()];
  if(u){const x=valOf(e,u[0]),n=+m[1]*(u[2]||1);
    if(u[1]==="ge"?x>=n:u[1]==="le"?x<=n:near(x,n))return true}
  if(/^-?\d*\.?\d+$/.test(tok)&&Object.values(e.vals||{}).some(x=>near(+x,+tok)))return true;
  return textOf(e).includes(tok.toLowerCase());
}
function matches(type,e,q){
  const toks=String(q||"").replace(/\s*(>=|<=|>|<|=)\s*/g,"$1").split(/[\s,;]+/).filter(Boolean);
  return toks.every(t=>tokenOk(type,e,t));
}
/* parts of one type for a picker: {items, total, kindCount, kindMissing} — when no part is of the wanted kind, items
   falls back to every kind (kindMissing true) so the picker never goes empty just because the library lacks that kind */
function pickFor(type,opts){
  opts=opts||{};const list=get(type),kinded=list.filter(e=>ofKind(e,opts.kind));
  const base=kinded.length||!list.length?kinded:list;
  return {items:base.filter(e=>matches(type,e,opts.q)),total:list.length,kindCount:kinded.length,kindMissing:!kinded.length&&!!list.length};
}

/* a verified tick on a library part; the server keeps the existing values */
async function setVerified(type,e,flag,by){
  return save(type,{pn:e.pn,type:e.type,verified:!!flag,vals:e.vals},by);
}

/* one-off: queue parts a device saved before the shared library existed */
function adopt(oldLib){
  if(ls.get(ADK)||!oldLib||typeof oldLib!=="object")return 0;
  let n=0;
  for(const t of TYPES)for(const e of (Array.isArray(oldLib[t])?oldLib[t]:[])){
    if(!e||!e.pn||!e.vals)continue;
    if((cache[t]||[]).some(x=>up(x.pn)===up(e.pn)))continue;
    pending.push({type:t,entry:{pn:e.pn,type:e.type,manufacturer:e.manufacturer,description:e.description,datasheet:e.datasheet,vals:e.vals},by:getBy()});n++;
  }
  ls.set(ADK,"1");persistPending();emit();
  if(n)flush().then(emit);
  return n;
}
const getBy=()=>ls.get(BYK)||"";
const setBy=v=>ls.set(BYK,String(v||"").slice(0,40));

/* ---------- capacitor records: Buck Designer <-> Buck Compensation ----------
   Library record: {pn,type:'mlcc|poly|tant|alu|film',dielectric?,manufacturer,description,datasheet,
                    vals:{c µF, esr mΩ, esl nH, vr V, irmsC A, tol, temp, eol, esrLo, esrHi, df tanδ, fs kHz}}
   DC-bias loss is not stored: it depends on the voltage the part runs at, so each design sets it. */
const COMP_DEF={x7r:{df:0.025,fs:1000},c0g:{df:0.001,fs:1000},poly:{df:0.1,fs:100},tant:{df:0.08,fs:100},alu:{df:0.16,fs:100}};
const CAP_REQ=["c","esr","esl","vr","irmsC"];
const capComplete=e=>!!e&&!!e.vals&&CAP_REQ.every(k=>isFinite(e.vals[k]))&&e.vals.c>0;
function capToComp(e){
  const v=e.vals||{};
  const type=e.type==="mlcc"?(e.dielectric==="c0g"?"c0g":"x7r"):e.type==="film"?"c0g":(COMP_DEF[e.type]?e.type:"x7r");
  const d=COMP_DEF[type];
  return {pn:e.pn,type,c:v.c>0?v.c:undefined,esr:v.esr,esl:v.esl,fs:v.fs>0?v.fs:d.fs,df:v.df!=null?v.df:d.df,
    fromPreset:{fs:!(v.fs>0),df:v.df==null},mz:{manufacturer:e.manufacturer||"",description:e.description||"",datasheet:e.datasheet||""}};
}
function compToCap(g,mz){
  const type={x7r:"mlcc",c0g:"mlcc",poly:"poly",tant:"tant",alu:"alu"}[g.type];
  if(!type)return null;
  const vals={};
  for(const [k,v] of [["c",g.c],["esr",g.esr],["esl",g.esl],["df",g.df],["fs",g.fs]])if(isFinite(v)&&v>=0)vals[k]=v;
  mz=mz||{};
  const e={pn:String(g.pn||"").trim().toUpperCase(),type,manufacturer:mz.manufacturer||"",description:mz.description||"",datasheet:mz.datasheet||"",vals};
  if(type==="mlcc")e.dielectric=g.type;
  return e;
}

root.PartsLib={API,TYPES,all,get,pick:pickFor,matches,ofKind,status,onChange,pull,flush,save,remove,history,adopt,getBy,setBy,capToComp,compToCap,capComplete,CAP_REQ,mouserFetch,digikeyFetch,lookupPart,mouserMap,dkMap,dkNum,googleUrl,askKeys,setVerified,getKey,setKey};
})(typeof window!=="undefined"?window:globalThis);
