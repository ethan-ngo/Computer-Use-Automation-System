/**
 * The console's single page, inlined as a string.
 *
 * No build step, no framework, no asset pipeline. An operator console that a bank has to
 * deploy is one more thing to break at 3am; this one is served by the same process that
 * holds the browser session, which is also the only process that *can* hold it.
 *
 * The page never asks the operator to think in the system's vocabulary. It leads with the
 * goal and the step's intent, and shows the error class only as a footnote.
 */

export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator console</title>
<style>
  :root {
    --bg: #f6f6f4; --panel: #fff; --ink: #1a1a18; --muted: #6b6b66;
    --line: #e2e2dd; --accent: #7b4b2a; --warn: #8a2f21; --ok: #2f6b45;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16161a; --panel:#1e1e23; --ink:#eceae5; --muted:#9a9a94;
            --line:#2e2e35; --accent:#c98f5f; --warn:#e08374; --ok:#7fc39b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding-block:24px; padding-inline:16px; }
  h1 { font-size:17px; margin:0 0 2px; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 20px; }
  .lease { display:inline-flex; gap:8px; align-items:center; padding:4px 10px; border-radius:99px;
           font-size:12px; border:1px solid var(--line); background:var(--panel); }
  .dot { width:8px; height:8px; border-radius:99px; background:var(--muted); }
  .dot.automation { background:var(--ok); } .dot.human { background:var(--accent); }
  .grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; margin-top:16px; }
  @media (max-width:820px) { .grid { grid-template-columns:1fr; } }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:0.06em;
             color:var(--muted); margin:0 0 12px; font-weight:600; }
  .req { border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:10px; cursor:pointer; }
  .req:hover { border-color:var(--accent); }
  .req[aria-current="true"] { border-color:var(--accent); box-shadow:inset 3px 0 0 var(--accent); }
  .req .goal { color:var(--muted); font-size:12px; }
  .req .intent { font-weight:600; margin:2px 0; }
  .req .meta { font-size:12px; color:var(--muted); }
  dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 14px; margin:0 0 16px; }
  dt { color:var(--muted); font-size:12px; }
  dd { margin:0; min-width:0; overflow-wrap:anywhere; }
  .want { color:var(--ok); } .got { color:var(--warn); }
  img.shot { width:100%; border:1px solid var(--line); border-radius:8px; display:block; background:var(--bg); }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  button { font:inherit; padding:8px 14px; border-radius:7px; border:1px solid var(--line);
           background:var(--panel); color:var(--ink); cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--warn); }
  button:disabled { opacity:0.45; cursor:not-allowed; }
  input[type=text] { font:inherit; width:100%; padding:8px 10px; border-radius:7px;
                     border:1px solid var(--line); background:var(--bg); color:var(--ink); margin-top:10px; }
  .empty { color:var(--muted); font-style:italic; }
  .note { font-size:12px; color:var(--muted); margin-top:12px; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Operator console</h1>
  <p class="sub">The automation hands you the session here. While you hold it, automation cannot act.</p>
  <span class="lease"><span class="dot" id="dot"></span><span id="leaseText">…</span></span>

  <div class="grid">
    <section class="card">
      <h2>Waiting for you</h2>
      <div id="list"><p class="empty">Nothing needs attention.</p></div>
    </section>

    <section class="card">
      <h2>Live session</h2>
      <img class="shot" id="shot" alt="Current page in the automation's browser session">
      <div id="detail"></div>
    </section>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let selected = null;
let lease = null;

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

async function refresh() {
  let state;
  try { state = await api('/api/state'); } catch { return; }
  lease = state.lease;

  $('dot').className = 'dot ' + lease.controller;
  $('leaseText').textContent =
    lease.controller === 'human'
      ? 'You have control — ' + (lease.holder || 'operator') + ' (epoch ' + lease.epoch + ')'
      : lease.controller === 'automation'
        ? 'Automation is driving (epoch ' + lease.epoch + ')'
        : 'Nobody is driving (epoch ' + lease.epoch + ')';

  const open = state.interventions.filter((r) => r.status !== 'resolved' && r.status !== 'expired');
  $('list').innerHTML = open.length === 0
    ? '<p class="empty">Nothing needs attention.</p>'
    : open.map((r) => \`
        <div class="req" data-id="\${r.id}" aria-current="\${r.id === selected}">
          <div class="goal">\${esc(r.goal)}</div>
          <div class="intent">\${esc(r.intent)}</div>
          <div class="meta">\${esc(r.capabilityId)} · step \${esc(r.stepId)} · \${esc(r.status)}</div>
        </div>\`).join('');

  for (const el of document.querySelectorAll('.req')) {
    el.onclick = () => { selected = el.dataset.id; render(); refresh(); };
  }
  if (!selected && open.length > 0) selected = open[0].id;
  render();
}

async function render() {
  if (!selected) { $('detail').innerHTML = ''; return; }
  let r;
  try { r = await api('/api/interventions/' + selected); } catch { $('detail').innerHTML = ''; return; }

  const iHold = lease && lease.controller === 'human';
  const done = r.status === 'resolved' || r.status === 'expired';

  $('detail').innerHTML = \`
    <dl>
      <dt>Goal</dt><dd>\${esc(r.goal)}</dd>
      <dt>Step</dt><dd>\${esc(r.intent)}</dd>
      <dt>Expected</dt><dd class="want">\${esc(r.expected)}</dd>
      <dt>Observed</dt><dd class="got">\${esc(r.observed)}</dd>
      <dt>Page</dt><dd><code>\${esc(r.url)}</code></dd>
      \${r.errorClass ? '<dt>Class</dt><dd><code>' + esc(r.errorClass) + '</code></dd>' : ''}
    </dl>
    \${done ? '<p class="empty">Resolved as ' + esc(r.resolution?.kind) + '.</p>' : \`
      <input type="text" id="note" placeholder="What did you do, or why not? (recorded on the run)">
      <div class="row">
        <button class="primary" id="take" \${iHold ? 'disabled' : ''}>Take control</button>
        <button id="done" \${iHold ? '' : 'disabled'}>I finished the step</button>
        <button id="approve" \${iHold ? '' : 'disabled'}>Approve, you continue</button>
        <button class="danger" id="decline" \${iHold ? '' : 'disabled'}>Decline</button>
      </div>
      <p class="note">
        Taking control moves the session lease to you. Automation is then <em>unable</em> to act
        until you release it — that is enforced at the same chokepoint as the policy allowlist,
        not by convention. What you do in the browser is recorded, with field values reduced to
        their shape before they leave the page.
      </p>\`}
  \`;

  if (done) return;
  const note = () => $('note')?.value || '';
  const act = (fn) => async () => { try { await fn(); } catch (e) { alert(e.message); } finally { refresh(); } };

  const take = $('take');
  if (take) take.onclick = act(() => api('/api/interventions/' + r.id + '/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // The epoch we last saw, so a second operator racing us is refused rather than interleaved.
    body: JSON.stringify({ operator: 'operator', epoch: lease?.epoch }),
  }));

  for (const [id, kind] of [['done','completed'],['approve','approved'],['decline','declined']]) {
    const el = $(id);
    if (el) el.onclick = act(() => api('/api/interventions/' + r.id + '/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, note: note() }),
    }));
  }
}

// A screenshot a second, cache-busted. Not a video: the operator has the real window.
setInterval(() => { $('shot').src = '/api/screenshot?t=' + Date.now(); }, 1000);
setInterval(refresh, 1500);
refresh();
</script>
</body>
</html>`;
