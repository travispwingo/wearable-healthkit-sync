/**
 * Browser setup wizard — lets a self-hoster configure everything after a
 * one-click deploy, with no CLI:
 *   1. Enter the setup password (the one deploy-time secret).
 *   2. Create a free Oura API app (the page shows the exact redirect URI to paste)
 *      and save the Client ID / Secret → stored in KV.
 *   3. "Sign in with Oura" → refresh token stored in KV.
 *   4. Copy the personal sync link + add the Shortcut.
 *
 * The wizard's JSON endpoints are gated by SETUP_PASSWORD (X-Setup-Password header).
 */
import type { Env } from "./env";
import { checkSetupPassword } from "./auth";
import {
  getOrCreateAppToken,
  getOuraCredentials,
  getRefreshToken,
  setOuraCredentials,
} from "./config";
import { beginAuthorization, redirectUriFor } from "./providers/oura/oauth";
import { json } from "./http";

/** Maintainer: paste your published iCloud Shortcut link here (see shortcut/README.md). */
const SHORTCUT_ICLOUD_URL = "";
const OURA_APPS_URL = "https://cloud.ouraring.com/oauth/applications";

interface SetupStatus {
  configured: boolean; // Oura app credentials present
  connected: boolean; // Oura account linked (refresh token present)
  redirectUri: string;
  ouraAppsUrl: string;
  shortcutUrl: string;
  syncUrl: string | null; // only revealed once connected
}

async function buildStatus(request: Request, env: Env): Promise<SetupStatus> {
  const [creds, refresh] = await Promise.all([getOuraCredentials(env), getRefreshToken(env)]);
  const connected = refresh !== null;
  const origin = new URL(request.url).origin;
  return {
    configured: creds !== null,
    connected,
    redirectUri: redirectUriFor(request),
    ouraAppsUrl: OURA_APPS_URL,
    shortcutUrl: SHORTCUT_ICLOUD_URL,
    syncUrl: connected ? `${origin}/sync?k=${await getOrCreateAppToken(env)}` : null,
  };
}

/** Guard shared by the JSON endpoints. Returns a Response to short-circuit, or null to proceed. */
async function guard(request: Request, env: Env): Promise<Response | null> {
  if (!env.SETUP_PASSWORD) {
    return json(
      { error: "SETUP_PASSWORD is not set. Add it in the Cloudflare dashboard (Settings → Variables and Secrets), then reload." },
      503,
    );
  }
  if (!(await checkSetupPassword(request, env.SETUP_PASSWORD))) {
    return json({ error: "wrong password" }, 401);
  }
  return null;
}

export async function handleSetupStatus(request: Request, env: Env): Promise<Response> {
  return (await guard(request, env)) ?? json(await buildStatus(request, env));
}

export async function handleSetupSaveOura(request: Request, env: Env): Promise<Response> {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = (await request.json().catch(() => ({}))) as { clientId?: string; clientSecret?: string };
  const clientId = (body.clientId ?? "").trim();
  const clientSecret = (body.clientSecret ?? "").trim();
  if (!clientId || !clientSecret) return json({ error: "clientId and clientSecret are required" }, 400);
  await setOuraCredentials(env, clientId, clientSecret);
  await getOrCreateAppToken(env); // ensure a token exists to show later
  return json(await buildStatus(request, env));
}

export async function handleSetupAuthorizeUrl(request: Request, env: Env): Promise<Response> {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const url = await beginAuthorization(env, redirectUriFor(request));
  return json({ url });
}

