/*
  Lightweight Pub/Sub UI (TypeScript)
  - Polls Pub/Sub emulator via REST (no external deps)
  - In-memory store for last N messages
  - HTML UI with Messages + Publish tabs
  Environment:
    PUBSUB_PROJECT_ID (default: loc-pubsub-lemonde-io)
    PUBSUB_EMULATOR_HOST (default: loc-pubsub.lemonde.io:8432)
    PORT (default: 3001)
    MAX_MESSAGES (default: 500)
*/

import * as http from 'http';

// Node 22 has global fetch; type as any to avoid extra deps
const fetchAny: any = (global as any).fetch;

const PROJECT_ID = process.env.PUBSUB_PROJECT_ID || 'loc-pubsub-lemonde-io';
const EMULATOR_HOST = process.env.PUBSUB_EMULATOR_HOST || 'loc-pubsub.lemonde.io:8432';
const BASE = `http://${EMULATOR_HOST}/v1/projects/${PROJECT_ID}`;
const PORT = Number(process.env.PORT || 3001);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 500);

interface UiMessage {
  id: string;
  subscription: string;
  publishTime: string | null;
  attributes: Record<string, string>;
  data: any;
  raw: string;
  receivedAt: string;
  topic: string | null;
}

const store = {
  messages: [] as UiMessage[],
  push(m: UiMessage) {
    this.messages.push(m);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
  },
  clear() { this.messages = []; },
};

async function listTopics() {
  try {
    const res = await fetchAny(`${BASE}/topics`);
    if (!res.ok) return [] as { full: string; short: string }[];
    const data = await res.json();
    return (data.topics || []).map((t: any) => {
      const name: string = t.name || '';
      const parts = name.split('/');
      const short = parts[parts.length - 1] || name;
      return { full: name, short };
    });
  } catch {
    return [] as { full: string; short: string }[];
  }
}

