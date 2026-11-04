/* Trader knowledge base: paste Instagram + YouTube links → transcript → trader page → rules.
   Uses the same keys as the transcriber (memKeys) plus the Neon database URL. */
(() => {
const KB_MAX = 50, KB_CONCURRENCY = 2;
let kbStop = false, apifyTurn = 0, traders = [], current = null;

const NS = "Not stated";
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- links ---------- */
function parseKbUrls(text){
  const parts = text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const out = [], seen = new Set(), skipped = [];
  for (const p of parts){
    let m, item = null;
    if ((m = p.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i))){
      const kind = m[1].toLowerCase() === "p" ? "p" : m[1].toLowerCase() === "tv" ? "tv" : "reel";
      item = {platform: "instagram", id: m[2], url: `https://www.instagram.com/${kind}/${m[2]}/`};
    } else if ((m = p.match(/(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i))){
      item = {platform: "youtube", id: m[1], url: `https://www.youtube.com/watch?v=${m[1]}`};
    }
    if (!item){ skipped.push(p); continue; }
    if (seen.has(item.url)){ skipped.push(p + " (duplicate)"); continue; }
    seen.add(item.url); out.push(item);
  }
  return {items: out, skipped};
}

function kbCounter(){
  const {items, skipped} = parseKbUrls($("kbUrls").value);
  const ig = items.filter(x => x.platform === "instagram").length, yt = items.length - ig, n = items.length;
  const c = $("kbCounter");
  c.textContent = n ? `${n} / ${KB_MAX} · ${ig} Instagram · ${yt} YouTube` : "0 links";
  c.className = "counter" + (n > KB_MAX ? " over" : n === 0 ? " zero" : "");
  $("kbUrls").classList.toggle("over", n > KB_MAX);
  const note = [], cn = $("kbCountNote");
  if (n > KB_MAX) note.push(`Too many links: ${n - KB_MAX} over the limit. Only the first ${KB_MAX} will be added.`);
  if (skipped.length) note.push(`${skipped.length} skipped (not an Instagram reel or YouTube video, or a duplicate).`);
  cn.textContent = note.join(" "); cn.hidden = !note.length; cn.className = "count-note" + (n > KB_MAX ? " over" : "");
  kbKeyUi();
}

function missingKeys(items){
  const miss = [];
  if (!memKeys.neon) miss.push("Neon database URL");
  if (!memKeys.groq.length) miss.push("Groq key");
  if (!memKeys.apify.length) miss.push("Apify token");
  if ((items || []).some(x => x.platform === "instagram") && !memKeys.hook) miss.push("Make webhook (for Instagram reels)");
  return miss;
}
window.kbKeyUi = function(){
  if (!$("kbMissing")) return;
  const miss = missingKeys(parseKbUrls($("kbUrls").value).items);
  $("kbMissing").hidden = !miss.length;
  $("kbMissingText").textContent = `Add your ${miss.join(", ")} in API keys to start.`;
};

/* ---------- API ---------- */
async function api(path, body, headers = {}){
  let res, data;
  try {
    res = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  } catch { return {ok: false, http: 0, error: "Network error. Check your connection.", retryAfter: 5}; }
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = {ok: false, error: res.status === 504 ? "The server took too long. Retrying." : "The server returned something unexpected.", retryAfter: res.status >= 500 ? 5 : undefined}; }
  data.http = res.status;
  return data;
}
// Optional Neon file storage: sent only when the user filled it in (all four values).
const s3Headers = () => { const o = memKeys.s3 || {}; return o.key && o.secret && o.endpoint && o.region
  ? {"x-neon-s3-key": o.key, "x-neon-s3-secret": o.secret, "x-neon-s3-endpoint": o.endpoint, "x-neon-s3-region": o.region, "x-neon-s3-bucket": o.bucket || "assets"} : {}; };
const kb = (body, headers = {}) => api("/api/kb", body, {"x-neon-url": memKeys.neon, ...s3Headers(), ...headers});

/* ---------- step 1: transcript ---------- */
async function getInstagram(item, say){
  const tries = Math.max(memKeys.groq.length, memKeys.apify.length);
  let last = "";
  for (let a = 0; a < tries; a++){
    const k = pickKeys(apifyTurn++, 0);
    say(`Transcribing the reel through your Make scenario${a ? ` (key set ${a + 1})` : ""}…`);
    const d = await api("/api/transcribe", {url: item.url}, {"x-groq-key": k.groq, "x-apify-key": k.apify, "x-make-webhook": memKeys.hook});
    if (d.ok){ try { recordUsage(k, d); } catch {} return d; }
    last = d.error || "Make couldn't process this reel.";
    if (d.http === 400) break;
  }
  throw new Error(last);
}
async function getYoutube(item, say){
  const n = memKeys.apify.length;
  let last = "";
  for (let a = 0; a < n; a++){
    const key = memKeys.apify[apifyTurn++ % n];
    say(`Reading YouTube captions with Apify${a ? ` (token ${a + 1})` : ""}… this takes 20–90 seconds.`);
    const d = await api("/api/youtube", {url: item.url}, {"x-apify-key": key});
    if (d.ok) return d;
    last = d.error || "Couldn't read this video.";
    if (d.code !== "apifykey" && d.http !== 502) break;
  }
  throw new Error(last);
}

/* ---------- step 3: Groq key pool ----------
   One part (chunk) of a video goes to ONE key for all three of its calls (translate, extract, verify).
   The next part goes to the next key, round and round, so a long video uses every key at once.
   A key rests between parts and between calls so it stays inside Groq's per-minute token limit
   (free tier: about 8,000 tokens per minute per key for this model; the real numbers come back in
   Groq's response headers and are used when present). A 429 puts that key to sleep for the time Groq
   asks, and the part moves to another key. A per-day limit parks the key until it resets. */
const TPM = 8000;                  // free-tier tokens/min per key (gpt-oss-120b), used only when headers are missing
const GAP_MIN = 60000, GAP_MAX = 120000; // rest between two parts on the same key: 1 to 2 minutes
const CALL_FLOOR = 5000, CALL_CAP = 120000; // min / max wait between two calls on the same key
const pool = {keys: [], turn: 0};
const nowMs = () => Date.now();
const fmtWait = ms => { const s = Math.ceil(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`; };
function poolSync(){
  pool.keys = memKeys.groq.map((key, i) => { const old = pool.keys.find(k => k.key === key);
    return Object.assign(old || {key, busy: false, free: 0, blocked: 0, dead: false, daily: false, gap: GAP_MIN, pace: 1}, {n: i + 1}); });
}
async function nap(ms, say, text){
  const end = nowMs() + ms;
  while (nowMs() < end){
    if (kbStop) throw new Error("Stopped. Paste the link again, or press Retry, to carry on.");
    if (say && text) say(`${text} ${fmtWait(end - nowMs())}…`);
    await sleep(Math.min(1000, Math.max(100, end - nowMs())));
  }
}
async function acquireKey(say){
  for (;;){
    if (kbStop) throw new Error("Stopped. Paste the link again, or press Retry, to carry on.");
    poolSync();
    const live = pool.keys.filter(k => !k.dead);
    if (!live.length){ const e = new Error("Groq rejected every key you added. Check them in API keys."); e.code = "keys"; throw e; }
    const t = nowMs(), n = pool.keys.length;
    for (let i = 0; i < n; i++){
      const k = pool.keys[(pool.turn + i) % n];
      if (!k.dead && !k.busy && Math.max(k.free, k.blocked) <= t){ k.busy = true; pool.turn = (pool.turn + i + 1) % n; return k; }
    }
    const idle = live.filter(k => !k.busy);
    if (idle.length && idle.every(k => k.daily)){
      const wait = Math.min(...idle.map(k => k.blocked)) - t;
      if (wait > 10 * 60000 && live.every(k => k.daily)){ const e = new Error(`Every Groq key has reached its daily limit. They reset in about ${fmtWait(wait)}. Press Retry then, nothing is lost.`); e.code = "daily"; throw e; }
    }
    const next = Math.min(...live.map(k => k.busy ? Infinity : Math.max(k.free, k.blocked)));
    say(next === Infinity ? "Waiting for a free Groq key…" : `All Groq keys are resting. Next one is free in ${fmtWait(next - t)}…`);
    await sleep(1000);
  }
}
const durMs = txt => { const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(String(txt || "")); return m && (m[1] || m[2] || m[3] || m[4]) ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0) : null; };
// After a call: decide when this key may be used again, from Groq's own numbers when we have them.
function afterCall(k, u){
  const reserved = (u && (u.reserved || u.total_tokens)) || TPM, L = (u && u.limits) || {};
  let wait = Math.min(1, reserved / TPM) * 60000;                      // fallback: the tokens this call used up of one minute
  if (L.remainTok != null){ const reset = durMs(L.resetTok); wait = L.remainTok >= reserved * 1.1 ? CALL_FLOOR : (reset != null ? reset + 1000 : wait); }
  k.free = nowMs() + Math.min(CALL_CAP, Math.max(CALL_FLOOR, wait * k.pace));
  k.pace = Math.max(1, k.pace * .9);
}
function rateLimited(k, d){
  const wait = Math.max(5, d.retryAfter || 20) * 1000;
  k.blocked = nowMs() + wait; k.daily = !!d.daily;
  k.pace = Math.min(2.5, k.pace * 1.5); k.gap = Math.min(GAP_MAX, k.gap * 1.5);
}
function releaseKey(k, ok){
  k.busy = false;
  if (ok) k.gap = Math.max(GAP_MIN, k.gap * .85);
  k.free = Math.max(k.free, nowMs() + k.gap);                           // 1 to 2 minutes of rest before the next part
  if (k.daily && k.blocked <= nowMs()) k.daily = false;
}
// Runs all calls for one part on one key. Moves to another key only when this one is rate-limited or rejected.
async function runChunk(chunk, say){
  let status = chunk.status, tries = 0;
  const STEP = {pending: "Translating to English", translated: "Extracting rules", extracted: "Verifying every rule against the transcript"};
  while (status !== "done"){
    const k = await acquireKey(say);
    let ok = true;
    try {
      while (status !== "done"){
        const wait = k.free - nowMs();
        if (wait > 0) await nap(wait, say, `Key ${k.n} is resting to stay inside Groq's per-minute limit:`);
        say(`Key ${k.n}: ${STEP[status] || "Working"}…`);
        const d = await kb({action: "step", chunkId: chunk.id}, {"x-groq-key": k.key});
        if (d.ok){ const same = d.status === status; status = d.status; afterCall(k, d.usage); if (same && ++tries > 3) throw new Error("This part isn't moving forward."); if (!same) tries = 0; continue; }
        if (d.code === "keys"){ const e = new Error(d.error); e.code = "keys"; throw e; }
        if (d.code === "groqkey"){ k.dead = true; ok = false; say(`Groq rejected key ${k.n}. Moving this part to another key…`); break; }
        if (d.http === 429){ rateLimited(k, d); ok = false; say(d.daily ? `Key ${k.n} reached its daily limit. Moving this part to another key…` : `Key ${k.n} hit Groq's rate limit. Moving this part to another key…`); break; }
        if (++tries > 6) throw new Error(d.error || "This part keeps failing.");
        await nap(Math.min(15, d.retryAfter || 5) * 1000, say, `${d.error || "Something went wrong."} Trying again in`);
        if (tries % 3 === 0){ ok = false; break; }   // after three failures on this key, try another one
      }
    } finally { releaseKey(k, ok); }
  }
}
// Runs every unfinished part of a source. Up to one part per usable key runs at once.
async function runChunks(chunks, say, onProgress){
  const todo = chunks.filter(c => c.status !== "done"), total = chunks.length;
  let next = 0, done = total - todo.length, fatal = null; const failures = [];
  onProgress && onProgress(done, total);
  poolSync();
  const width = Math.max(1, Math.min(todo.length, pool.keys.filter(k => !k.dead).length));
  async function worker(){
    while (!fatal && !kbStop && next < todo.length){
      const c = todo[next++], n = chunks.indexOf(c) + 1;
      try { await runChunk(c, t => say(`Part ${n} of ${total} · ${t}`)); done++; onProgress && onProgress(done, total); }
      catch (e){ if (e.code === "keys" || e.code === "daily") fatal = fatal || e; else if (kbStop) { fatal = fatal || e; } else failures.push(`Part ${n}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({length: width}, worker));
  return {fatal, failures, done, total};
}

/* ---------- one link, start to finish ---------- */
async function processItem(item, ui){
  const say = (t, cls = "") => { ui.msg.textContent = t; ui.msg.className = "msg " + cls; };
  let src;
  if (item.platform === "instagram"){
    const r = await getInstagram(item, say);
    const ai = r.ai || {};
    const lang = (ai.language || r.detectedLanguage || "").trim();
    const english = /^en(glish)?$/i.test(lang) ? (r.transcript || ai.english_script || "") : (ai.english_script || "");
    say("Saving the transcript to your knowledge base…");
    src = await kb({action: "ingest", platform: "instagram", url: item.url, handle: r.owner || "unknown", displayName: r.owner || "",
      accountUrl: r.owner ? `https://www.instagram.com/${r.owner}/` : "", traderId: $("kbFile").value || undefined,
      title: ai.title || "", caption: r.caption || "", language: lang, duration: r.duration, thumbnail: r.thumbnail || "",
      transcript: r.transcript || "", english});
  } else {
    const r = await getYoutube(item, say);
    say(`Saving ${r.segments.length} caption lines to your knowledge base…`);
    src = await kb({action: "ingest", platform: "youtube", url: item.url, handle: r.handle, displayName: r.channelName,
      accountUrl: r.channelUrl, traderId: $("kbFile").value || undefined, title: r.title, caption: r.description,
      language: r.language, duration: r.duration, thumbnail: r.thumbnail, segments: r.segments});
  }
  if (!src.ok){ const e = new Error(src.error || "Couldn't save to the database."); e.code = src.code; throw e; }
  ui.title.textContent = `${src.traderName}` ;
  ui.chip.textContent = src.existing ? "Already saved · resuming" : src.newTrader ? "New trader" : "Added to trader";
  if (src.newTrader) await offerMerge(ui, src);

  const run = await runChunks(src.chunks, say, (d, t) => { ui.bar.style.width = `${Math.round(d / t * 100)}%`; });
  if (run.fatal || run.failures.length){
    await kb({action: "finish", sourceId: src.sourceId});          // keep what was finished, so Retry carries on from here
    throw run.fatal || new Error(`${run.failures.length} of ${run.total} parts failed. ${run.failures[0]}`);
  }
  ui.bar.style.width = "100%";
  const f = await kb({action: "finish", sourceId: src.sourceId});
  if (!f.ok) throw new Error(f.error);
  say(`${f.rules} rules saved${f.flagged ? `, ${f.flagged} need your review` : ", all verified against the transcript"}.`, "");
  ui.chip.textContent = "Done"; ui.chip.className = "chip ok";
  const open = el("button", {type: "button"}, `Open ${src.traderName}`);
  open.addEventListener("click", () => openTrader(src.traderId));
  ui.actions.prepend(open);
  return src;
}

async function offerMerge(ui, src){
  try { await loadTraders(); } catch {}
  const others = traders.filter(t => t.id !== src.traderId);
  if (!others.length) return;
  const sel = el("select", {"aria-label": "Existing trader"}, el("option", {value: ""}, "Same person as…"));
  others.forEach(t => sel.append(el("option", {value: t.id}, t.name)));
  const btn = el("button", {type: "button"}, "Merge");
  const box = el("div", {class: "merge"}, el("span", {}, `New trader page created for ${src.traderName}.`), sel, btn);
  btn.addEventListener("click", async () => {
    if (!sel.value) return;
    btn.disabled = true;
    const d = await kb({action: "merge", fromId: src.traderId, intoId: +sel.value});
    box.textContent = d.ok ? `Merged into ${sel.selectedOptions[0].textContent}. Future links from this account go there too.` : (d.error || "Couldn't merge.");
    loadTraders();
  });
  ui.actions.append(box);
}

async function startKb(){
  const {items: all} = parseKbUrls($("kbUrls").value);
  const notice = $("kbNotice");
  const miss = missingKeys(all);
  if (miss.length){ kbKeyUi(); openDrawer(); return; }
  if (!all.length){ notice.hidden = false; notice.textContent = "No Instagram reel or YouTube links found."; return; }
  const items = all.slice(0, KB_MAX);
  notice.hidden = all.length <= KB_MAX; notice.textContent = `Only the first ${KB_MAX} links will be added.`;
  const init = await kb({action: "init"});
  if (!init.ok){ notice.hidden = false; notice.textContent = init.error; if (init.code === "keys") openDrawer(); return; }

  kbStop = false;
  $("kbGo").disabled = true; $("kbStop").hidden = false;
  const jobs = $("kbJobs"); jobs.textContent = "";
  const uis = items.map((it, i) => {
    const chip = el("span", {class: "chip"}, "Waiting");
    const title = el("b", {}, it.url);
    const msg = el("p", {class: "msg"}, "Waiting for a free slot…");
    const barI = el("i"); const bar = el("div", {class: "bar"}, barI);
    const actions = el("div", {class: "row"});
    const card = el("article", {class: "job"},
      el("div", {class: "job-head"}, el("span", {class: "num"}, i + 1), el("div", {class: "t"}, title, el("div", {class: "url"}, el("span", {class: "plat"}, it.platform), " ", it.url)), chip),
      msg, bar, actions);
    jobs.append(card);
    return {chip, title, msg, bar: barI, actions};
  });
  let done = 0, failed = 0;
  const failedIdx = new Set();
  const status = () => $("kbStatus").textContent = `${done} done${failed ? `, ${failed} failed` : ""} of ${items.length}`;
  status();
  const busy = () => $("kbGo").disabled;                          // a run is in progress
  const setRetryEnabled = () => uis.forEach(u => { if (u.retry) u.retry.disabled = busy(); });
  function fail(i, message, code){
    const ui = uis[i];
    failed++; failedIdx.add(i); ui.chip.textContent = "Failed"; ui.chip.className = "chip bad";
    ui.msg.textContent = message || "Something went wrong."; ui.msg.className = "msg err";
    if (!ui.retry){
      ui.retry = el("button", {type: "button", class: "primary"}, "Retry");
      ui.retry.addEventListener("click", async () => {
        kbStop = false; $("kbGo").disabled = true; $("kbStop").hidden = false; $("kbRetryAll").hidden = true; setRetryEnabled();
        await runOne(i);
        $("kbGo").disabled = false; $("kbStop").hidden = true; setRetryEnabled(); syncRetryAll(); status();
      });
      ui.actions.prepend(ui.retry);
    }
    ui.retry.disabled = busy();
    if (code === "keys"){ kbStop = true; openDrawer(); }
  }
  async function runOne(i){
    const ui = uis[i];
    if (ui.retry){ ui.retry.remove(); ui.retry = null; }
    if (failedIdx.delete(i)) failed--;
    ui.chip.textContent = "Working"; ui.chip.className = "chip run"; ui.msg.className = "msg";
    try { await processItem(items[i], ui); done++; }
    catch (e){ fail(i, e && e.message, e && e.code); }
    status(); loadTraders();
  }
  function syncRetryAll(){ $("kbRetryAll").hidden = failedIdx.size === 0 || busy(); }
  async function runQueue(list){
    let k = 0;
    async function w(){ while (k < list.length){ const i = list[k++]; if (kbStop){ fail(i, "Not started because the run was stopped."); continue; } await runOne(i); } }
    await Promise.all(Array.from({length: Math.min(KB_CONCURRENCY, list.length)}, w));
  }
  $("kbRetryAll").onclick = async () => {
    kbStop = false; $("kbGo").disabled = true; $("kbStop").hidden = false; $("kbRetryAll").hidden = true; setRetryEnabled();
    await runQueue([...failedIdx].sort((a, b) => a - b));
    $("kbGo").disabled = false; $("kbStop").hidden = true; setRetryEnabled(); syncRetryAll(); status();
  };
  await runQueue(items.map((_, i) => i));
  $("kbGo").disabled = false; $("kbStop").hidden = true;
  setRetryEnabled(); status(); syncRetryAll();
  try { refreshApify(); } catch {}
}

/* ---------- traders list ---------- */
async function loadTraders(){
  const list = $("traderList");
  if (!memKeys.neon){ list.textContent = ""; list.append(el("p", {class: "hint"}, "Add your Neon database URL in API keys to see your traders.")); fillFileUnder(); return; }
  $("tStamp").textContent = "Loading…";
  const d = await kb({action: "traders"});
  if (!d.ok){ $("tStamp").textContent = ""; list.textContent = ""; list.append(el("p", {class: "err"}, d.error)); return; }
  traders = d.traders;
  $("tStamp").textContent = `${traders.length} trader${traders.length === 1 ? "" : "s"}`;
  list.textContent = "";
  if (!traders.length) list.append(el("p", {class: "hint"}, "No traders yet. Paste links above and they'll appear here."));
  for (const t of traders){
    const acc = (t.accounts || []).map(a => a.platform === "instagram" ? "Instagram @" + a.handle : "YouTube " + (a.display_name || a.handle)).join(" · ");
    const card = el("button", {class: "tcard", type: "button"}, el("strong", {}, t.name), el("span", {class: "acc"}, acc || "No accounts"),
      el("div", {class: "stats"}, el("span", {class: "stat"}, `${t.sources} sources`), el("span", {class: "stat ok"}, `${t.rules - t.flagged} verified rules`),
        t.flagged ? el("span", {class: "stat warn"}, `${t.flagged} to review`) : null));
    card.addEventListener("click", () => openTrader(t.id));
    list.append(card);
  }
  fillFileUnder();
}
function fillFileUnder(){
  const sel = $("kbFile"), v = sel.value;
  sel.textContent = "";
  sel.append(el("option", {value: ""}, "Detect trader from the account or channel"));
  traders.forEach(t => sel.append(el("option", {value: t.id}, t.name)));
  sel.value = traders.some(t => String(t.id) === v) ? v : "";
}
window.loadTraders = loadTraders;

/* ---------- trader page ---------- */
const fmtTs = s => { if (s == null) return ""; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
const tsLink = (src, sec) => src && src.platform === "youtube" && sec != null ? `${src.url}&t=${Math.floor(sec)}s` : src ? src.url : "";

async function openTrader(id, tab){
  showView("trader", "#trader-" + id);
  const v = $("viewTrader");
  v.textContent = ""; v.append(el("p", {class: "status"}, "Loading trader…"));
  const d = await kb({action: "trader", id});
  if (!d.ok){ v.textContent = ""; v.append(backBtn(), el("p", {class: "err"}, d.error)); return; }
  if (!traders.length) { try { await loadTraders(); } catch {} }
  current = d; current.tab = tab || "rules"; current.filter = {q: "", concept: "", review: false};
  renderTrader();
}
window.openTrader = openTrader;
function backBtn(){ const b = el("button", {class: "back", type: "button"}, "← All traders"); b.addEventListener("click", () => showView("kb")); return b; }

function renderTrader(){
  const d = current, v = $("viewTrader");
  const flagged = d.rules.filter(r => !r.verified).length;
  v.textContent = "";
  const accs = el("div", {class: "stats"});
  d.accounts.forEach(a => accs.append(el("a", {class: "stat", href: a.url || (a.platform === "instagram" ? `https://www.instagram.com/${a.handle}/` : "#"), target: "_blank", rel: "noopener"},
    a.platform === "instagram" ? "Instagram @" + a.handle : "YouTube " + (a.display_name || a.handle))));
  const head = el("header", {class: "thead"}, backBtn(), el("h1", {}, d.trader.name), accs,
    el("div", {class: "stats"}, el("span", {class: "stat"}, `${d.sources.length} sources`), el("span", {class: "stat ok"}, `${d.rules.length - flagged} verified rules`),
      flagged ? el("span", {class: "stat warn"}, `${flagged} need review`) : null));
  const copy = el("button", {class: "primary", type: "button"}, "Copy knowledge base");
  copy.addEventListener("click", () => copyText(buildMarkdown(d), copy));
  const dl = el("button", {type: "button"}, "Download .md");
  dl.addEventListener("click", () => {
    const blob = new Blob([buildMarkdown(d)], {type: "text/markdown"});
    const a = el("a", {href: URL.createObjectURL(blob), download: d.trader.name.replace(/[^\w-]+/g, "_") + "_knowledge_base.md"});
    document.body.append(a); a.click(); a.remove();
  });
  const tabs = el("div", {class: "tabs", role: "tablist"});
  [["rules", "Rules"], ["graph", "Knowledge graph"], ["sources", "Sources & transcripts"], ["manage", "Manage"]].forEach(([k, label]) => {
    const b = el("button", {class: "tab", type: "button", role: "tab", "aria-selected": String(d.tab === k)}, label);
    b.addEventListener("click", () => { d.tab = k; renderTrader(); });
    tabs.append(b);
  });
  const bar = el("div", {class: "toolbar"}, copy, dl, tabs);
  const body = el("div", {class: "list"});
  if (d.tab === "rules") renderRules(body); else if (d.tab === "graph") renderGraph(body); else if (d.tab === "sources") renderSources(body); else renderManage(body);
  v.append(head, bar, body);
}

const srcIndex = d => { const m = new Map(); d.sources.forEach((s, i) => m.set(s.id, {...s, n: i + 1})); return m; };
const groupByConcept = rules => { const g = new Map(); rules.forEach(r => { const k = r.concept || "General"; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }); return [...g.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])); };