export function renderSetupPage(): Response {
  return new Response(SETUP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Inline JS below intentionally avoids template literals (backticks) so it nests
// cleanly inside this TS template string.
const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up your Oura → Health sync</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; line-height: 1.5; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.1rem; margin-top: 0; }
  .step { border: 1px solid #8883; border-radius: 12px; padding: 16px 20px; margin: 16px 0; }
  .step[aria-disabled="true"] { opacity: .45; pointer-events: none; }
  .done { color: #12882e; font-weight: 600; }
  input { width: 100%; padding: 10px; margin: 6px 0; border: 1px solid #8886; border-radius: 8px; font-size: 16px; background: transparent; color: inherit; }
  button { padding: 10px 16px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button.secondary { background: #8883; color: inherit; }
  a { color: #2563eb; }
  code, .mono { font-family: ui-monospace, Menlo, monospace; font-size: 13px; word-break: break-all; background: #8881; padding: 2px 6px; border-radius: 6px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .err { color: #c1121f; font-size: 14px; min-height: 1.2em; }
  .hint { font-size: 14px; opacity: .8; }
</style>
</head>
<body>
<h1>Oura → Apple Health setup</h1>

<div class="step" id="lock">
  <h2>Enter setup password</h2>
  <p class="hint">The password you chose when deploying (SETUP_PASSWORD).</p>
  <input type="password" id="pw" placeholder="Setup password" autocomplete="current-password">
  <button id="unlock">Unlock</button>
  <div class="err" id="lockErr"></div>
</div>

<div class="step" id="s1" aria-disabled="true">
  <h2>1. Create a free Oura API app <span class="done" id="s1done" hidden>✓</span></h2>
  <ol>
    <li>Open the <a id="ouraLink" target="_blank" rel="noopener">Oura applications page</a> and click <b>Create New Application</b>.</li>
    <li>For <b>Redirect URI</b>, paste exactly:<br><span class="mono" id="redirect"></span> <button class="secondary" data-copy="redirect">Copy</button></li>
    <li>Copy the <b>Client ID</b> and <b>Client Secret</b> it gives you into the boxes below.</li>
  </ol>
  <input id="clientId" placeholder="Client ID" autocomplete="off">
  <input id="clientSecret" placeholder="Client Secret" autocomplete="off">
  <button id="saveOura">Save</button>
  <div class="err" id="s1err"></div>
</div>

<div class="step" id="s2" aria-disabled="true">
  <h2>2. Connect your Oura account <span class="done" id="s2done" hidden>✓ Connected</span></h2>
  <p class="hint">Signs you in to Oura and grants read access to your data.</p>
  <button id="connect">Sign in with Oura</button>
  <div class="err" id="s2err"></div>
</div>

<div class="step" id="s3" aria-disabled="true">
  <h2>3. Add the iPhone Shortcut</h2>
  <p>Your personal sync link (keep it private — it's your key):</p>
  <p><span class="mono" id="syncUrl"></span> <button class="secondary" data-copy="syncUrl">Copy</button></p>
  <p id="shortcutRow" hidden>On your iPhone, tap <a id="shortcutLink" target="_blank" rel="noopener">Add the Shortcut</a>, then paste the link above when it asks.</p>
  <p class="hint">Then follow the guide to add a once-a-day automation. That last step is done by hand on the iPhone — it can't be automated.</p>
</div>

<script>
(function () {
  var PW_KEY = "setup_pw";
  function el(id){ return document.getElementById(id); }
  function pw(){ return sessionStorage.getItem(PW_KEY) || ""; }
  function api(path, body){
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Password": pw() },
      body: body ? JSON.stringify(body) : "{}"
    });
  }
  function copyBtns(){
    document.querySelectorAll("[data-copy]").forEach(function(b){
      b.onclick = function(){
        var t = el(b.getAttribute("data-copy")).textContent;
        navigator.clipboard.writeText(t).then(function(){ b.textContent = "Copied"; setTimeout(function(){ b.textContent = "Copy"; }, 1200); });
      };
    });
  }
  function setDisabled(id, disabled){ el(id).setAttribute("aria-disabled", disabled ? "true" : "false"); }
  function render(st){
    el("ouraLink").href = st.ouraAppsUrl;
    el("redirect").textContent = st.redirectUri;
    setDisabled("s1", false);
    el("s1done").hidden = !st.configured;
    setDisabled("s2", !st.configured);
    el("s2done").hidden = !st.connected;
    setDisabled("s3", !st.connected);
    if (st.syncUrl) { el("syncUrl").textContent = st.syncUrl; }
    if (st.shortcutUrl) { el("shortcutLink").href = st.shortcutUrl; el("shortcutRow").hidden = false; }
    copyBtns();
  }
  function loadStatus(){
    return api("/setup/status").then(function(r){
      if (r.status === 401) { el("lockErr").textContent = "Wrong password."; sessionStorage.removeItem(PW_KEY); throw new Error("401"); }
      if (!r.ok) { return r.json().then(function(j){ el("lockErr").textContent = j.error || "Error"; throw new Error("status"); }); }
      el("lock").setAttribute("aria-disabled", "false");
      el("lockErr").textContent = "";
      return r.json();
    }).then(render);
  }
  el("unlock").onclick = function(){
    sessionStorage.setItem(PW_KEY, el("pw").value);
    loadStatus().catch(function(){});
  };
  el("saveOura").onclick = function(){
    el("s1err").textContent = "";
    api("/setup/oura", { clientId: el("clientId").value, clientSecret: el("clientSecret").value })
      .then(function(r){ return r.json().then(function(j){ if(!r.ok){ throw new Error(j.error||"Error"); } return j; }); })
      .then(render)
      .catch(function(e){ el("s1err").textContent = e.message; });
  };
  el("connect").onclick = function(){
    el("s2err").textContent = "";
    api("/setup/authorize-url")
      .then(function(r){ return r.json().then(function(j){ if(!r.ok){ throw new Error(j.error||"Error"); } return j; }); })
      .then(function(j){ window.location = j.url; })
      .catch(function(e){ el("s2err").textContent = e.message; });
  };
  // Auto-unlock if we already have the password this session (e.g. after the OAuth redirect).
  if (pw()) { loadStatus().catch(function(){}); }
})();
</script>
</body>
</html>`;
