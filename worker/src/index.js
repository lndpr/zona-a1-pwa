import { handleZones } from "./zones-endpoint.js";
import { handlePush, runPushAlerts, pingWatcher } from "./push-alerts.js";
import { handleSiteAnalytics } from "./site-analytics.js";
export { SignalHub } from "./signal-hub.js";
export { TickWatcher } from "./tick-watcher.js";


/*
================================
NEWS PROXY (Google News RSS + allowlist fetch)
Dipakai panel "Berita Utama" & Economic Calendar di website.
================================
*/

const NEWS_UA =
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const NEWS_ALLOW_HOSTS = new Set([
"nfs.faireconomy.media",
"showmytrades.com",
"biquote.io",
"www.financecalendar.com",
"translate.googleapis.com"
]);

const NEWS_RSS_TTL = 120;
const NEWS_FETCH_TTL = 60;


function newsClean(x){

return String(x || "")
.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
.replace(/&lt;/g,"<").replace(/&gt;/g,">")
.replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
.replace(/&nbsp;/g," ").replace(/&amp;/g,"&")
.replace(/<[^>]*>/g," ")
.replace(/&nbsp;/g," ")
.replace(/\s+/g," ")
.trim();

}


export function parseNewsRss(xml,limit=30,defaultSource=""){

const items=[];
const re=/<item>([\s\S]*?)<\/item>/g;
let m;

while((m=re.exec(xml)) && items.length<limit){

const b=m[1];

const g=n=>{
const t=b.match(new RegExp("<"+n+"(?:\\s[^>]*)?>([\\s\\S]*?)</"+n+">"));
return t ? newsClean(t[1]) : "";
};

const d=new Date(g("pubDate"));
const title=g("title");

if(!title || isNaN(d)) continue;

items.push({
title,
link:g("link"),
pubDate:d.toISOString(),
source:g("source")||g("News:Source")||defaultSource,
description:g("description").slice(0,260)
});

}

return items;

}


async function newsCached(request,ctx,ttl,producer){

const cache=caches.default;
const key=new Request(request.url,{method:"GET"});

const hit=await cache.match(key);

if(hit){
return new Response(hit.body,{
status:hit.status,
headers:{
...Object.fromEntries(hit.headers),
...CORS_HEADERS,
"X-Cache":"HIT"
}
});
}

const res=await producer();

if(res.status===200){
const store=new Response(res.clone().body,{
status:200,
headers:{
...Object.fromEntries(res.headers),
"Cache-Control":"public, max-age="+ttl
}
});
ctx.waitUntil(cache.put(key,store));
}

return res;

}


const NEWS_DIRECT_FEEDS={

en:[
["https://www.cnbc.com/id/10000664/device/rss/rss.html","CNBC"],
["https://www.cnbc.com/id/100003114/device/rss/rss.html","CNBC"],
["https://feeds.marketwatch.com/marketwatch/topstories/","MarketWatch"],
["https://www.fxstreet.com/rss/news","FXStreet"],
["https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC%3DF&region=US&lang=en-US","Yahoo Finance"]
],

id:[
["https://www.cnbcindonesia.com/market/rss","CNBC Indonesia"],
["https://www.antaranews.com/rss/ekonomi.xml","ANTARA"],
["https://www.idxchannel.com/rss","IDX Channel"],
["https://investasi.kontan.co.id/rss","Kontan"]
]

};

const NEWS_CAT_RE={
gold:/gold|xau|bullion|precious|emas/i,
fed:/\bfed\b|fomc|powell|federal reserve|interest rate|rate (cut|hike)|suku bunga/i,
macro:/cpi|inflation|inflasi|pce|ppi|payroll|nfp|yield|treasury|dollar|dxy|ecb|boj|boe|central bank|forex|rupiah|bank sentral/i,
risk:/oil|crude|brent|wti|opec|iran|israel|geopolit|hormuz|houthi|war|minyak/i,
stocks:/saham|ihsg|bursa|emiten|idx|\bbei\b|dividen|bbca|bbri|bmri|bbni|tlkm|asii/i
};