function renderRules(body){
  const d = current, f = d.filter, sources = srcIndex(d);
  const search = el("input", {type: "search", placeholder: "Search rules, quotes, indicators…", "aria-label": "Search rules"}); search.value = f.q;
  const conceptSel = el("select", {"aria-label": "Concept"}, el("option", {value: ""}, "All concepts"));
  groupByConcept(d.rules).forEach(([c, rs]) => conceptSel.append(el("option", {value: c}, `${c} (${rs.length})`))); conceptSel.value = f.concept;
  const rev = el("input", {type: "checkbox"}); rev.checked = f.review;
  const filters = el("div", {class: "filters"}, search, conceptSel, el("label", {class: "row hint"}, rev, " Only rules to review"));
  const out = el("div", {class: "list"});
  const draw = () => {
    out.textContent = "";
    const q = f.q.toLowerCase();
    let rules = d.rules.filter(r => (!f.concept || r.concept === f.concept) && (!f.review || !r.verified) && (!q || JSON.stringify(r).toLowerCase().includes(q)));
    if (!d.rules.length){ out.append(el("div", {class: "empty"}, "No rules yet. Add this trader's reels or videos on the Knowledge base page.")); return; }
    if (!rules.length){ out.append(el("p", {class: "hint"}, "No rules match.")); return; }
    let n = 0; const num = new Map(d.rules.map((r, i) => [r.id, i + 1]));
    for (const [concept, rs] of groupByConcept(rules)){
      const sec = el("section", {class: "concept"}, el("h2", {}, `${concept} `, el("span", {class: "stat"}, rs.length)));
      rs.forEach(r => sec.append(ruleCard(r, num.get(r.id), sources.get(r.source_id))));
      out.append(sec); n += rs.length;
    }
  };
  search.addEventListener("input", () => { f.q = search.value; draw(); });
  conceptSel.addEventListener("change", () => { f.concept = conceptSel.value; draw(); });
  rev.addEventListener("change", () => { f.review = rev.checked; draw(); });
  body.append(filters, out); draw();
}

