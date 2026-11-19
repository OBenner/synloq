/**
 * The read-only operator dashboard page (issue #79): a single self-contained
 * HTML asset — no build step, no CDN, no external fonts (the loopback machine
 * may be offline). The page asks for the operator token once, stores it in
 * localStorage, and speaks auth-v2 to the relay: one challenge per poll, then
 * a proof-signed GET. __PROJECT__ is substituted by the relay at serve time.
 *
 * Simplification, documented in the PR: the page does not verify response
 * proofs. The dashboard is a loopback read-only view that never writes, so a
 * forged response can only paint wrong pixels — never change state.
 */
export const DASHBOARD_LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synloq dashboard — sign in</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f1115; color: #e6e8ee; }
  input { background: #1b2130; color: #e6e8ee; border: 1px solid #262c3a; padding: 4px 8px; width: 26rem; }
  button { background: #2a3448; color: #e6e8ee; border: 0; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  .muted { color: #6b7488; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>Synloq dashboard</h1>
<p>This page requires the <strong>operator</strong> token.</p>
<form id="f">
  <input id="t" type="password" placeholder="operator token" autocomplete="off">
  <button type="submit">Open dashboard</button>
</form>
<p class="muted">The token lives in &lt;synloq home&gt;/credentials/&lt;project key&gt;/operator.token. It is stored in this browser's localStorage and sent only to the loopback relay.</p>
<script>
const t = document.getElementById('t');
const saved = localStorage.getItem('synloq-operator-token');
if (saved) location.replace('/dashboard?token=' + encodeURIComponent(saved));
document.getElementById('f').onsubmit = (event) => {
  event.preventDefault();
  localStorage.setItem('synloq-operator-token', t.value);
  location.assign('/dashboard?token=' + encodeURIComponent(t.value));
};
</script>
</body>
</html>
`;

export const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synloq dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f1115; color: #e6e8ee; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.5rem; color: #9aa4b8; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  td, th { border-bottom: 1px solid #262c3a; padding: 4px 8px; text-align: left; }
  th { color: #9aa4b8; font-weight: 600; }
  .muted { color: #6b7488; font-size: 0.8rem; }
  .err { color: #ff8f8f; }
  input { background: #1b2130; color: #e6e8ee; border: 1px solid #262c3a; padding: 4px 8px; }
  button { background: #2a3448; color: #e6e8ee; border: 0; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
<h1>Synloq — __PROJECT__</h1>
<p class="muted" id="meta">read-only operator dashboard</p>
<div id="login" hidden>
  <p>Operator token: <input id="token" type="password" size="48"> <button id="save">Save</button></p>
  <p class="muted">Stored in this browser's localStorage only; sent to the loopback relay as an auth-v2 proof, never as a header value.</p>
</div>
<h2>Roles</h2>
<table id="roles"><thead><tr><th>role</th><th>session</th><th>state</th><th>gen</th><th>pending</th><th>oldest stored</th><th>unanswered acked</th></tr></thead><tbody></tbody></table>
<h2>Recent deliveries</h2>
<table id="deliveries"><thead><tr><th>at</th><th>from</th><th>to</th><th>state</th><th>expects reply</th><th>thread</th></tr></thead><tbody></tbody></table>
<h2>Audit tail</h2>
<table id="audit"><thead><tr><th>at</th><th>agent</th><th>action</th><th>decision</th><th>reason</th><th>count</th></tr></thead><tbody></tbody></table>
<p class="muted">Read-only: no write operations exist on this page. Message bodies are never shown here.</p>
<script>
const PROJECT = "__PROJECT__";
const $ = (id) => document.getElementById(id);
const tokenInput = $('token');
tokenInput.value = localStorage.getItem('synloq-operator-token') || '';
$('save').onclick = () => { localStorage.setItem('synloq-operator-token', tokenInput.value); load(); };

// --- auth-v2 primitives (mirror src/transport/auth-proof.ts) ---
const te = new TextEncoder();
const utf8 = (s) => te.encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const sha256hex = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
async function hmacHex(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, data));
}
function frame(fields) {
  const parts = [];
  for (const f of fields) {
    const b = utf8(f);
    const size = new Uint8Array(2);
    new DataView(size.buffer).setUint16(0, b.length);
    parts.push(size, b);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdfBytes(ikmHex, saltStr, infoBytes) {
  const base = await crypto.subtle.importKey('raw', unhex(ikmHex), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8(saltStr), info: infoBytes }, base, 256));
}
const keyIdOf = (verifier, project, agentId) => hmacHex(unhex(verifier), frame(['synloq-authv2/kid', project, agentId]));
async function keyFor(verifier, context, purpose) {
  return hkdfBytes(verifier, 'synloq-authv2', frame(['2', context.project, context.agentId, await keyIdOf(verifier, context.project, context.agentId), purpose]));
}
const macHex = async (verifier, context, purpose, fields) => hmacHex(await keyFor(verifier, context, purpose), frame(fields));
const transcriptOf = (c) => [String(c.authVersion), c.project, c.agentId, c.kid, c.instanceId, c.bootId, c.clientNonce, c.serverNonce, String(c.expiresAt)];
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

async function authedGet(path, token) {
  const verifier = await sha256hex(utf8(token));
  const context = { project: PROJECT, agentId: 'operator' };
  const kid = await keyIdOf(verifier, PROJECT, 'operator');
  const clientNonce = randomHex(16);
  const challengeResponse = await fetch('/v1/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authVersion: 2, project: PROJECT, kid, clientNonce }),
  });
  if (!challengeResponse.ok) throw new Error('challenge rejected: HTTP ' + challengeResponse.status);
  const challenge = await challengeResponse.json();
  const transcript = transcriptOf(challenge);
  const expected = await macHex(verifier, context, 'synloq-authv2/challenge', transcript);
  if (challenge.proof !== expected) throw new Error('invalid relay proof');
  if (challenge.expiresAt <= Date.now()) throw new Error('challenge expired');
  const bodyHash = await sha256hex(new Uint8Array(0));
  const requestHash = await sha256hex(frame([...transcript, 'GET', path, bodyHash]));
  const proof = await macHex(verifier, context, 'synloq-authv2/request', [...transcript, requestHash]);
  const response = await fetch(path, {
    headers: { 'x-synloq-auth-version': '2', 'x-synloq-challenge': challenge.serverNonce, 'x-synloq-proof': proof },
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
function row(cells) { return '<tr>' + cells.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>'; }

async function load() {
  const token = localStorage.getItem('synloq-operator-token') || '';
  $('login').hidden = !!token;
  if (!token) return;
  try {
    const data = await authedGet('/v1/operator/dashboard', token);
    $('meta').textContent = 'generated ' + data.generatedAt + ' · loopback read-only';
    const sessions = new Map((data.sessions || []).map((s) => [s.agent_id, s]));
    document.querySelector('#roles tbody').innerHTML = (data.roles || []).map((r) => {
      const s = sessions.get(r.agentId);
      return row([r.agentId, s ? s.session_id.slice(0, 12) : '—', s ? s.state : '—', s ? s.generation : '—', r.pending, r.oldestStoredAt || '—', r.unanswered ? r.unanswered.count : 0]);
    }).join('');
    document.querySelector('#deliveries tbody').innerHTML = (data.deliveries || []).map((d) =>
      row([d.createdAt, d.from, d.to, d.deliveryState, d.expectsReply ? 'yes' : '', d.threadId.slice(0, 8)])
    ).join('');
    document.querySelector('#audit tbody').innerHTML = (data.audit || []).map((e) =>
      row([e.at, e.agentId, e.action, e.decision, e.reasonCode, e.count || ''])
    ).join('');
  } catch (error) {
    $('login').hidden = false;
    $('meta').innerHTML = '<span class="err">' + esc(error.message) + ' — check the operator token.</span>';
  }
}
load();
setInterval(load, 5000);
</script>
</body>
</html>
`;
