
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const TRACKING_FILE = path.join(DATA_DIR, "tracking.json");
const CURSORS_FILE = path.join(DATA_DIR, "cursors.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

const BUDGET_USD = Number(process.env.BUDGET_USD || 5);
const STOP_AT_USD = Number(process.env.STOP_AT_USD || 4.5);
const LIVE_POLL_MS = Math.max(15000, Number(process.env.LIVE_POLL_MS || 30000));
const ECONOMY_POLL_MS = Math.max(30000, Number(process.env.ECONOMY_POLL_MS || 120000));

const emptyTracking = {
  accounts: [],
  includeReplies: false,
  includeRetweets: false,
  autoQueue: true,
  pollMode: "paused",
  blacklist: ["çekiliş", "kupon", "bonus", "indirim kodu"]
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return JSON.parse(JSON.stringify(fallback)); }
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); }
function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 15);
}
function nowIso(){ return new Date().toISOString(); }
function uid(prefix="id"){ return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }

let tracking = readJson(TRACKING_FILE, emptyTracking);
tracking.accounts = Array.isArray(tracking.accounts) ? tracking.accounts : [];
tracking.blacklist = Array.isArray(tracking.blacklist) ? tracking.blacklist : [];
// Newsroom v4.1: yeni haberler editör onayı beklemeden otomatik yayın akışına girer.
tracking.autoQueue = true;
if (!["paused","economy","live"].includes(tracking.pollMode)) tracking.pollMode = "paused";
let cursors = readJson(CURSORS_FILE, {});
let usage = readJson(USAGE_FILE, {postReads:0,userReads:0,mediaReads:0,updatedAt:null});

function estimatedCost() { return Number(((usage.postReads||0)*0.005 + (usage.userReads||0)*0.010 + (usage.mediaReads||0)*0.005).toFixed(4)); }
function addUsage(kind, count) {
  if (!count || count < 1) return;
  if (kind === "post") usage.postReads = Number(usage.postReads || 0) + count;
  if (kind === "user") usage.userReads = Number(usage.userReads || 0) + count;
  if (kind === "media") usage.mediaReads = Number(usage.mediaReads || 0) + count;
  usage.updatedAt = nowIso();
  writeJson(USAGE_FILE, usage);
}
function budgetStopped() { return estimatedCost() >= STOP_AT_USD; }
function saveTracking(){ writeJson(TRACKING_FILE, tracking); }
function saveCursors(){ writeJson(CURSORS_FILE, cursors); }
function resetCursors() { cursors = {}; saveCursors(); }

const mediaCache = new Map();
let pollTimer = null;
let pollInFlight = false;
let hideTimer = null;

const state = {
  visible: false,
  pinned: false,
  current: null,
  queue: [],
  inbox: [],
  durationMs: 25000,
  position: "bottom-left",
  mediaLayout: "side",
  videoMuted: true,
  videoVolume: 0.8,
  autoNext: true,
  lastXStatus: "Hazır",
  lastXCheck: null,
  history: []
};

function historyPush(entry) { state.history.unshift({ id: uid("history"), at: nowIso(), ...entry }); state.history = state.history.slice(0, 150); }
function scoreToLevel(score){ if (score >= 75) return "critical"; if (score >= 42) return "important"; return "normal"; }
function tierBase(tier){ return ({ official: 40, tier1: 30, reporter: 22, media: 14, other: 10 })[tier || "other"] || 10; }
const criticalKeywords = ["son dakika","breaking","resmi","here we go","anlaşma","anlaştı","ilk 11","kadro","sakat","sakatlık","ameliyat","ayrılık","istifa","imza","açıklandı","resmen","maça doğru","starting xi"];
const importantKeywords = ["transfer","görüşme","teklif","gündem","formasyon","idman","kamp kadrosu","basın toplantısı","açıklama","maç günü","lineup"];
function textScore(text){ const t=(text||"").toLowerCase(); let s=0; for(const k of criticalKeywords) if(t.includes(k)) s+=18; for(const k of importantKeywords) if(t.includes(k)) s+=8; if(t.length<110) s+=4; return s; }
function normalizeForCompare(text){ return String(text||"").toLowerCase().replace(/https?:\/\/\S+/g," ").replace(/@\w+/g," ").replace(/[^a-z0-9çğıöşü\s]/gi," ").replace(/\s+/g," ").trim(); }
function jaccard(a,b){ const sa=new Set(normalizeForCompare(a).split(" ").filter(Boolean)); const sb=new Set(normalizeForCompare(b).split(" ").filter(Boolean)); if(!sa.size||!sb.size) return 0; let inter=0; for(const x of sa) if(sb.has(x)) inter++; return inter/(sa.size+sb.size-inter); }
function fingerprint(text){ return normalizeForCompare(text).split(" ").slice(0,14).join(" "); }
function isBlacklisted(text){ const t=(text||"").toLowerCase(); return tracking.blacklist.some(x=>String(x||"").trim() && t.includes(String(x).toLowerCase())); }