function ruleCard(r, n, src){
  const card = el("article", {class: "rule" + (r.verified ? "" : " flag")});
  card.append(el("div", {class: "rule-head"}, el("span", {class: "num"}, "R" + n), el("h3", {}, r.title || "Untitled rule"),
    el("span", {class: "chip"}, r.category), el("span", {class: "chip " + (r.verified ? "ok" : "run")}, r.verified ? "Verified against transcript" : "Needs review")));
  if (r.rule) card.append(el("p", {class: "stmt"}, r.rule));
  if (!r.verified && r.review_note) card.append(el("p", {class: "review"}, r.review_note));
  if (r.explanation) card.append(el("div", {}, el("span", {class: "label"}, "Explanation"), el("p", {class: "expl"}, r.explanation)));
  if ((r.conditions || []).length){ const ul = el("ul"); r.conditions.forEach(c => ul.append(el("li", {}, c))); card.append(el("div", {}, el("span", {class: "label"}, "Conditions"), ul)); }
  const kv = el("dl", {class: "kv"});
  [["Entry", r.entry], ["Stop loss", r.stop_loss], ["Target", r.target], ["Invalidation", r.invalidation], ["Timeframe", r.timeframe], ["Instruments", r.instruments]]
    .forEach(([k, val]) => kv.append(el("dt", {}, k), el("dd", {class: !val || val === NS ? "ns" : ""}, val || NS)));
  const ind = (r.indicators || []).map(i => i.settings && i.settings !== NS ? `${i.name} (${i.settings})` : `${i.name} (settings not stated)`).join(", ");
  kv.append(el("dt", {}, "Indicators"), el("dd", {class: ind ? "" : "ns"}, ind || NS));
  if ((r.related || []).length) kv.append(el("dt", {}, "Related"), el("dd", {}, r.related.join(", ")));
  card.append(kv);
  if ((r.ambiguities || []).length){ const ul = el("ul"); r.ambiguities.forEach(c => ul.append(el("li", {}, c))); card.append(el("div", {}, el("span", {class: "label"}, "Not specified by the trader"), ul)); }
  if (r.quote) card.append(el("blockquote", {}, `“${r.quote}”`));
  if (src) card.append(el("div", {class: "url"}, el("a", {href: tsLink(src, r.timestamp_sec), target: "_blank", rel: "noopener"}, `Source S${src.n}: ${src.title || src.url}${r.timestamp_sec != null ? " at " + fmtTs(r.timestamp_sec) : ""}`)));
  return card;
}

