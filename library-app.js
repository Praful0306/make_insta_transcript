// Library page: Firebase sign-in, locked/unlocked state, API keys. All real checks happen on the server;
// this page only shows what the server says. Nothing here can unlock data.
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let cfg = null, fb = null, user = null, booted = false;
  const say = (id, t) => { $(id).textContent = t || ""; };

  const loadScript = src => new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  async function boot() {
    if (booted) return; booted = true;
    try { cfg = await (await fetch("/api/v1/auth-config", { cache: "no-store" })).json(); } catch { cfg = null; }
    if (cfg && cfg.login_ready) {
      try {
        const v = "10.14.1";
        await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
        await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`);
        firebase.initializeApp(cfg.firebase); fb = firebase.auth();
        fb.onAuthStateChanged(u => { user = u; render(); });
      } catch { cfg.login_ready = false; }
    }
    render();
  }
  async function token() { return user ? user.getIdToken() : null; }
  async function api(path, opt = {}) {
    const t = await token();
    const r = await fetch("/api/v1/account" + path, { ...opt, headers: { ...(opt.headers || {}), Authorization: "Bearer " + t, "Content-Type": "application/json" } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Something went wrong.");
    return d;
  }

  async function render() {
    const state = $("libState"), login = $("libLogin"), acc = $("libAccount");
    login.hidden = acc.hidden = true;
    if (!cfg) { state.hidden = false; state.innerHTML = "<p class='hint'>Couldn't reach the server. Try again.</p>"; return; }
    if (!cfg.login_ready || !cfg.library_open) {
      state.hidden = false;
      state.innerHTML = "<b>Locked: not open yet.</b><p class='hint'>The Library is not switched on. Nothing is served to anyone, including AI tools.</p>";
      return;
    }
    if (!user) { state.hidden = false; state.innerHTML = "<b>Locked.</b><p class='hint'>Sign in to continue. Rules, quotes and API access open only after payment.</p>"; login.hidden = false; return; }
    state.hidden = true; acc.hidden = false;
    $("libBase").textContent = location.origin + "/api/v1/library";
    let a;
    try { a = await api(""); } catch (e) { say("libAccMsg", e.message); return; }
    const p = a.plan, e = a.entitlement, ok = !!(e && e.active);
    const price = p.price_inr_month ? `₹${p.price_inr_month} / month` : "Price to be announced";
    $("libPlan").innerHTML = ok
      ? `<p><b>Active</b> (${esc(e.plan)}). Access until ${esc(new Date(e.period_end).toLocaleDateString())}${e.status === "cancelled" ? " (cancelled, no further charge)" : ""}.</p>
         <p class="hint">Today: ${a.usage.requests} of ${p.limits.reqPerDay} calls, ${a.usage.rules} of ${p.limits.rulesPerDay} rules. Resets at 05:30 IST.</p>`
      : `<p><b>Locked.</b> Signed in as ${esc(a.email)}. No library data or API access until payment.</p>
         <p>Builder plan: ${esc(price)}. Up to ${p.limits.reqPerDay} calls and ${p.limits.rulesPerDay} rules a day.</p>
         <div class="row"><button type="button" class="primary" id="libBuy" ${p.checkout_open ? "" : "disabled"}>${p.checkout_open ? "Pay and unlock" : "Payments open soon"}</button></div>`;
    $("libPaid").hidden = !ok;
    if (ok) {
      $("libKeys").innerHTML = a.keys.length ? a.keys.map(k => `<div class="row"><code>${esc(k.prefix)}…</code> <span class="hint">${esc(k.label || "")} ${k.revoked ? "(revoked)" : ""}</span>${k.revoked ? "" : `<button type="button" data-rev="${k.id}">Revoke</button>`}</div>`).join("") : "<p class='hint'>No keys yet.</p>";
      $("libPrompt").textContent = `Use my paid trading knowledge base to build: <what you want>.\nAPI: ${location.origin}/api/v1/library (GET only). Send my key in the x-api-key header from the environment variable KB_LIBRARY_KEY. Never print or save it.\nStart with /knowledge?format=markdown&verified=true. Do not guess anything marked "Not stated". Educational only, not financial advice.\nLimits: ${p.limits.reqPerMin} calls/min, ${p.limits.reqPerDay} calls/day, ${p.limits.rulesPerCall} rules per call. Stop on 429 and wait.`;
    }
  }

  const authErr = e => ({ "auth/invalid-credential": "Wrong email or password.", "auth/email-already-in-use": "That email already has an account. Sign in instead.", "auth/weak-password": "Use at least 8 characters.", "auth/invalid-email": "That email looks wrong.", "auth/popup-closed-by-user": "Sign-in window was closed.", "auth/too-many-requests": "Too many tries. Wait a few minutes.", "auth/unauthorized-domain": "This website address is not in Firebase Authorized domains. Add it in Firebase > Authentication > Settings.", "auth/operation-not-allowed": "This sign-in method is not turned on in Firebase > Authentication > Sign-in method.", "auth/popup-blocked": "Your browser blocked the sign-in window. Allow pop-ups for this site.", "auth/invalid-api-key": "The Firebase API key in Vercel is wrong.", "auth/network-request-failed": "Network error. Check your connection." }[e.code] || ("Sign-in failed (" + (e.code || e.message || "unknown") + ")."));
  const creds = () => ({ email: $("libEmail").value.trim(), pass: $("libPass").value });
  const needAgree = () => { if (!$("libAgree").checked) { say("libMsg", "Please tick the box to accept the Terms and Privacy Policy."); return true; } return false; };

  function wire() {
    $("libSignIn").onclick = async () => { const c = creds(); try { say("libMsg", "Signing in…"); await fb.signInWithEmailAndPassword(c.email, c.pass); say("libMsg", ""); } catch (e) { say("libMsg", authErr(e)); } };
    $("libSignUp").onclick = async () => {
      if (needAgree()) return; const c = creds();
      if (c.pass.length < 8) return say("libMsg", "Use at least 8 characters.");
      try { const r = await fb.createUserWithEmailAndPassword(c.email, c.pass); await r.user.sendEmailVerification(); say("libMsg", "Account created. Check your email and verify it."); } catch (e) { say("libMsg", authErr(e)); }
    };
    $("libGoogle").onclick = async () => { if (needAgree()) return; try { await fb.signInWithPopup(new firebase.auth.GoogleAuthProvider()); } catch (e) { say("libMsg", authErr(e)); } };
    $("libReset").onclick = async () => { const c = creds(); if (!c.email) return say("libMsg", "Type your email first."); try { await fb.sendPasswordResetEmail(c.email); } catch {} say("libMsg", "If that email has an account, a reset link was sent."); };
    $("libOut").onclick = () => fb.signOut();
    $("libNewKey").onclick = async () => {
      try { const k = await api("/keys", { method: "POST", body: JSON.stringify({ label: $("libKeyLabel").value }) }); const o = $("libNewKeyOut"); o.hidden = false; o.textContent = "Copy this key now. It will not be shown again:\n" + k.key; await render(); } catch (e) { say("libAccMsg", e.message); }
    };
    $("libKeys").onclick = async ev => { const id = ev.target.dataset && ev.target.dataset.rev; if (!id) return; try { await api("/keys/" + id, { method: "DELETE" }); await render(); } catch (e) { say("libAccMsg", e.message); } };
    $("libPlan").onclick = ev => { if (ev.target.id === "libBuy") say("libAccMsg", "Checkout is not connected yet."); };
    $("libExport").onclick = async () => {
      try { const d = await api("/export"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" })); a.download = "my-data.json"; a.click(); } catch (e) { say("libAccMsg", e.message); }
    };
    $("libDelete").onclick = async () => {
      if (prompt("This deletes your account, keys and usage history. Type DELETE to confirm.") !== "DELETE") return;
      try { await api("", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }); try { await user.delete(); } catch { await fb.signOut(); } say("libMsg", "Your data was deleted."); } catch (e) { say("libAccMsg", e.message); }
    };
  }
  wire();
  window.libOpen = boot;
})();
