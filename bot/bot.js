'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const STATS_PORT = Number(process.env.STATS_PORT || 8443);
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error('BOT_TOKEN and WEBAPP_URL env vars are required');
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN env var is required for the stats panel');
  process.exit(1);
}

function apiCall(method, params) {
  const data = JSON.stringify(params || {});
  return new Promise((resolve, reject) => {
    const req = https.request(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---- stats storage ----
const STATS_FILE = path.join(__dirname, 'stats.json');
const MAX_EVENTS = 20000;

let stats = { users: {}, events: [] };
try {
  stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  if (!stats.users) stats.users = {};
  if (!stats.events) stats.events = [];
} catch (e) {
  // no stats file yet, start fresh
}

let saveTimer = null;
function saveStats() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(STATS_FILE, JSON.stringify(stats), (e) => {
      if (e) console.error('saveStats error:', e);
    });
  }, 500);
}

function recordStart(user) {
  const now = Date.now();
  const id = String(user.id);
  let u = stats.users[id];
  if (!u) {
    u = {
      id: user.id,
      username: user.username || '',
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      first_seen: now,
      last_seen: now,
      starts: 0,
    };
    stats.users[id] = u;
  }
  u.username = user.username || u.username;
  u.first_name = user.first_name || u.first_name;
  u.last_name = user.last_name || u.last_name;
  u.last_seen = now;
  u.starts += 1;

  stats.events.push({ ts: now, userId: user.id });
  if (stats.events.length > MAX_EVENTS) {
    stats.events.splice(0, stats.events.length - MAX_EVENTS);
  }
  saveStats();
}

// ---- broadcast ----
// шлём не чаще ~25 сообщений в секунду — под лимитами Telegram на разные чаты
const BROADCAST_DELAY_MS = 40;

async function broadcastMessage(text) {
  const ids = Object.keys(stats.users);
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const res = await apiCall('sendMessage', { chat_id: Number(id), text });
      if (res.ok) sent += 1; else failed += 1;
    } catch (e) {
      failed += 1;
    }
    await new Promise((r) => setTimeout(r, BROADCAST_DELAY_MS));
  }
  return { total: ids.length, sent, failed };
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;

  if (msg.text.startsWith('/start')) {
    recordStart(msg.from);
    await apiCall('sendMessage', {
      chat_id: chatId,
      text: 'Привет! Нажмите кнопку ниже, чтобы пройти диагностику «Конфликт интересов».',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Открыть диагностику', web_app: { url: WEBAPP_URL } },
        ]],
      },
    });
    return;
  }

  await apiCall('sendMessage', {
    chat_id: chatId,
    text: 'Отправьте /start, чтобы начать.',
  });
}