function renderSources(body){
  const d = current;
  if (!d.sources.length){ body.append(el("div", {class: "empty"}, "No sources yet.")); return; }
  d.sources.forEach((s, i) => {
    const img = s.thumbnail ? el("img", {src: s.thumbnail, alt: "", class: s.platform === "youtube" ? "yt" : "", loading: "lazy"}) : el("span", {class: "plat"}, s.platform);
    const nRules = d.rules.filter(r => r.source_id === s.id).length;
    const facts = el("div", {class: "facts"},
      el("div", {}, el("span", {class: "num"}, "S" + (i + 1)), " ", el("strong", {}, s.title || "Untitled")),
      el("div", {class: "stats"}, el("span", {class: "plat"}, s.platform), s.language ? el("span", {class: "stat"}, s.language) : null,
        s.duration_sec ? el("span", {class: "stat"}, fmtTs(s.duration_sec)) : null, el("span", {class: "stat"}, `${nRules} rules`),
        el("span", {class: "stat " + (s.status === "done" ? "ok" : "warn")}, s.status === "done" ? "Complete" : `${s.parts_done} of ${s.parts} parts done`)),
      el("a", {href: s.url, target: "_blank", rel: "noopener", class: "url"}, s.url));
    if (s.notes) facts.append(el("p", {class: "hint"}, s.notes));
    const same = !s.english || s.english.trim() === s.transcript.trim();
    facts.append(el("details", {}, el("summary", {}, same ? "Full transcript" : "Full transcript (English)"), el("div", {class: "script"}, s.english || s.transcript || "(empty)")));
    if (!same) facts.append(el("details", {}, el("summary", {}, `Original transcript (${s.language || "original language"})`), el("div", {class: "script"}, s.transcript)));
    const redo = el("button", {type: "button"}, s.status === "done" ? "Re-extract rules" : "Finish extracting");
    redo.addEventListener("click", () => reExtract(s, redo));
    const del = el("button", {type: "button", class: "bad"}, "Delete source");
    del.addEventListener("click", async () => { if (!confirm(`Delete this source and its ${nRules} rules?`)) return; const r = await kb({action: "deleteSource", sourceId: s.id}); if (r.ok) openTrader(d.trader.id, "sources"); });
    facts.append(el("div", {class: "row"}, redo, del));
    body.append(el("article", {class: "src"}, el("div", {}, img), facts));
  });
}

