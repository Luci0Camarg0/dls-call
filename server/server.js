// DLS Call — servidor
// Faz só duas coisas, por isso é leve:
//   1) entrega o site (pasta public/)
//   2) apresenta os amigos uns aos outros (sinalização WebRTC).
// Voz e tela vão direto de um PC para o outro (peer-to-peer); não passam por aqui.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INVITE_SECRET = process.env.INVITE_SECRET || 'dls-call-segredo-padrao-troque-me';
const MAX_PER_ROOM = 10;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!process.env.INVITE_SECRET) {
  console.warn('[aviso] INVITE_SECRET não definido; usando o segredo padrão.');
}

// ---------- Códigos de convite ----------
// O código carrega a própria assinatura (HMAC), então não precisa de banco de dados:
// um convite criado hoje continua valendo mesmo depois que o servidor reinicia.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O/0/I/1 para não confundir

function signature(body) {
  const h = crypto.createHmac('sha256', INVITE_SECRET).update(body).digest();
  let s = '';
  for (let i = 0; i < 3; i++) s += ALPHABET[h[i] % ALPHABET.length];
  return s;
}

function newInvite() {
  const bytes = crypto.randomBytes(5);
  let body = '';
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length];
  const code = body + signature(body);
  return code.slice(0, 4) + '-' + code.slice(4);
}

function normalizeInvite(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 8) return null;
  for (const c of clean) if (!ALPHABET.includes(c)) return null;
  const body = clean.slice(0, 5);
  if (signature(body) !== clean.slice(5)) return null;
  return clean.slice(0, 4) + '-' + clean.slice(4);
}

// ---------- Servidores ICE (STUN/TURN) ----------
// STUN gratuito resolve a maioria das conexões. TURN é opcional (ver LEIA-ME).
const DEFAULT_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];
let cfCache = { at: 0, servers: null };

async function getIceServers() {
  if (process.env.ICE_SERVERS) {
    try { return JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('[aviso] ICE_SERVERS inválido'); }
  }
  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_API_TOKEN;
  if (keyId && token) {
    if (cfCache.servers && Date.now() - cfCache.at < 12 * 3600 * 1000) return cfCache.servers;
    // A Cloudflare tem dois endereços para isso (novo e antigo); tenta os dois.
    for (const ep of ['generate-ice-servers', 'generate']) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/${ep}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        });
        if (!r.ok) { console.warn(`[aviso] TURN Cloudflare (${ep}) respondeu ${r.status}`); continue; }
        const j = await r.json();
        const list = (Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers]).filter(Boolean);
        if (!list.length) continue;
        cfCache = { at: Date.now(), servers: [...DEFAULT_ICE, ...list] };
        console.log('[ok] TURN da Cloudflare ativo');
        return cfCache.servers;
      } catch (e) {
        console.warn('[aviso] falha ao obter TURN da Cloudflare:', e.message);
      }
    }
  }
  return DEFAULT_ICE;
}

// ---------- Site estático ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/invite' && req.method === 'POST') return sendJson(res, 200, { code: newInvite() });

  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }

  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- Sinalização ----------
const rooms = new Map(); // código -> Map(id -> cliente)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return s || 'Amigo';
}

// ---------- Ouvir junto (YouTube) ----------
// O servidor guarda "o que está tocando e em que segundo"; cada PC toca o vídeo
// no próprio player do YouTube e se acerta por essa referência.
const musicByRoom = new Map(); // código -> estado
const titleCache = new Map();
const MAX_QUEUE = 50;

function youtubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (!id && m) id = m[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

async function youtubeTitle(id) {
  if (titleCache.has(id)) return titleCache.get(id);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`,
      { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const t = String((await r.json()).title || '').slice(0, 120);
      if (t) { titleCache.set(id, t); return t; }
    }
  } catch {}
  return 'Vídeo do YouTube';
}

function music(code) {
  let m = musicByRoom.get(code);
  if (!m) {
    m = { queue: [], current: null, playing: false, position: 0, updatedAt: Date.now() };
    musicByRoom.set(code, m);
  }
  return m;
}

function musicPos(m) {
  return m.playing ? m.position + (Date.now() - m.updatedAt) / 1000 : m.position;
}

function setMusicPos(m, pos, playing) {
  m.position = Math.max(0, pos);
  m.playing = playing;
  m.updatedAt = Date.now();
}

function nextTrack(m) {
  m.current = m.queue.shift() || null;
  setMusicPos(m, 0, !!m.current);
}

function musicMsg(m) {
  return { type: 'music', state: m, now: Date.now() };
}

async function handleMusic(me, room, msg) {
  const m = music(me.room);
  const a = msg.action;
  if (a === 'add') {
    const id = youtubeId(msg.url);
    if (!id) return send(me.ws, { type: 'toast', message: 'Link do YouTube inválido.' });
    if (m.queue.length >= MAX_QUEUE) return send(me.ws, { type: 'toast', message: 'A fila está cheia.' });
    const item = { key: crypto.randomBytes(4).toString('hex'), id, title: await youtubeTitle(id), by: me.name };
    if (!m.current) { m.current = item; setMusicPos(m, 0, true); }
    else m.queue.push(item);
  } else if (a === 'toggle' && m.current) {
    setMusicPos(m, musicPos(m), !m.playing);
  } else if (a === 'seek' && m.current) {
    setMusicPos(m, Number(msg.t) || 0, m.playing);
  } else if (a === 'skip') {
    nextTrack(m);
  } else if ((a === 'ended' || a === 'error') && m.current && m.current.key === msg.key) {
    // Vários PCs avisam que acabou; só o primeiro aviso daquela música conta.
    nextTrack(m);
  } else if (a === 'remove') {
    m.queue = m.queue.filter((x) => x.key !== msg.key);
  } else if (a === 'clear') {
    m.queue = [];
    m.current = null;
    setMusicPos(m, 0, false);
  } else return;
  for (const p of room.values()) send(p.ws, musicMsg(m));
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  let me = null; // { id, name, room, state, ws }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join' && !me) {
      const code = normalizeInvite(msg.code);
      if (!code) return send(ws, { type: 'error', message: 'Código de convite inválido.' });
      const room = rooms.get(code) || new Map();
      if (room.size >= MAX_PER_ROOM) {
        return send(ws, { type: 'error', message: `A call está cheia (máximo ${MAX_PER_ROOM}).` });
      }
      me = {
        id: crypto.randomBytes(6).toString('hex'),
        name: cleanName(msg.name),
        room: code,
        state: { muted: false, deafened: false, sharing: false },
        ws,
      };
      const peers = [...room.values()].map((p) => ({ id: p.id, name: p.name, state: p.state }));
      room.set(me.id, me);
      rooms.set(code, room);
      send(ws, { type: 'welcome', id: me.id, code, peers, iceServers: await getIceServers() });
      if (musicByRoom.has(code)) send(ws, musicMsg(musicByRoom.get(code)));
      for (const p of room.values()) {
        if (p.id !== me.id) send(p.ws, { type: 'peer-joined', id: me.id, name: me.name, state: me.state });
      }
      return;
    }

    if (!me) return;
    const room = rooms.get(me.room);
    if (!room) return;

    if (msg.type === 'signal' || msg.type === 'watch') {
      const target = room.get(msg.to);
      if (target) send(target.ws, { type: msg.type, from: me.id, data: msg.data, on: msg.on });
    } else if (msg.type === 'state') {
      me.state = {
        muted: !!msg.state?.muted,
        deafened: !!msg.state?.deafened,
        sharing: !!msg.state?.sharing,
      };
      for (const p of room.values()) {
        if (p.id !== me.id) send(p.ws, { type: 'state', id: me.id, state: me.state });
      }
    } else if (msg.type === 'music') {
      await handleMusic(me, room, msg);
    }
  });

  ws.on('close', () => {
    if (!me) return;
    const room = rooms.get(me.room);
    if (!room) return;
    room.delete(me.id);
    if (room.size === 0) { rooms.delete(me.room); musicByRoom.delete(me.room); }
    else for (const p of room.values()) send(p.ws, { type: 'peer-left', id: me.id });
  });
});

// Derruba conexões mortas e mantém proxies (Render etc.) acordados.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`DLS Call rodando em http://localhost:${PORT}`);
});
