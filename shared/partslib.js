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

async function pull(){
  state="loading";emit();
  try{const j=await req("GET","/lib");cache=j.types||{};persistCache();state="ok";emit();await flush()}
  catch(e){state=e.status===503?"nosetup":"offline"}
  emit();return all();
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
/* Google search link with a ready-made question; Google's AI answer can draft the values, which stay unverified until checked */
const ASK={
 cap:"capacitance (µF), ESR (mΩ) and the frequency it is specified at, ESL (nH), rated voltage (V), rated ripple current (A rms), tolerance (%), loss tangent tanδ, dielectric or technology",
 fet:"Vds (V), continuous Id (A), maximum Rds(on) at 25 °C (mΩ), Qg, Qgs, Qgd (nC), Miller plateau voltage (V), Coss (pF), Qrr (nC), body diode Vf (V), RθJA (°C/W), maximum junction temperature (°C)",
 ind:"inductance (µH), tolerance (%), saturation current Isat (A), rated RMS current Irms (A), maximum DCR (mΩ), temperature rise at rated current (°C)",
 ctrl:"maximum input voltage (V), maximum switching frequency (kHz), minimum on-time (ns), current limit (A), reference voltage (V) and tolerance, error amplifier gain-bandwidth, gate drive voltage (V), quiescent current (mA), soft-start current",
 conv:"maximum input voltage (V), rated output current (A), high-side and low-side Rds(on) (mΩ), switching frequency (kHz), current limit (A), reference voltage (V), quiescent current (mA), RθJA (°C/W)"
};
function googleUrl(type,pn){
  const q=`For part number ${pn}, give me a table with ${ASK[type]||"its key electrical specifications"}. Give the datasheet link and say which datasheet each value comes from.`;
  return "https://www.google.com/search?q="+encodeURIComponent(q);
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
const capComplete=e=>!!e&&!!e.vals&&CAP_REQ.every(k=>isFinite(e.vals[k]));
function capToComp(e){
  const v=e.vals||{};
  const type=e.type==="mlcc"?(e.dielectric==="c0g"?"c0g":"x7r"):e.type==="film"?"c0g":(COMP_DEF[e.type]?e.type:"x7r");
  const d=COMP_DEF[type];
  return {pn:e.pn,type,c:v.c,esr:v.esr,esl:v.esl,fs:v.fs>0?v.fs:d.fs,df:v.df!=null?v.df:d.df,
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

root.PartsLib={API,TYPES,all,get,status,onChange,pull,flush,save,remove,history,adopt,getBy,setBy,capToComp,compToCap,capComplete,CAP_REQ,mouserFetch,googleUrl,setVerified,getKey,setKey};
})(typeof window!=="undefined"?window:globalThis);