async function reExtract(s, btn){
  if (!memKeys.groq.length){ openDrawer(); return; }
  btn.disabled = true; kbStop = false;
  let chunks;
  if (s.status === "done"){
    if (!confirm("Delete this source's rules and extract them again?")) { btn.disabled = false; return; }
    const r = await kb({action: "reprocess", sourceId: s.id}); if (!r.ok){ btn.textContent = r.error; return; } chunks = r.chunks;
  } else {
    const r = await kb({action: "ingest", platform: s.platform, url: s.url}); if (!r.ok){ btn.textContent = r.error; return; } chunks = r.chunks;
  }
  try {
    const run = await runChunks(chunks, t => btn.textContent = t);
    await kb({action: "finish", sourceId: s.id});
    if (run.fatal) throw run.fatal;
    if (run.failures.length) throw new Error(`${run.failures.length} of ${run.total} parts failed. ${run.failures[0]}`);
    openTrader(current.trader.id, "sources");
  } catch (e){ btn.disabled = false; btn.textContent = "Retry: " + e.message; btn.title = e.message; }
}

function renderManage(body){
  const d = current;
  const name = el("input", {type: "text", "aria-label": "Trader name"}); name.value = d.trader.name;
  name.className = "field"; name.style.cssText = "border:1px solid var(--line);border-radius:8px;padding:9px 12px;background:var(--bg);color:var(--ink);font:inherit;flex:1 1 220px;min-width:0";
  const save = el("button", {type: "button"}, "Rename");
  save.addEventListener("click", async () => { const r = await kb({action: "rename", traderId: d.trader.id, name: name.value}); if (r.ok){ d.trader.name = name.value.trim(); renderTrader(); loadTraders(); } });
  const sel = el("select", {"aria-label": "Merge into"}, el("option", {value: ""}, "Choose a trader…"));
  traders.filter(t => t.id !== d.trader.id).forEach(t => sel.append(el("option", {value: t.id}, t.name)));
  const merge = el("button", {type: "button"}, "Merge");
  merge.addEventListener("click", async () => {
    if (!sel.value || !confirm(`Move all of ${d.trader.name}'s accounts, sources and rules into ${sel.selectedOptions[0].textContent}?`)) return;
    const r = await kb({action: "merge", fromId: d.trader.id, intoId: +sel.value}); if (r.ok){ await loadTraders(); openTrader(+sel.value); }
  });
  const del = el("button", {type: "button", class: "bad"}, "Delete trader");
  del.addEventListener("click", async () => {
    if (!confirm(`Delete ${d.trader.name} with all ${d.sources.length} sources and ${d.rules.length} rules? This can't be undone.`)) return;
    const r = await kb({action: "deleteTrader", traderId: d.trader.id}); if (r.ok) showView("kb");
  });
  body.append(
    el("section", {class: "danger"}, el("h2", {}, "Name"), el("div", {class: "row"}, name, save)),
    el("section", {class: "danger"}, el("h2", {}, "Same person as another trader?"), el("p", {class: "hint"}, "For example, an Instagram handle and a YouTube channel that belong to the same trader. Merging moves everything into one page, and future links from both accounts are filed there."), el("div", {class: "row"}, sel, merge)),
    el("section", {class: "danger"}, el("h2", {}, "Delete"), el("div", {class: "row"}, del)));
}