function normalizePost(p = {}){
  const account = p.account || null;
  const score = Number.isFinite(Number(p.score)) ? Number(p.score) : tierBase(account?.tier) + textScore(p.text) + ((p.mediaKeys || []).length ? 6 : 0);
  return {
    id: String(p.id || uid("post")),
    name: String(p.name || account?.name || "Haber Merkezi").slice(0, 80),
    username: cleanUsername(p.username || account?.username || "sondakika"),
    avatar: String(p.avatar || account?.avatar || "").slice(0, 1500),
    text: String(p.text || "").trim().slice(0, 5000),
    createdAt: p.createdAt || nowIso(),
    source: p.source || "manual",
    url: String(p.url || "").slice(0, 1500),
    mediaKeys: Array.isArray(p.mediaKeys) ? p.mediaKeys.slice(0, 4) : [],
    mediaLoaded: Boolean(p.mediaLoaded),
    media: Array.isArray(p.media) ? p.media.slice(0, 4) : [],
    score,
    level: p.level || scoreToLevel(score),
    group: p.group || account?.group || "Genel",
    tier: p.tier || account?.tier || "other",
    duplicateCount: Number(p.duplicateCount || 0),
    sourceUsers: Array.isArray(p.sourceUsers) ? p.sourceUsers : [cleanUsername(p.username || account?.username || "sondakika")],
    template: p.template || "news",
    displayMode: p.displayMode || "text"
  };
}
function overlayPayload(){ return { ...state, tracking, usage: { ...usage, estimatedUSD: estimatedCost(), budgetUSD: BUDGET_USD, stopAtUSD: STOP_AT_USD, stopped: budgetStopped() }, xConfigured: Boolean(process.env.X_BEARER_TOKEN) }; }
function broadcast(message){ const raw=JSON.stringify(message); for(const client of wss.clients){ if(client.readyState===WebSocket.OPEN) client.send(raw); } }
function broadcastState(){ broadcast({ type: "state", state: overlayPayload() }); }
function clearHideTimer(){ if(hideTimer) clearTimeout(hideTimer); hideTimer=null; }
function scheduleHide(){ clearHideTimer(); if(!state.visible || state.pinned || !state.current) return; hideTimer=setTimeout(()=>{ if(state.pinned) return; state.visible=false; broadcastState(); if(state.queue.length) setTimeout(showNext,350); }, state.durationMs); }
function replacePostEverywhere(id, updater){ state.inbox=state.inbox.map(p=>p.id===id?updater({...p}):p); state.queue=state.queue.map(p=>p.id===id?updater({...p}):p); if(state.current?.id===id) state.current=updater({...state.current}); }
function findDuplicate(post){ const recent=state.inbox.slice(0,50); const fp=fingerprint(post.text); return recent.find(existing=> existing.group===post.group && ((existing.fingerprint && existing.fingerprint===fp) || jaccard(existing.text, post.text)>=0.84)); }
function prepareAutoPublish(post){ const p=normalizePost(post); p.template=p.level==="critical"?"flash":"news"; p.displayMode="text"; return p; }
function sendToAutomaticOnAir(post){ const p=prepareAutoPublish(post); const busy=Boolean(state.visible && state.current); if(state.pinned || busy){ if(!state.queue.some(x=>x.id===p.id)){ state.queue.push({...p}); historyPush({type:state.pinned?"queued-pinned":"queued-auto", text:p.text.slice(0,110), username:p.username, level:p.level}); } broadcastState(); return; } showPost(p, p.template, p.displayMode); }
function addInbox(post){ const p=normalizePost(post); if(!p.text || isBlacklisted(p.text)) return; const duplicate=findDuplicate(p); if(duplicate){ duplicate.duplicateCount=Number(duplicate.duplicateCount||0)+1; duplicate.score=Math.min(100, duplicate.score+4); duplicate.level=scoreToLevel(duplicate.score); duplicate.sourceUsers=Array.from(new Set([...(duplicate.sourceUsers||[]), p.username])).slice(0,8); historyPush({type:"merge", text:p.text.slice(0,110), username:p.username}); broadcastState(); return; } p.fingerprint=fingerprint(p.text); state.inbox.unshift(p); state.inbox=state.inbox.slice(0,180); historyPush({type:"inbox", text:p.text.slice(0,110), username:p.username, level:p.level}); sendToAutomaticOnAir(p); }
function showPost(post, template="news", displayMode="text"){ const p=normalizePost(post); p.template=template; p.displayMode=displayMode; state.current=p; state.visible=true; state.pinned=false; historyPush({type:"onair", text:p.text.slice(0,110), username:p.username, template, displayMode}); broadcastState(); scheduleHide(); }
function showNext(){ if(!state.queue.length){ state.visible=false; state.current=null; state.pinned=false; clearHideTimer(); broadcastState(); return; } const next=state.queue.shift(); showPost(next, next.template||"news", next.displayMode||"text"); }
function removeById(collection,id){ state[collection]=state[collection].filter(x=>x.id!==String(id)); }
function chunk(arr,size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
function batchKey(accounts){ return accounts.map(a=>a.username.toLowerCase()).sort().join("|"); }
function buildQuery(accounts){ let q=`(${accounts.map(a=>`from:${a.username}`).join(" OR ")})`; if(!tracking.includeRetweets) q+=" -is:retweet"; if(!tracking.includeReplies) q+=" -is:reply"; return q; }
function accountForAuthorId(authorId){ return tracking.accounts.find(a=>String(a.id||"")===String(authorId||"")); }
async function xFetch(url){ const token=process.env.X_BEARER_TOKEN; if(!token) throw new Error("X_BEARER_TOKEN tanımlı değil."); const res=await fetch(url,{ headers:{ "Authorization":`Bearer ${token}`, "User-Agent":"OBS-X-Newsroom/4.1" }}); if(!res.ok){ const body=await res.text(); throw new Error(`X HTTP ${res.status}: ${body.slice(0,280)}`); } return res.json(); }
async function lookupAccount(username){ const clean=cleanUsername(username); const params=new URLSearchParams({"user.fields":"name,username,profile_image_url"}); const payload=await xFetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(clean)}?${params}`); if(!payload.data) throw new Error("X hesabı bulunamadı."); addUsage("user",1); return payload.data; }
async function searchBatch(accounts){ const key=batchKey(accounts); if(!cursors[key]){ cursors[key]={ startedAt: nowIso(), sinceId:null }; saveCursors(); } const params=new URLSearchParams({ query:buildQuery(accounts), max_results:String(Math.min(100, Math.max(10, Number(process.env.X_MAX_RESULTS||25)))), "tweet.fields":"created_at,author_id,attachments" }); if(cursors[key].sinceId) params.set("since_id", cursors[key].sinceId); else params.set("start_time", cursors[key].startedAt); const payload=await xFetch(`https://api.x.com/2/tweets/search/recent?${params.toString()}`); const rows=Array.isArray(payload.data)?payload.data:[]; if(rows.length) addUsage("post", rows.length); if(payload.meta?.newest_id){ cursors[key].sinceId=String(payload.meta.newest_id); saveCursors(); } return rows.map(row=>{ const account=accountForAuthorId(row.author_id); return normalizePost({ id:row.id, account, text:row.text, createdAt:row.created_at||nowIso(), url:account?.username?`https://x.com/${account.username}/status/${row.id}`:"", source:"x", mediaKeys: row.attachments?.media_keys || [] }); }); }
async function loadMediaForPost(postId){ if(budgetStopped()) throw new Error("Yerel bütçe freni devrede."); let target=state.inbox.find(p=>p.id===postId) || state.queue.find(p=>p.id===postId) || (state.current?.id===postId?state.current:null); if(!target) throw new Error("İçerik bulunamadı."); if(target.mediaLoaded) return; const keys=Array.isArray(target.mediaKeys)?target.mediaKeys.filter(Boolean):[]; if(!keys.length){ replacePostEverywhere(postId, p=>({...p, mediaLoaded:true, media:[]})); broadcastState(); return; } const missing=keys.filter(k=>!mediaCache.has(k)); if(missing.length){ const params=new URLSearchParams({ media_keys: missing.join(","), "media.fields":"type,url,preview_image_url,variants,width,height,duration_ms,alt_text" }); const payload=await xFetch(`https://api.x.com/2/media?${params.toString()}`); const rows=Array.isArray(payload.data)?payload.data:[]; if(rows.length) addUsage("media", rows.length); for(const media of rows) mediaCache.set(media.media_key, media); }
  const media=keys.map(k=>mediaCache.get(k)).filter(Boolean).map(m=>{ const variants=Array.isArray(m.variants)?m.variants.filter(v=>v.content_type==="video/mp4" && v.url):[]; variants.sort((a,b)=>(b.bit_rate||0)-(a.bit_rate||0)); return { key:m.media_key, type:m.type, url:m.url||"", preview:m.preview_image_url||m.url||"", videoUrl:variants[0]?.url||"", width:m.width||0, height:m.height||0, durationMs:m.duration_ms||0, altText:m.alt_text||"" }; }); replacePostEverywhere(postId, p=>({...p, mediaLoaded:true, media})); historyPush({type:"media", text:target.text.slice(0,90), username:target.username}); broadcastState(); }
async function pollX(force=false){ if(pollInFlight) return; if(!force && tracking.pollMode==="paused") return; if(budgetStopped()){ state.lastXStatus=`Yerel bütçe freni devrede: $${estimatedCost().toFixed(2)} / $${STOP_AT_USD.toFixed(2)}`; broadcastState(); return; } const enabled=tracking.accounts.filter(a=>a.enabled!==false && a.id); if(!process.env.X_BEARER_TOKEN){ state.lastXStatus="Bearer Token eksik."; state.lastXCheck=nowIso(); broadcastState(); return; } if(!enabled.length){ state.lastXStatus="Aktif takip hesabı yok."; state.lastXCheck=nowIso(); broadcastState(); return; } pollInFlight=true; state.lastXStatus=`${enabled.length} hesap kontrol ediliyor…`; state.lastXCheck=nowIso(); broadcastState(); try{ const perQuery=Math.max(1,Math.min(10, Number(process.env.X_ACCOUNTS_PER_QUERY||8))); let count=0; for(const batch of chunk(enabled, perQuery)){ const posts=await searchBatch(batch); posts.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)); for(const p of posts){ addInbox(p); count++; } if(budgetStopped()) break; } state.lastXStatus=count ? `${count} yeni post alındı.` : `Yeni post yok.`; } catch(err){ state.lastXStatus=`Hata: ${err.message}`; } finally { pollInFlight=false; state.lastXCheck=nowIso(); broadcastState(); } }
function schedulePolling(){ if(pollTimer) clearTimeout(pollTimer); if(tracking.pollMode==="paused") return; const delay=tracking.pollMode==="live"?LIVE_POLL_MS:ECONOMY_POLL_MS; pollTimer=setTimeout(async ()=>{ await pollX(false); schedulePolling(); }, delay); }