async function ensureUiSubscription(topicShort: string) {
  const uiSub = `${topicShort}.ui`;
  try {
    await fetchAny(`${BASE}/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `projects/${PROJECT_ID}/subscriptions/${uiSub}`,
        topic: `projects/${PROJECT_ID}/topics/${topicShort}`,
      }),
    });
  } catch {}
  return uiSub;
}

async function pullOnce(subShort: string) {
  try {
    const res = await fetchAny(`${BASE}/subscriptions/${encodeURIComponent(subShort)}:pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxMessages: 50 }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const received = data.receivedMessages || [];
    if (received.length === 0) return;

    const nowIso = new Date().toISOString();
    for (const rm of received) {
      const msg = rm.message || {};
      const base64: string = msg.data || '';
      let decoded = '';
      try { decoded = Buffer.from(base64, 'base64').toString('utf8'); } catch {}
      let parsed: any = decoded;
      try { parsed = JSON.parse(decoded); } catch {}
      const topicAttr: string | null = (msg.attributes && (msg.attributes.topic || msg.attributes._topic)) || null;

      store.push({
        id: msg.messageId || '',
        subscription: subShort,
        publishTime: msg.publishTime || null,
        attributes: msg.attributes || {},
        data: parsed,
        raw: decoded,
        receivedAt: nowIso,
        topic: topicAttr || subShort.replace(/\.ui$/, ''),
      });
    }
    // Ack messages
    const ackIds = (data.receivedMessages || []).map((rm: any) => rm.ackId).filter(Boolean);
    if (ackIds.length) {
      await fetchAny(`${BASE}/subscriptions/${encodeURIComponent(subShort)}:acknowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ackIds }),
      });
    }
  } catch {}
}

function ensurePoller(subShort: string) {
  const loop = async () => { await pullOnce(subShort); setTimeout(loop, 500); };
  loop();
}

async function refreshSubscriptionsLoop() {
  const topics = await listTopics();
  for (const t of topics) {
    const uiSub = await ensureUiSubscription(t.short);
    ensurePoller(uiSub);
  }
  setTimeout(refreshSubscriptionsLoop, 5000);
}
refreshSubscriptionsLoop();

function sendJson(res: http.ServerResponse, code: number, obj: any) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(body);
}

function deriveTypeFromTopic(full: string) {
  const m = full.match(/^[^-]+-users-[^-]+-(.+)$/);
  return m ? m[1] : full;
}

const PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pub/Sub UI</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    header { position: sticky; top: 0; background: #0b1222; border-bottom: 1px solid #1f2a44; padding: 12px 16px; display: flex; align-items: center; gap: 12px; }
    h1 { font-size: 16px; margin: 0; }
    .pill { background: #1e293b; border: 1px solid #334155; padding: 6px 10px; border-radius: 999px; font-size: 12px; }
    .btn { background: #334155; border: 1px solid #475569; color: #e2e8f0; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
    .btn:hover { background: #3b4a62; }
    .btn.active { background: #3b4a62; border-color: #5b6b84; }
    main { padding: 16px; }
    .row { border: 1px solid #1f2a44; background: #0b1222; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
    .row header { display: grid; grid-template-columns: 1fr auto; background: #0e162b; border-bottom: 1px solid #1f2a44; }
    .row .meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; }
    pre { margin: 0; padding: 12px 16px; overflow: auto; background: #0b1222; color: #93c5fd; }
    .toolbar { margin-left: auto; display: flex; gap: 8px; }
    .filters { display: flex; gap: 8px; align-items: center; }
    input, textarea, select { background: #0b1222; color: #e2e8f0; border: 1px solid #1f2a44; border-radius: 6px; padding: 6px 8px; }
  </style>
</head>
<body>
  <header>
    <h1>Pub/Sub UI</h1>
    <span class="pill" id="stat">—</span>
    <div class="filters">
      <label>Sub:</label>
      <input id="f-sub" placeholder="(filtrer par subscription)" />
      <label>Texte:</label>
      <input id="f-q" placeholder="(filtrer JSON/texte)" />
      <label>Limite:</label>
      <input id="f-limit" type="number" min="1" max="5000" value="200" />
    </div>
    <div class="toolbar">
      <button class="btn active" id="btn-tab-messages">Messages</button>
      <button class="btn" id="btn-tab-publish">Publier</button>
      <button class="btn" id="btn-refresh">Rafraîchir</button>
      <button class="btn" id="btn-clear">Vider</button>
    </div>
  </header>

  <main id="app"></main>

  <section id="pub" style="display:none; padding:16px;">
    <div class="row">
      <header>
        <div class="meta"><span class="pill">Publier un message</span></div>
      </header>
      <div style="padding:12px 16px; display:flex; flex-direction:column; gap:12px;">
        <div>
          <label>Topic</label><br/>
          <input id="pub-topic" list="topics-list" placeholder="ex: register" style="width:100%"/>
          <datalist id="topics-list"></datalist>
        </div>
        <div>
          <label>Type (optionnel)</label><br/>
          <input id="pub-type" placeholder="ex: mage.sync (par défaut: suffixe du topic)" style="width:100%"/>
        </div>
        <div>
          <label>Attributes (JSON)</label>
          <textarea id="pub-attrs" rows="4" style="width:100%">{}</textarea>
        </div>
        <div>
          <label>Payload (JSON ou texte)</label>
          <textarea id="pub-payload" rows="8" style="width:100%">{
  "hello": "world"
}</textarea>
        </div>
        <div>
          <button class="btn" id="pub-send">Publier</button>
          <span id="pub-status" class="pill">—</span>
        </div>
      </div>
    </div>
  </section>

  <script>
    const app = document.getElementById('app');
    const pub = document.getElementById('pub');
    const stat = document.getElementById('stat');
    const fSub = document.getElementById('f-sub');
    const fQ = document.getElementById('f-q');
    const fLimit = document.getElementById('f-limit');
    const btnRefresh = document.getElementById('btn-refresh');
    const btnClear = document.getElementById('btn-clear');
    const tabMessages = document.getElementById('btn-tab-messages');
    const tabPublish = document.getElementById('btn-tab-publish');

    const pubTopic = document.getElementById('pub-topic');
    const pubType = document.getElementById('pub-type');
    const pubAttrs = document.getElementById('pub-attrs');
    const pubPayload = document.getElementById('pub-payload');
    const pubSend = document.getElementById('pub-send');
    const pubStatus = document.getElementById('pub-status');

    function switchView(view) {
      if (view === 'publish') {
        app.style.display = 'none';
        pub.style.display = 'block';
        tabPublish.classList.add('active');
        tabMessages.classList.remove('active');
      } else {
        app.style.display = 'block';
        pub.style.display = 'none';
        tabMessages.classList.add('active');
        tabPublish.classList.remove('active');
      }
    }

    let timer = null;

    async function fetchMessages(force) {
      if (!force && window.getSelection && window.getSelection().toString()) {
        return;
      }
      const p = new URLSearchParams();
      if (fSub.value) p.set('subscription', fSub.value);
      if (fQ.value) p.set('q', fQ.value);
      if (fLimit.value) p.set('limit', fLimit.value);
      const res = await fetch('/api/messages?' + p.toString());
      const data = await res.json();
      stat.textContent = data.count + ' messages';
      render(data.items);
    }

    function render(items) {
      app.innerHTML = '';
      for (const m of items) {
        const el = document.createElement('section');
        el.className = 'row';
        el.innerHTML =
          '<header>' +
            '<div class="meta">' +
              '<span class="pill">sub: ' + (m.subscription || '—') + '</span>' +
              '<span class="pill">topic: ' + (m.topic || '—') + '</span>' +
              '<span class="pill">id: ' + (m.id || '—') + '</span>' +
              '<span class="pill">published: ' + (m.publishTime || '—') + '</span>' +
              '<span class="pill">received: ' + (m.receivedAt || '—') + '</span>' +
            '</div>' +
          '</header>' +
          '<pre>' + escapeHtml(JSON.stringify(m.data, null, 2)) + '</pre>';
        app.appendChild(el);
      }
    }

    function escapeHtml(str) {
      return str.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    }

    btnRefresh.onclick = () => fetchMessages(true);
    btnClear.onclick = async () => { await fetch('/api/clear', { method: 'POST' }); fetchMessages(); };

    tabMessages.onclick = () => switchView('messages');
    tabPublish.onclick = async () => { switchView('publish'); await fetchTopics(); };

    async function fetchTopics() {
      try {
        const res = await fetch('/api/topics');
        const data = await res.json();
        const dl = document.getElementById('topics-list');
        dl.innerHTML = '';
        (data.topics || []).forEach(t => {
          const opt = document.createElement('option');
          opt.value = t;
          dl.appendChild(opt);
        });
      } catch {}
    }

    pubSend.onclick = async () => {
      pubStatus.textContent = '…';
      const topic = (pubTopic.value || '').trim();
      if (!topic) { pubStatus.textContent = 'Topic requis'; return; }
      let attrs = {};
      try { attrs = JSON.parse(pubAttrs.value || '{}'); } catch (e) { pubStatus.textContent = 'Attributes JSON invalide'; return; }
      const raw = pubPayload.value || '';
      let data = raw;
      try { data = JSON.parse(raw); } catch {}

      const type = (pubType.value || '').trim();

      try {
        const res = await fetch('/api/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topic, type, data, attributes: attrs }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok) {
          pubStatus.textContent = 'Publié';
          fetchMessages(true);
        } else {
          pubStatus.textContent = 'Erreur: ' + (out.error || res.status);
        }
      } catch {
        pubStatus.textContent = 'Erreur réseau';
      }
    };

    function startAuto() { if (timer) clearInterval(timer); timer = setInterval(() => fetchMessages(false), 2000); }

    [fSub, fQ, fLimit].forEach(el => el.addEventListener('change', fetchMessages));

    fetchMessages(true);
    startAuto();
  </script>
</body>
</html>`;


async function handleApiTopics(_req: http.IncomingMessage, res: http.ServerResponse) {
  const topics = await listTopics();
  return sendJson(res, 200, { topics: topics.map((t: any) => t.short) });
}

async function handleApiPublish(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
req.on('data', (c: any) => (body += c));
  req.on('end', async () => {
    let obj: any = {};
    try { obj = JSON.parse(body || '{}'); } catch {}
    const topic = (obj.topic || '').trim();
    if (!topic) return sendJson(res, 400, { error: 'topic_required' });

    const attributes: Record<string, string> = obj.attributes && typeof obj.attributes === 'object' ? obj.attributes : {};

    try { await ensureUiSubscription(topic); } catch {}

    const type = (obj.type || '').trim() || deriveTypeFromTopic(topic);
    const envelope = { body: { type, payload: obj.data === undefined ? {} : obj.data }, properties: {}, headers: {} };
    const payloadStr = JSON.stringify(envelope);
    const encoded = Buffer.from(payloadStr, 'utf8').toString('base64');

    const r = await fetchAny(`${BASE}/topics/${encodeURIComponent(topic)}:publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ data: encoded, attributes }] }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return sendJson(res, r.status, { error: 'publish_failed', details: out });

    try {
      const nowIso = new Date().toISOString();
      const id = Array.isArray(out.messageIds) ? String(out.messageIds[0]) : '';
      store.push({ id, subscription: `${topic}.ui`, publishTime: nowIso, attributes, data: envelope, raw: payloadStr, receivedAt: nowIso, topic });
      // eslint-disable-next-line no-console
      console.log('[pubsub-ui] mirrored', `${topic}.ui`, id, 'store size=', store.messages.length);
    } catch {}

    return sendJson(res, 200, { ok: true, response: out });
  });
}

function handleApiMessages(_req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const q = url.searchParams.get('q');
  const sub = url.searchParams.get('subscription');
  const limit = Math.max(1, Math.min(5000, parseInt(url.searchParams.get('limit') || '200', 10)));

  let items = store.messages.slice().reverse();
  if (sub) items = items.filter((m) => (m.subscription || '').includes(sub));
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((m) => {
      try { const txt = (m.raw || JSON.stringify(m.data || {})).toLowerCase(); return txt.includes(needle); } catch { return false; }
    });
  }
  items = items.slice(0, limit);
  return sendJson(res, 200, { count: items.length, items });
}

function handleApiClear(_req: http.IncomingMessage, res: http.ServerResponse) {
  store.clear();
  res.writeHead(204); res.end();
}

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  const u = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (req.method === 'GET' && u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (req.method === 'GET' && u.pathname === '/api/topics') return handleApiTopics(req, res);
  if (req.method === 'POST' && u.pathname === '/api/publish') return handleApiPublish(req, res);
  if (req.method === 'GET' && u.pathname === '/api/messages') return handleApiMessages(req, res, u);
  if (req.method === 'POST' && u.pathname === '/api/clear') return handleApiClear(req, res);
  if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE_HTML); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found');
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[pubsub-ui] Listening on :${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[pubsub-ui] Project: ${PROJECT_ID} | Emulator: ${EMULATOR_HOST}`);
});