/* ---------- knowledge graph (concepts the trader uses and how they connect) ---------- */
function renderGraph(body){
  const d = current;
  if (!d.rules.length){ body.append(el("div", {class: "empty"}, "The graph appears once this trader has rules.")); return; }
  const nodes = new Map(), edges = new Map();
  const node = (id, kind) => { if (!nodes.has(id)) nodes.set(id, {id, kind, n: 0, x: 0, y: 0, vx: 0, vy: 0}); return nodes.get(id); };
  const edge = (a, b) => { if (a === b) return; const k = [a, b].sort().join("\u0000"); edges.set(k, (edges.get(k) || 0) + 1); };
  const root = node(d.trader.name, "trader");
  d.rules.forEach(r => { node(r.concept || "General", "concept").n++; });
  d.rules.forEach(r => {
    const c = node(r.concept || "General", "concept");
    edge(root.id, c.id);
    (r.related || []).forEach(x => { const rel = [...nodes.keys()].find(k => k.toLowerCase() === String(x).toLowerCase()) || x; const o = node(rel, nodes.get(rel) ? nodes.get(rel).kind : "related"); if (o.kind === "related") o.n++; edge(c.id, o.id); });
  });
  let list = [...nodes.values()];
  if (list.length > 70){ const keep = new Set(list.filter(x => x.kind !== "related").map(x => x.id).concat(list.filter(x => x.kind === "related").sort((a, b) => b.n - a.n).slice(0, 25).map(x => x.id))); list = list.filter(x => keep.has(x.id)); }
  const ids = new Set(list.map(x => x.id));
  const E = [...edges.entries()].map(([k, w]) => { const [a, b] = k.split("\u0000"); return {a: nodes.get(a), b: nodes.get(b), w}; }).filter(e => ids.has(e.a.id) && ids.has(e.b.id));
  const W = 900, H = 620;
  list.forEach((p, i) => { const ang = i * 2.399963; const rad = p.kind === "trader" ? 0 : 120 + 12 * Math.sqrt(i) * 6; p.x = W / 2 + Math.cos(ang) * rad; p.y = H / 2 + Math.sin(ang) * rad; });
  for (let it = 0; it < 400; it++){
    const t = 1 - it / 400;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++){
      const p = list[i], q = list[j]; let dx = p.x - q.x, dy = p.y - q.y; const d2 = dx * dx + dy * dy + 0.01; const f = 5200 / d2;
      const dd = Math.sqrt(d2); dx /= dd; dy /= dd; p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
    }
    E.forEach(e => { const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, dist = Math.sqrt(dx * dx + dy * dy) || 1; const target = e.a.kind === "trader" || e.b.kind === "trader" ? 190 : 110; const f = (dist - target) * 0.02; e.a.vx += dx / dist * f; e.a.vy += dy / dist * f; e.b.vx -= dx / dist * f; e.b.vy -= dy / dist * f; });
    list.forEach(p => { if (p.kind === "trader"){ p.x = W / 2; p.y = H / 2; p.vx = p.vy = 0; return; } p.vx += (W / 2 - p.x) * 0.002; p.vy += (H / 2 - p.y) * 0.002; p.x += Math.max(-20, Math.min(20, p.vx)) * t; p.y += Math.max(-20, Math.min(20, p.vy)) * t; p.vx *= 0.5; p.vy *= 0.5; p.x = Math.max(60, Math.min(W - 60, p.x)); p.y = Math.max(30, Math.min(H - 30, p.y)); });
  }
  const NSV = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs) => { const e = document.createElementNS(NSV, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const xs = list.map(p => p.x), ys = list.map(p => p.y);
  const bw = Math.max(760, Math.max(...xs) - Math.min(...xs) + 220), bh = Math.max(460, Math.max(...ys) - Math.min(...ys) + 120);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const svg = sv("svg", {viewBox: `${cx - bw / 2} ${cy - bh / 2} ${bw} ${bh}`, role: "img", "aria-label": `Knowledge graph of ${d.trader.name}'s concepts`});
  const cs = getComputedStyle(document.documentElement);
  const col = {trader: cs.getPropertyValue("--ink"), concept: cs.getPropertyValue("--accent"), related: cs.getPropertyValue("--blue")};
  E.forEach(e => svg.append(sv("line", {x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y, stroke: cs.getPropertyValue("--line"), "stroke-width": Math.min(6, 1 + e.w * 0.6)})));
  list.forEach(p => {
    const r = p.kind === "trader" ? 16 : p.kind === "concept" ? 7 + Math.min(14, Math.sqrt(p.n) * 3) : 5;
    const g = sv("g", {class: p.kind === "concept" ? "gnode" : "", tabindex: p.kind === "concept" ? "0" : "-1"});
    const title = sv("title", {}); title.textContent = p.kind === "concept" ? `${p.id}: ${p.n} rules. Click to see them.` : p.kind === "related" ? `${p.id} (mentioned in related rules)` : p.id;
    g.append(title, sv("circle", {cx: p.x, cy: p.y, r, fill: col[p.kind], "fill-opacity": p.kind === "related" ? .55 : 1}));
    const tx = sv("text", {x: p.x, y: p.y - r - 5, "text-anchor": "middle"}); tx.textContent = p.id.length > 28 ? p.id.slice(0, 27) + "…" : p.id; g.append(tx);
    if (p.kind === "concept"){ const go = () => { d.filter.concept = p.id; d.tab = "rules"; renderTrader(); }; g.addEventListener("click", go); g.addEventListener("keydown", e => { if (e.key === "Enter") go(); }); }
    svg.append(g);
  });
  body.append(el("div", {class: "graph"}, svg, el("p", {class: "hint"}, "Green circles are concepts this trader teaches (bigger means more rules). Blue circles are concepts his rules depend on. Lines show which concepts are used together. Click a concept to see its rules.")));
}

/* ---------- Copy knowledge base (Markdown for AI) ---------- */
function buildMarkdown(d){
  const S = srcIndex(d), L = [];
  const flagged = d.rules.filter(r => !r.verified).length;
  L.push(`# ${d.trader.name}: trading knowledge base`, "");
  L.push(`Accounts: ${d.accounts.map(a => a.platform === "instagram" ? `Instagram @${a.handle} (https://www.instagram.com/${a.handle}/)` : `YouTube ${a.display_name || a.handle}${a.url ? ` (${a.url})` : ""}`).join(", ") || "none"}`);
  L.push(`Built ${new Date().toISOString().slice(0, 10)} from ${d.sources.length} sources. ${d.rules.length} rules: ${d.rules.length - flagged} verified against the transcript, ${flagged} marked NEEDS REVIEW.`, "");
  L.push("## How to use this file", "",
    `- Every rule below was taken only from ${d.trader.name}'s own words. The exact quote and source (with timestamp for YouTube) are given for each rule.`,
    `- "${NS}" means the trader did not say it. Do not fill those gaps with assumptions when building indicators or strategies; ask, or check the full transcript at the end of this file.`,
    "- Rules marked NEEDS REVIEW failed an automatic check (quote not found word for word, or a field was corrected). Confirm them against the transcript before coding.",
    "- Full transcripts of every source are included at the end, word for word.", "");
  const groups = groupByConcept(d.rules), num = new Map(d.rules.map((r, i) => [r.id, i + 1]));
  L.push("## Concepts", "");
  groups.forEach(([c, rs]) => L.push(`- ${c}: ${rs.map(r => "R" + num.get(r.id)).join(", ")}`));
  L.push("", "## Rules", "");
  for (const [c, rs] of groups){
    L.push(`### ${c}`, "");
    for (const r of rs){
      const s = S.get(r.source_id);
      L.push(`#### R${num.get(r.id)}. ${r.title || "Untitled"} [${r.category}] ${r.verified ? "[VERIFIED]" : "[NEEDS REVIEW]"}`, "");
      if (!r.verified && r.review_note) L.push(`> Review note: ${r.review_note}`, "");
      L.push(`- Rule: ${r.rule || NS}`);
      if (r.explanation) L.push(`- Explanation: ${r.explanation}`);
      if ((r.conditions || []).length){ L.push("- Conditions:"); r.conditions.forEach(x => L.push(`  - ${x}`)); }
      L.push(`- Entry: ${r.entry || NS}`, `- Stop loss: ${r.stop_loss || NS}`, `- Target: ${r.target || NS}`, `- Invalidation: ${r.invalidation || NS}`, `- Timeframe: ${r.timeframe || NS}`, `- Instruments: ${r.instruments || NS}`);
      L.push(`- Indicators: ${(r.indicators || []).map(i => `${i.name} (${i.settings || NS})`).join("; ") || NS}`);
      if ((r.related || []).length) L.push(`- Related concepts: ${r.related.join(", ")}`);
      if ((r.ambiguities || []).length){ L.push("- Not specified by the trader:"); r.ambiguities.forEach(x => L.push(`  - ${x}`)); }
      if (r.quote) L.push(`- Exact quote: "${r.quote}"`);
      if (s) L.push(`- Source: S${s.n}, ${s.title || s.platform}, ${tsLink(s, r.timestamp_sec)}${r.timestamp_sec != null ? ` (at ${fmtTs(r.timestamp_sec)})` : ""}`);
      L.push("");
    }
  }
  L.push("## Sources and full transcripts", "");
  d.sources.forEach((s, i) => {
    L.push(`### S${i + 1}. ${s.title || "Untitled"}`, "", `- Platform: ${s.platform}`, `- Link: ${s.url}`, `- Language: ${s.language || "unknown"}`, `- Added: ${String(s.created_at).slice(0, 10)}`);
    if (s.caption) L.push(`- Caption / description: ${s.caption.replace(/\s+/g, " ").slice(0, 1500)}`);
    const same = !s.english || s.english.trim() === s.transcript.trim();
    L.push("", same ? "#### Transcript" : "#### Transcript (English translation)", "", s.english || s.transcript || "(empty)", "");
    if (!same) L.push(`#### Original transcript (${s.language || "original language"})`, "", s.transcript, "");
  });
  return L.join("\n");
}

/* ---------- wiring ---------- */
$("kbUrls").addEventListener("input", kbCounter);
$("kbGo").addEventListener("click", startKb);
$("kbStop").addEventListener("click", () => { kbStop = true; $("kbStop").disabled = true; setTimeout(() => $("kbStop").disabled = false, 1500); });
$("kbOpenKeys").addEventListener("click", openDrawer);
$("tRefresh").addEventListener("click", loadTraders);
kbCounter();
const h = location.hash;
if (h === "#usage") showView("usage");
else if (h === "#kb") showView("kb");
else if (h === "#api") showView("api");
else if (/^#trader-\d+$/.test(h)) openTrader(+h.slice(8));
})();