async function poll() {
  let offset = 0;
  console.log('Bot polling started');
  for (;;) {
    try {
      const res = await apiCall('getUpdates', { offset, timeout: 30 });
      if (res.ok) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          handleUpdate(update).catch((e) => console.error('handleUpdate error:', e));
        }
      } else {
        console.error('getUpdates failed:', res);
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      console.error('poll error:', e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

poll();

// ---- stats web panel ----
function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildDailySeries(days) {
  const now = Date.now();
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const ts = now - i * 86400000;
    buckets.push({ key: dayKey(ts), newUsers: 0, starts: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));

  for (const u of Object.values(stats.users)) {
    const k = dayKey(u.first_seen);
    const b = byKey.get(k);
    if (b) b.newUsers += 1;
  }
  for (const ev of stats.events) {
    const k = dayKey(ev.ts);
    const b = byKey.get(k);
    if (b) b.starts += 1;
  }
  return buckets;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderPanel(token) {
  const users = Object.values(stats.users);
  const totalUsers = users.length;
  const totalStarts = stats.events.length;
  const now = Date.now();
  const since = (ms) => now - ms;
  const newUsersIn = (ms) => users.filter((u) => u.first_seen >= since(ms)).length;
  const startsIn = (ms) => stats.events.filter((e) => e.ts >= since(ms)).length;

  const daily = buildDailySeries(14);
  const maxStarts = Math.max(1, ...daily.map((d) => d.starts));
  const maxNew = Math.max(1, ...daily.map((d) => d.newUsers));

  const chartRows = daily.map((d) => `
    <tr>
      <td>${d.key}</td>
      <td>
        <div class="bar-track"><div class="bar bar-new" style="width:${(d.newUsers / maxNew * 100).toFixed(0)}%"></div></div>
        ${d.newUsers}
      </td>
      <td>
        <div class="bar-track"><div class="bar bar-starts" style="width:${(d.starts / maxStarts * 100).toFixed(0)}%"></div></div>
        ${d.starts}
      </td>
    </tr>`).join('');

  const recentUsers = users
    .sort((a, b) => b.last_seen - a.last_seen)
    .slice(0, 30)
    .map((u) => `
      <tr>
        <td>${u.id}</td>
        <td>${escapeHtml(u.username ? '@' + u.username : '—')}</td>
        <td>${escapeHtml([u.first_name, u.last_name].filter(Boolean).join(' ') || '—')}</td>
        <td>${new Date(u.first_seen).toISOString().slice(0, 16).replace('T', ' ')}</td>
        <td>${new Date(u.last_seen).toISOString().slice(0, 16).replace('T', ' ')}</td>
        <td>${u.starts}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>IPDC Bot — статистика</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0f1115; color:#e6e6e6; margin:0; padding:24px; }
  h1 { font-size:20px; margin-bottom:4px; }
  .sub { color:#9aa0aa; margin-bottom:24px; font-size:13px; }
  .cards { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:32px; }
  .card { background:#171a21; border:1px solid #262b36; border-radius:10px; padding:16px 20px; min-width:140px; }
  .card .label { color:#9aa0aa; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card .value { font-size:26px; font-weight:600; margin-top:4px; }
  table { border-collapse:collapse; width:100%; margin-bottom:32px; font-size:13px; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid #262b36; white-space:nowrap; }
  th { color:#9aa0aa; font-weight:500; }
  .bar-track { display:inline-block; width:100px; height:8px; background:#262b36; border-radius:4px; overflow:hidden; vertical-align:middle; margin-right:8px; }
  .bar { height:100%; border-radius:4px; }
  .bar-new { background:#5b9dff; }
  .bar-starts { background:#4cd97b; }
  .section-title { font-size:15px; margin:24px 0 10px; color:#e6e6e6; }
  .broadcast-box { background:#171a21; border:1px solid #262b36; border-radius:10px; padding:16px 20px; max-width:560px; }
  .broadcast-box textarea { width:100%; box-sizing:border-box; background:#0f1115; color:#e6e6e6; border:1px solid #262b36; border-radius:8px; padding:10px; font-family:inherit; font-size:13px; resize:vertical; }
  .broadcast-box .row { margin-top:12px; display:flex; align-items:center; gap:12px; }
  .broadcast-box button { background:#5b9dff; color:#0f1115; border:none; border-radius:8px; padding:8px 18px; font-weight:600; font-size:13px; cursor:pointer; }
  .broadcast-box button:disabled { opacity:.6; cursor:default; }
  .broadcast-box .status { color:#9aa0aa; font-size:13px; }
</style>
</head>
<body>
  <h1>IPDC Bot — статистика</h1>
  <div class="sub">Обновлено: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>

  <div class="cards">
    <div class="card"><div class="label">Всего пользователей</div><div class="value">${totalUsers}</div></div>
    <div class="card"><div class="label">Всего /start</div><div class="value">${totalStarts}</div></div>
    <div class="card"><div class="label">Новые сегодня</div><div class="value">${newUsersIn(86400000)}</div></div>
    <div class="card"><div class="label">Новые за 7 дней</div><div class="value">${newUsersIn(7 * 86400000)}</div></div>
    <div class="card"><div class="label">Старты сегодня</div><div class="value">${startsIn(86400000)}</div></div>
    <div class="card"><div class="label">Старты за 7 дней</div><div class="value">${startsIn(7 * 86400000)}</div></div>
  </div>

  <div class="section-title">Рассылка сообщения (${totalUsers} получателей)</div>
  <div class="broadcast-box">
    <textarea id="broadcastText" rows="4" placeholder="Текст сообщения всем пользователям бота"></textarea>
    <div class="row">
      <button id="broadcastBtn" onclick="sendBroadcast()">Отправить всем</button>
      <span id="broadcastStatus" class="status"></span>
    </div>
  </div>

  <div class="section-title">Динамика за 14 дней</div>
  <table>
    <thead><tr><th>Дата</th><th>Новые пользователи</th><th>Старты</th></tr></thead>
    <tbody>${chartRows}</tbody>
  </table>

  <div class="section-title">Последние пользователи</div>
  <table>
    <thead><tr><th>ID</th><th>Username</th><th>Имя</th><th>Первый заход</th><th>Последний заход</th><th>Кол-во стартов</th></tr></thead>
    <tbody>${recentUsers || '<tr><td colspan="6">Пока нет данных</td></tr>'}</tbody>
  </table>

  <script>
    async function sendBroadcast(){
      const btn = document.getElementById('broadcastBtn');
      const status = document.getElementById('broadcastStatus');
      const textEl = document.getElementById('broadcastText');
      const text = textEl.value.trim();
      if(!text){ status.textContent = 'Введите текст сообщения'; return; }
      if(!confirm('Отправить это сообщение всем пользователям бота (${totalUsers})?')) return;
      btn.disabled = true;
      status.textContent = 'Отправка...';
      try {
        const res = await fetch('/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ${JSON.stringify(token || '')} },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        if (res.ok) {
          status.textContent = 'Готово: отправлено ' + data.sent + ' из ' + data.total + (data.failed ? (', не доставлено: ' + data.failed) : '');
          textEl.value = '';
        } else {
          status.textContent = 'Ошибка: ' + (data.error || res.status);
        }
      } catch (e) {
        status.textContent = 'Ошибка сети';
      }
      btn.disabled = false;
    }
  </script>
</body>
</html>`;
}

function checkAuth(req, url) {
  const token = url.searchParams.get('token') || req.headers['x-admin-token'];
  return token === ADMIN_TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const certDir = path.join('/root/cert', 'panelfin.r-company.shop');
const serverOptions = {
  cert: fs.readFileSync(path.join(certDir, 'fullchain.pem')),
  key: fs.readFileSync(path.join(certDir, 'privkey.pem')),
};

https.createServer(serverOptions, async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/broadcast') {
    if (!checkAuth(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}');
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      if (!text || text.length > 4000) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Нужен текст сообщения (до 4000 символов)' }));
        return;
      }
      const result = await broadcastMessage(text);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('broadcast error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Рассылка не удалась' }));
    }
    return;
  }

  if (url.pathname !== '/' && url.pathname !== '/stats') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (!checkAuth(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized');
    return;
  }
  const token = url.searchParams.get('token') || req.headers['x-admin-token'];
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPanel(token));
}).listen(STATS_PORT, () => {
  console.log(`Stats panel listening on :${STATS_PORT}`);
});