async function newsFetchText(u){

const r=await fetch(u,{
headers:{
"User-Agent":NEWS_UA,
"Accept":"application/rss+xml, application/xml, text/xml, */*",
"Accept-Language":"en-US,en;q=0.9,id;q=0.8"
}
});

return {status:r.status,text:r.ok ? await r.text() : ""};

}


async function handleNewsRss(url){

const q=(url.searchParams.get("q")||"").trim().slice(0,500);

if(!q){
return json({ok:false,error:"q required"},400);
}

const id=url.searchParams.get("lang")==="id";
const cat=url.searchParams.get("cat")||"";
const tried=[];

const done=(via,items)=>{
items.sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
return json({
ok:true,
via,
count:items.length,
fetchedAt:new Date().toISOString(),
tried,
items
});
};


// 1) Google News
try{

const g=
"https://news.google.com/rss/search?q="+
encodeURIComponent(q+" when:2d")+
(id
? "&hl=id&gl=ID&ceid=ID:id"
: "&hl=en-US&gl=US&ceid=US:en");

const r=await newsFetchText(g);
tried.push({src:"google",status:r.status});

if(r.text){
const items=parseNewsRss(r.text);
if(items.length) return done("google",items);
}

}
catch(e){
tried.push({src:"google",error:String(e&&e.message||e)});
}


// 2) Bing News
try{

const b=
"https://www.bing.com/news/search?q="+
encodeURIComponent(q)+
"&format=rss&mkt="+(id?"id-ID":"en-US");

const r=await newsFetchText(b);
tried.push({src:"bing",status:r.status});

if(r.text){
const items=parseNewsRss(r.text);
if(items.length) return done("bing",items);
}

}
catch(e){
tried.push({src:"bing",error:String(e&&e.message||e)});
}


// 3) Feed langsung dari media (difilter sesuai kategori)
const feeds=NEWS_DIRECT_FEEDS[id?"id":"en"];
const re=NEWS_CAT_RE[cat];

const settled=await Promise.allSettled(
feeds.map(async([u,name])=>{
const r=await newsFetchText(u);
tried.push({src:name,status:r.status});
return r.text ? parseNewsRss(r.text,40,name) : [];
})
);

const seen=new Set();
const items=[];
const maxAge=96*3600000;

settled.forEach(x=>{
if(x.status!=="fulfilled") return;
x.value.forEach(a=>{
const key=a.title.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
if(!key||seen.has(key)) return;
if(Date.now()-new Date(a.pubDate).getTime()>maxAge) return;
if(re && !re.test(a.title+" "+a.description)) return;
seen.add(key);
items.push(a);
});
});

if(items.length) return done("direct",items);

return json({ok:false,error:"all sources failed",tried},502);

}


async function handleNewsFetch(url){

let target;

try{
target=new URL(url.searchParams.get("url")||"");
}
catch{
return json({ok:false,error:"bad url"},400);
}

if(
target.protocol!=="https:" ||
!NEWS_ALLOW_HOSTS.has(target.hostname)
){
return json({ok:false,error:"host not allowed"},403);
}

const r=await fetch(target.toString(),{
headers:{
"User-Agent":NEWS_UA,
"Accept":"application/json, text/plain, */*"
}
});

return new Response(await r.text(),{
status:r.status,
headers:{
"Content-Type":r.headers.get("Content-Type")||"application/json",
...CORS_HEADERS
}
});

}



const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-API-Key, X-Admin-Key, X-Confirm-Delete",
};



function json(data, status = 200){

return new Response(
JSON.stringify(data),
{
status,
headers:{
"Content-Type":"application/json",
...CORS_HEADERS
}
}
);

}



function getHub(env){

const id = env.SIGNAL_HUB.idFromName("main");

return env.SIGNAL_HUB.get(id);

}



function isAdmin(request,env){

const key =
request.headers.get("X-Admin-Key");

return Boolean(
env.ADMIN_SECRET &&
key &&
key === env.ADMIN_SECRET
);

}