const server = http.createServer((req,res)=>{
  const url=(req.url||"/").split("?")[0];
  if(url==="/api/state"){ res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}); return res.end(JSON.stringify(overlayPayload())); }
  if(url==="/api/health"){ res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}); return res.end(JSON.stringify({ ok:true, xConfigured:Boolean(process.env.X_BEARER_TOKEN), pollMode:tracking.pollMode, tracked:tracking.accounts.filter(a=>a.enabled!==false).length, estimatedUSD:estimatedCost() })); }
  const raw=decodeURIComponent(url); const normalized=path.normalize(raw).replace(/^(\.\.[/\\])+/,""); const file=path.join(PUBLIC_DIR, normalized==="/"?"admin.html":normalized);
  if(!file.startsWith(PUBLIC_DIR)){ res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(file,(err,stat)=>{ if(err||!stat.isFile()){ res.writeHead(404); return res.end("Not found"); } const ext=path.extname(file).toLowerCase(); const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8"}; res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","Cache-Control":"no-store"}); fs.createReadStream(file).pipe(res); });
});
const wss = new WebSocketServer({ server });
async function handleAction(msg, ws){ try{
  switch(msg.action){
    case "show": showPost(msg.post, msg.template||"news", msg.displayMode||"text"); break;
    case "enqueue": { const p=normalizePost(msg.post); p.template=msg.template||p.template||"news"; p.displayMode=msg.displayMode||p.displayMode||"text"; if(p.text && !state.queue.some(x=>x.id===p.id)) state.queue.push(p); broadcastState(); break; }
    case "pin": { const wasPinned=state.pinned; state.pinned=Boolean(msg.value); if(state.pinned) clearHideTimer(); else if(wasPinned && state.queue.length) setTimeout(showNext,250); else scheduleHide(); historyPush({type:state.pinned?"pin":"unpin"}); broadcastState(); break; }
    case "hide": state.visible=false; state.pinned=false; clearHideTimer(); historyPush({type:"hide"}); broadcastState(); break;
    case "next": showNext(); break;
    case "remove-inbox": removeById("inbox", msg.id); broadcastState(); break;
    case "remove-queue": removeById("queue", msg.id); broadcastState(); break;
    case "clear-inbox": state.inbox=[]; broadcastState(); break;
    case "clear-queue": state.queue=[]; broadcastState(); break;
    case "duration": state.durationMs=Math.min(120000, Math.max(5000, Number(msg.value||25000))); broadcastState(); scheduleHide(); break;
    case "position": if(["top-left","top-center","top-right","bottom-left","bottom-center","bottom-right"].includes(msg.value)) state.position=msg.value; broadcastState(); break;
    case "media-layout": if(["side","below"].includes(msg.value)) state.mediaLayout=msg.value; broadcastState(); break;
    case "video-muted": state.videoMuted=Boolean(msg.value); broadcastState(); break;
    case "video-volume": state.videoVolume=Math.max(0, Math.min(1, Number(msg.value||0))); broadcastState(); break;
    case "video-command": broadcast({ type:"video-command", command:String(msg.command||"") }); break;
    case "auto-next": state.autoNext=true; broadcastState(); break;
    case "poll-mode": if(["paused","economy","live"].includes(msg.value)){ tracking.pollMode=msg.value; saveTracking(); if(msg.fromNow!==false) resetCursors(); schedulePolling(); broadcastState(); if(msg.value!=="paused") await pollX(true); } break;
    case "tracking-options": tracking.includeReplies=Boolean(msg.includeReplies); tracking.includeRetweets=Boolean(msg.includeRetweets); tracking.autoQueue=true; if(Array.isArray(msg.blacklist)) tracking.blacklist=msg.blacklist.filter(Boolean); saveTracking(); resetCursors(); broadcastState(); break;
    case "add-account": { if(budgetStopped()) throw new Error("Yerel bütçe freni nedeniyle yeni hesap doğrulaması durduruldu."); const clean=cleanUsername(msg.username); if(!clean) throw new Error("Geçerli kullanıcı adı girin."); const exists=tracking.accounts.find(a=>a.username.toLowerCase()===clean.toLowerCase()); if(exists){ exists.enabled=true; saveTracking(); broadcastState(); break; } const profile=await lookupAccount(clean); tracking.accounts.push({ id:String(profile.id), username:cleanUsername(profile.username), name:String(profile.name||profile.username), avatar:String(profile.profile_image_url||""), enabled:true, tier:msg.tier||"reporter", group:msg.group||"Genel", addedAt:nowIso() }); saveTracking(); resetCursors(); historyPush({type:"account-add", username:clean}); state.lastXStatus=`@${clean} eklendi.`; broadcastState(); break; }
    case "remove-account": tracking.accounts=tracking.accounts.filter(a=>a.username.toLowerCase()!==cleanUsername(msg.username).toLowerCase()); saveTracking(); resetCursors(); broadcastState(); break;
    case "toggle-account": { const account=tracking.accounts.find(a=>a.username.toLowerCase()===cleanUsername(msg.username).toLowerCase()); if(account) account.enabled=Boolean(msg.enabled); saveTracking(); resetCursors(); broadcastState(); break; }
    case "refresh-x": await pollX(true); break;
    case "load-media": await loadMediaForPost(String(msg.id)); break;
    case "reset-usage": usage={ postReads:0,userReads:0,mediaReads:0,updatedAt:nowIso() }; writeJson(USAGE_FILE, usage); broadcastState(); break;
    case "manual-post": addInbox(normalizePost({ name:msg.name||"Haber Merkezi", username:msg.username||"sondakika", text:msg.text||"", group:msg.group||"Manuel", tier:"other", source:"manual" })); broadcastState(); break;
    case "clear-history": state.history=[]; broadcastState(); break;
  }
  } catch(err){ ws.send(JSON.stringify({ type:"error", message:err.message })); state.lastXStatus=`Hata: ${err.message}`; broadcastState(); }
}
wss.on("connection", ws=>{ ws.send(JSON.stringify({ type:"state", state:overlayPayload() })); ws.on("message", raw=>{ try{ handleAction(JSON.parse(raw.toString()), ws); }catch{} }); });
server.listen(PORT, "127.0.0.1", ()=>{ console.log('OBS X Son Dakika v4.1 hazır'); console.log(`Yönetim: http://127.0.0.1:${PORT}/admin.html`); console.log(`Overlay : http://127.0.0.1:${PORT}/overlay.html`); schedulePolling(); });