export default {


async fetch(request,env,ctx){


const url = new URL(request.url);

// Private website visit analytics; data is stored in D1 and not rendered on the public site.
if (url.pathname === "/api/site-visit" || url.pathname === "/api/site-visit-stats") {
  const visitRes = await handleSiteAnalytics(request, env);
  if (visitRes) return visitRes;
}

// Tick Watcher diagnostic endpoint (public read-only status).
if (url.pathname === "/tick-watcher/status" && request.method === "GET") {
  try {
    if (!env.TICK_WATCHER) return json({ ok: false, error: "TICK_WATCHER binding missing" }, 500);
    const stub = env.TICK_WATCHER.get(env.TICK_WATCHER.idFromName("main"));
    const r = await stub.fetch("https://tick-watcher/status", { method: "GET" });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}

// Tick Watcher ensure endpoint
if (url.pathname === "/tick-watcher/ensure" && request.method === "POST") {
  try {
    if (!env.TICK_WATCHER) {
      return json({
        ok: false,
        error: "TICK_WATCHER binding missing"
      }, 500);
    }

    const stub = env.TICK_WATCHER.get(
      env.TICK_WATCHER.idFromName("main")
    );

    const r = await stub.fetch(
      "https://tick-watcher/ensure",
      { method: "POST" }
    );

    return new Response(await r.text(), {
      status: r.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (e) {
    return json({
      ok: false,
      error: String(e.message || e)
    }, 500);
  }
}

// ZONA SNAPSHOT API — data zona dari EA ke dashboard
if (url.pathname === "/api/zones") {
  try {
    const zr = await handleZones(request, env);
    // EA baru kirim snapshot zona -> TickWatcher langsung baca ulang & cek harga (INSTANT_ZONE_PUSH)
    if (request.method === "POST" && zr.ok) ctx.waitUntil(pingWatcher(env, "/refresh"));
    return zr;
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}

// WEB PUSH — notifikasi HP saat harga masuk blok BR1/BR2
{
  const pushRes = await handlePush(request, env);
  if (pushRes) return pushRes;
}






// CORS

if(request.method==="OPTIONS"){

return new Response(
null,
{
headers:CORS_HEADERS
}
);

}






/*
================================
ADMIN
================================
*/


if(
url.pathname === "/api/admin/signals"
||
url.pathname.startsWith("/api/admin/signals/")
){


if(!isAdmin(request,env)){

return json({
error:"unauthorized"
},401);

}




// GET HISTORY

if(
url.pathname === "/api/admin/signals"
&& request.method==="GET"
){

const {results}=await env.DB.prepare(
`
SELECT *
FROM signals
ORDER BY id DESC
LIMIT 500
`
)
.all();


return json({
signals:results
});

}





// DELETE ALL

if(
url.pathname === "/api/admin/signals"
&& request.method==="DELETE"
){


if(
request.headers.get("X-Confirm-Delete")
!=="DELETE_ALL"
){

return json({
error:"missing confirmation"
},400);

}



await env.DB.prepare(
`
DELETE FROM signals
`
)
.run();


return json({
ok:true,
deleted:"all"
});

}





// DELETE ONE

if(request.method==="DELETE"){


const id =
Number(
url.pathname.split("/").pop()
);



if(!Number.isInteger(id)){

return json({
error:"invalid id"
},400);

}



await env.DB.prepare(
`
DELETE FROM signals
WHERE id=?
`
)
.bind(id)
.run();



return json({
ok:true,
deleted:id
});


}


}








/*
================================
EA SIGNAL
================================
*/


if(
url.pathname === "/api/signal"
&& request.method==="POST"
){



const apiKey =
request.headers.get("X-API-Key");



if(
!apiKey ||
apiKey !== env.API_SECRET
){

return json({
error:"unauthorized"
},401);

}



let body;


try{

body =
await request.json();

}
catch{

return json({
error:"invalid json"
},400);

}





const {

event_type,

symbol,

direction,

zone,

entry_price,

sl,

tp,

lot,

close_reason,

ticket,

account_name,

magic,
profit
}=body;




const evtType =
event_type==="CLOSE"
?
"CLOSE"
:
"OPEN";






if(
!symbol ||
!direction ||
!zone
){

return json({
error:"missing fields"
},400);

}





/*
=============================
CLOSE UPDATE
=============================
*/


if(evtType==="CLOSE"){



const VALID = [
"TP_HIT",
"SL_HIT",
"SL_PLUS_HIT",
"STOPOUT",
"MANUAL"
];



if(!VALID.includes(close_reason)){

return json({
error:"invalid close reason"
},400);

}




let resultTrade="LOSS";


if(
close_reason==="TP_HIT"
||
close_reason==="SL_PLUS_HIT"
){

resultTrade="WIN";

}

/* profit bersih dari EA (profit+swap+komisi); MANUAL ditentukan dari tandanya */
const profitNum = (profit===null || profit===undefined || profit==="") ? null : Number(profit);
const profitVal = Number.isFinite(profitNum) ? profitNum : null;
if(close_reason==="MANUAL" && profitVal!==null){
resultTrade = profitVal>0 ? "WIN" : "LOSS";
}





await env.DB.prepare(
`
UPDATE signals

SET

status='CLOSED',

result=?,

close_reason=?,

profit=?,

closed_at=datetime('now')

WHERE ticket=?

`
)
.bind(
resultTrade,
close_reason,
profitVal,
ticket
)
.run();





const updated =
await env.DB.prepare(
`
SELECT *
FROM signals
WHERE ticket=?
`
)
.bind(ticket)
.first();





const hub=getHub(env);


await hub.fetch(
"https://internal/broadcast",
{
method:"POST",
body:JSON.stringify(updated)
}
);





return json({
ok:true,
signal:updated
});



}







/*
=============================
OPEN INSERT
=============================
*/


if(
entry_price==null ||
sl==null ||
tp==null
){

return json({
error:"missing entry sl tp"
},400);

}






const result =
await env.DB.prepare(
`

INSERT INTO signals

(

symbol,

direction,

zone,

entry_price,

sl,

tp,

lot,

status,

result,

close_reason,

ticket,

account_name,

magic

)

VALUES

(?,?,?,?,?,?,?,?,?,?,?,?,?)

`
)
.bind(

symbol,

direction,

zone,

entry_price,

sl,

tp,

lot,

"RUNNING",

null,

null,

ticket,

account_name,

magic

)
.run();






const inserted =
await env.DB.prepare(
`
SELECT *
FROM signals
WHERE id=?
`
)
.bind(
result.meta.last_row_id
)
.first();





const hub=getHub(env);



await hub.fetch(
"https://internal/broadcast",
{
method:"POST",
body:JSON.stringify(inserted)
}
);





return json({
ok:true,
signal:inserted
});


}








/*
================================
PUBLIC HISTORY
================================
*/


if(
url.pathname === "/api/signals"
&& request.method==="GET"
){


const limit =
Math.min(
parseInt(
url.searchParams.get("limit")||"50"
),
200
);



const {results}=await env.DB.prepare(
`
SELECT *
FROM signals
ORDER BY id DESC
LIMIT ?
`
)
.bind(limit)
.all();



return json({
signals:results
});


}



/*
================================
TRADE CALENDAR STATISTIC
================================
*/

if(
url.pathname === "/api/trade-calendar"
&& request.method==="GET"
){

const year =
Number(url.searchParams.get("year")) ||
new Date().getFullYear();


const month =
Number(url.searchParams.get("month")) ||
(new Date().getMonth()+1);



const start =
`${year}-${String(month).padStart(2,"0")}-01`;


const endDate =
new Date(year,month,0).getDate();


const end =
`${year}-${String(month).padStart(2,"0")}-${endDate}`;



const {results}=await env.DB.prepare(

`

SELECT

DATE(closed_at) as day,

SUM(
CASE 
WHEN result='WIN'
THEN 1
ELSE 0
END
) as win,


SUM(
CASE 
WHEN result='LOSS'
THEN 1
ELSE 0
END
) as loss,

SUM(COALESCE(profit,0)) as pnl,

SUM(CASE WHEN profit IS NOT NULL THEN 1 ELSE 0 END) as with_profit,

MAX(lot) as max_lot

FROM signals

WHERE

status='CLOSED'

AND DATE(closed_at) >= ?

AND DATE(closed_at) <= ?

GROUP BY DATE(closed_at)

ORDER BY day ASC


`

)
.bind(
start,
end
)
.all();



const baseRow = await env.DB.prepare(
`SELECT MIN(lot) as base_lot FROM signals WHERE lot > 0`
).first();

return json({
year,
month,
base_lot: baseRow ? baseRow.base_lot : null,
calendar:results
});

}

/*
================================
TRADE EQUITY CURVE (per bulan)
================================
*/

if(
url.pathname === "/api/trade-equity"
&& request.method==="GET"
){

const year =
Number(url.searchParams.get("year")) ||
new Date().getFullYear();

const month =
Number(url.searchParams.get("month")) ||
(new Date().getMonth()+1);

const start =
`${year}-${String(month).padStart(2,"0")}-01`;

const endDate =
new Date(year,month,0).getDate();

const end =
`${year}-${String(month).padStart(2,"0")}-${endDate}`;

const {results} = await env.DB.prepare(
`
SELECT
closed_at,
profit,
lot,
result
FROM signals
WHERE status='CLOSED'
AND profit IS NOT NULL
AND DATE(closed_at) >= ?
AND DATE(closed_at) <= ?
ORDER BY closed_at ASC, id ASC
`
)
.bind(start,end)
.all();

const baseRow = await env.DB.prepare(
`SELECT MIN(lot) as base_lot FROM signals WHERE lot > 0`
).first();

return json({
year,
month,
base_lot: baseRow ? baseRow.base_lot : null,
trades: results
});

}

/*
================================
SIGNALS BY DATE
================================
*/

if(
url.pathname === "/api/signals-by-date"
&& request.method==="GET"
){

const date =
url.searchParams.get("date");


if(!date){

return json({
error:"missing date"
},400);

}



const {results} =
await env.DB.prepare(
`
SELECT *
FROM signals
WHERE DATE(closed_at)=?
ORDER BY id DESC
`
)
.bind(date)
.all();



return json({

date,

signals:results

});

}


/*
================================
REALTIME (WebSocket via Durable Object Hibernation API)
================================
*/


if(
url.pathname === "/api/stream"
&& request.method==="GET"
){


const hub=getHub(env);


// Penting: teruskan REQUEST ASLI (bukan cuma string URL) supaya
// header "Upgrade: websocket" dari browser ikut kebawa ke Durable
// Object. Tanpa ini, DO nggak akan pernah tau ini permintaan upgrade
// ke WebSocket.
const doUrl = new URL("https://internal/subscribe");
const forwardReq = new Request(doUrl, request);

return hub.fetch(forwardReq);


}






/*
================================
NEWS PROXY ROUTES
================================
*/


if(
url.pathname === "/api/news/rss"
&& request.method==="GET"
){

try{
return await newsCached(request,ctx,NEWS_RSS_TTL,()=>handleNewsRss(url));
}
catch(e){
return json({ok:false,error:String(e && e.message || e)},500);
}

}


if(
url.pathname === "/api/news/fetch"
&& request.method==="GET"
){

try{
return await newsCached(request,ctx,NEWS_FETCH_TTL,()=>handleNewsFetch(url));
}
catch(e){
return json({ok:false,error:String(e && e.message || e)},500);
}

}






return json({
error:"not found"
},404);



},


// CRON (tiap menit, lihat wrangler.toml) — cek harga vs zona, kirim Web Push
async scheduled(event,env,ctx){

ctx.waitUntil(
runPushAlerts(env).catch(e=>console.log("PUSH CRON ERROR:",e&&e.message))
);

}

};
