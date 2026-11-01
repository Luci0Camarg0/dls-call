// DLS Call — servidor
//   1) entrega o site (pasta public/)
//   2) contas, servidores, chat, fotos e sons (guardados no banco de dados)
//   3) apresenta os amigos uns aos outros na call (sinalização WebRTC).
// Voz e tela vão direto de um PC para o outro (peer-to-peer); não passam por aqui.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 10;
const PUBLIC_DIR = path.join(__dirname, 'public');
const scrypt = promisify(crypto.scrypt);

// ---------- utilidades ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O/0/I/1 para não confundir

function newId() { return crypto.randomBytes(9).toString('base64url'); }

function randomCode() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += ALPHABET[b % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

function normalizeCode(input) {
  const c = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : null;
}

function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- servidores ICE (STUN/TURN) ----------
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

// ---------- contas ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function checkPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.q('insert into sessions (token_hash, user_id) values ($1, $2)', [sha256(token), userId]);
  return token;
}

async function userFromToken(token) {
  if (!token) return null;
  return db.one(
    'select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1',
    [sha256(String(token))]
  );
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, displayName: u.display_name,
    avatar: u.avatar, banner: u.banner, bannerColor: u.banner_color, createdAt: u.created_at,
  };
}

function meUser(u) {
  return { ...publicUser(u), prefs: u.prefs || {} };
}

function publicServer(s) {
  return { id: s.id, name: s.name, icon: s.icon, invite: s.invite };
}

// Limite simples de tentativas de login por IP (contra chute de senha).
const loginTries = new Map();
function checkLoginRate(ip) {
  const now = Date.now();
  const t = (loginTries.get(ip) || []).filter((x) => now - x < 5 * 60 * 1000);
  if (t.length >= 15) throw new HttpError(429, 'Muitas tentativas. Espere alguns minutos.');
  t.push(now);
  loginTries.set(ip, t);
}

// ---------- membros (com cache em memória) ----------
const memberCache = new Map(); // serverId -> Set(userId)

async function membersOf(serverId) {
  if (!memberCache.has(serverId)) {
    const rows = await db.q('select user_id from members where server_id = $1', [serverId]);
    memberCache.set(serverId, new Set(rows.map((r) => r.user_id)));
  }
  return memberCache.get(serverId);
}

async function requireMember(serverId, userId) {
  const set = await membersOf(String(serverId));
  if (!set.has(userId)) throw new HttpError(403, 'Você não faz parte desse servidor.');
}

// ---------- arquivos (fotos, banners, wallpapers, sons) ----------
const KINDS = {
  avatar: { max: 5e6, types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  banner: { max: 8e6, types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  wallpaper: { max: 8e6, types: ['image/png', 'image/jpeg', 'image/webp'] },
  icon: { max: 5e6, types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  sound: {
    max: 2e6,
    types: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/flac'],
  },
};

async function saveFile(kind, mime, data, ownerId) {
  const k = KINDS[kind];
  mime = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!k.types.includes(mime)) throw new HttpError(415, 'Tipo de arquivo não aceito.');
  if (!data.length) throw new HttpError(400, 'Arquivo vazio.');
  if (data.length > k.max) throw new HttpError(413, `Arquivo grande demais (máximo ${Math.round(k.max / 1e6)} MB).`);
  const id = newId();
  await db.q('insert into files (id, mime, size, data, owner_id) values ($1, $2, $3, $4, $5)',
    [id, mime, data.length, data, ownerId]);
  return id;
}

async function deleteFile(id) {
  if (!id) return;
  fileCache.delete(id);
  await db.q('delete from files where id = $1', [id]);
}

// Guarda em memória os arquivos mais pedidos para não buscar no banco toda hora.
const fileCache = new Map();
let fileCacheBytes = 0;
const FILE_CACHE_MAX = 64e6;

async function getFile(id) {
  if (fileCache.has(id)) {
    const f = fileCache.get(id);
    fileCache.delete(id);
    fileCache.set(id, f);
    return f;
  }
  const row = await db.one('select mime, data from files where id = $1', [id]);
  if (!row) return null;
  const f = { mime: row.mime, data: Buffer.from(row.data) };
  fileCache.set(id, f);
  fileCacheBytes += f.data.length;
  for (const [k, v] of fileCache) {
    if (fileCacheBytes <= FILE_CACHE_MAX) break;
    fileCache.delete(k);
    fileCacheBytes -= v.data.length;
  }
  return f;
}

// ---------- HTTP ----------
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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Arquivo grande demais.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req, 64 * 1024);
  try { return JSON.parse(body.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'JSON inválido.'); }
}

const routes = [];
function route(method, pattern, handler, opts = {}) {
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });
}

async function authed(req) {
  const h = req.headers.authorization || '';
  const user = await userFromToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!user) throw new HttpError(401, 'Faça login novamente.');
  return user;
}

// ---- contas
route('POST', '/api/register', async (req, res) => {
  checkLoginRate(req.socket.remoteAddress);
  const b = await readJson(req);
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw new HttpError(400, 'Usuário: 3 a 20 letras, números, _ ou ponto (sem espaço).');
  if (password.length < 6 || password.length > 100) throw new HttpError(400, 'A senha precisa ter pelo menos 6 caracteres.');
  if (await db.one('select 1 from users where username = $1', [username])) throw new HttpError(409, 'Esse usuário já existe.');
  const id = newId();
  const displayName = cleanText(b.displayName, 32) || username;
  await db.q('insert into users (id, username, display_name, pass_hash) values ($1, $2, $3, $4)',
    [id, username, displayName, await hashPassword(password)]);
  sendJson(res, 200, { token: await newSession(id) });
});

route('POST', '/api/login', async (req, res) => {
  checkLoginRate(req.socket.remoteAddress);
  const b = await readJson(req);
  const u = await db.one('select * from users where username = $1', [String(b.username || '').trim().toLowerCase()]);
  if (!u || !(await checkPassword(String(b.password || ''), u.pass_hash))) {
    throw new HttpError(401, 'Usuário ou senha incorretos.');
  }
  sendJson(res, 200, { token: await newSession(u.id) });
});

route('POST', '/api/logout', async (req, res) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) await db.q('delete from sessions where token_hash = $1', [sha256(h.slice(7))]);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res) => {
  const u = await authed(req);
  const servers = await db.q(
    'select s.* from servers s join members m on m.server_id = s.id where m.user_id = $1 order by m.joined_at',
    [u.id]
  );
  sendJson(res, 200, { me: meUser(u), servers: servers.map(publicServer) });
});

route('PATCH', '/api/me', async (req, res) => {
  const u = await authed(req);
  const b = await readJson(req);
  let displayName = u.display_name;
  let bannerColor = u.banner_color;
  const prefs = { ...(u.prefs || {}) };
  if (b.displayName !== undefined) displayName = cleanText(b.displayName, 32) || u.username;
  if (b.bannerColor !== undefined) bannerColor = /^#[0-9a-f]{6}$/i.test(b.bannerColor) ? b.bannerColor : null;
  const p = b.prefs || {};
  if (p.blur !== undefined) prefs.blur = Math.max(0, Math.min(40, Number(p.blur) || 0));
  if (p.dim !== undefined) prefs.dim = Math.max(0, Math.min(90, Number(p.dim) || 0));
  if (p.soundVol !== undefined) prefs.soundVol = Math.max(0, Math.min(100, Number(p.soundVol) || 0));
  if (p.soundBinds !== undefined && typeof p.soundBinds === 'object') {
    const binds = {};
    for (const [k, v] of Object.entries(p.soundBinds).slice(0, 200)) {
      if (typeof v === 'string' && v.length <= 40) binds[String(k).slice(0, 20)] = v;
    }
    prefs.soundBinds = binds;
  }
  const row = await db.one(
    'update users set display_name = $2, banner_color = $3, prefs = $4 where id = $1 returning *',
    [u.id, displayName, bannerColor, JSON.stringify(prefs)]
  );
  await announceUser(row);
  sendJson(res, 200, { me: meUser(row) });
});

// Uploads de imagem do perfil: avatar, banner e wallpaper.
for (const kind of ['avatar', 'banner', 'wallpaper']) {
  route('POST', `/api/me/${kind}`, async (req, res) => {
    const u = await authed(req);
    const data = await readBody(req, KINDS[kind].max + 1);
    const fileId = await saveFile(kind, req.headers['content-type'], data, u.id);
    let row;
    if (kind === 'wallpaper') {
      await deleteFile(u.prefs?.wallpaper);
      row = await db.one('update users set prefs = $2 where id = $1 returning *',
        [u.id, JSON.stringify({ ...(u.prefs || {}), wallpaper: fileId })]);
    } else {
      await deleteFile(u[kind]);
      row = await db.one(`update users set ${kind} = $2 where id = $1 returning *`, [u.id, fileId]);
    }
    await announceUser(row);
    sendJson(res, 200, { me: meUser(row) });
  }, { raw: true });

  route('DELETE', `/api/me/${kind}`, async (req, res) => {
    const u = await authed(req);
    let row;
    if (kind === 'wallpaper') {
      await deleteFile(u.prefs?.wallpaper);
      const prefs = { ...(u.prefs || {}) };
      delete prefs.wallpaper;
      row = await db.one('update users set prefs = $2 where id = $1 returning *', [u.id, JSON.stringify(prefs)]);
    } else {
      await deleteFile(u[kind]);
      row = await db.one(`update users set ${kind} = null where id = $1 returning *`, [u.id]);
    }
    await announceUser(row);
    sendJson(res, 200, { me: meUser(row) });
  });
}

// ---- servidores
route('POST', '/api/servers', async (req, res) => {
  const u = await authed(req);
  const b = await readJson(req);
  const name = cleanText(b.name, 40);
  if (!name) throw new HttpError(400, 'Dê um nome para o servidor.');
  const id = newId();
  let invite;
  for (;;) {
    invite = randomCode();
    if (!(await db.one('select 1 from servers where invite = $1', [invite]))) break;
  }
  await db.q('insert into servers (id, name, invite, owner_id) values ($1, $2, $3, $4)', [id, name, invite, u.id]);
  await db.q('insert into members (server_id, user_id) values ($1, $2)', [id, u.id]);
  memberCache.delete(id);
  sendJson(res, 200, { server: { id, name, icon: null, invite } });
});

route('POST', '/api/servers/join', async (req, res) => {
  const u = await authed(req);
  const code = normalizeCode((await readJson(req)).code);
  const s = code && (await db.one('select * from servers where invite = $1', [code]));
  if (!s) throw new HttpError(404, 'Convite não encontrado. Confira o código.');
  const set = await membersOf(s.id);
  if (!set.has(u.id)) {
    await db.q('insert into members (server_id, user_id) values ($1, $2) on conflict do nothing', [s.id, u.id]);
    set.add(u.id);
    toServer(s.id, { type: 'member-joined', serverId: s.id, user: { ...publicUser(u), online: true } });
  }
  sendJson(res, 200, { server: publicServer(s) });
});

route('PATCH', '/api/servers/:id', async (req, res, p) => {
  const u = await authed(req);
  await requireMember(p.id, u.id);
  const name = cleanText((await readJson(req)).name, 40);
  if (!name) throw new HttpError(400, 'Dê um nome para o servidor.');
  const s = await db.one('update servers set name = $2 where id = $1 returning *', [p.id, name]);
  toServer(s.id, { type: 'server-update', server: publicServer(s) });
  sendJson(res, 200, { server: publicServer(s) });
});

route('POST', '/api/servers/:id/icon', async (req, res, p) => {
  const u = await authed(req);
  await requireMember(p.id, u.id);
  const data = await readBody(req, KINDS.icon.max + 1);
  const fileId = await saveFile('icon', req.headers['content-type'], data, u.id);
  const old = await db.one('select icon from servers where id = $1', [p.id]);
  await deleteFile(old?.icon);
  const s = await db.one('update servers set icon = $2 where id = $1 returning *', [p.id, fileId]);
  toServer(s.id, { type: 'server-update', server: publicServer(s) });
  sendJson(res, 200, { server: publicServer(s) });
}, { raw: true });

route('DELETE', '/api/servers/:id/membership', async (req, res, p) => {
  const u = await authed(req);
  await requireMember(p.id, u.id);
  await db.q('delete from members where server_id = $1 and user_id = $2', [p.id, u.id]);
  (await membersOf(p.id)).delete(u.id);
  for (const c of userConns.get(u.id) || []) if (c.voice === p.id) leaveVoice(c);
  toServer(p.id, { type: 'member-left', serverId: p.id, userId: u.id });
  if ((await membersOf(p.id)).size === 0) {
    // Ninguém mais no servidor: apaga ele e os arquivos dele.
    const s = await db.one('select icon from servers where id = $1', [p.id]);
    const snd = await db.q('select file from sounds where server_id = $1', [p.id]);
    await db.q('delete from servers where id = $1', [p.id]);
    for (const f of [s?.icon, ...snd.map((x) => x.file)]) await deleteFile(f);
    memberCache.delete(p.id);
  }
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/servers/:id/members', async (req, res, p) => {
  const u = await authed(req);
  await requireMember(p.id, u.id);
  const rows = await db.q(
    'select u.* from users u join members m on m.user_id = u.id where m.server_id = $1 order by u.display_name',
    [p.id]
  );
  sendJson(res, 200, { members: rows.map((r) => ({ ...publicUser(r), online: userConns.has(r.id) })) });
});

route('GET', '/api/servers/:id/messages', async (req, res, p, url) => {
  const u = await authed(req);
  await requireMember(p.id, u.id);
  const before = Number(url.searchParams.get('before')) || null;
  const rows = await db.q(
    `select id, user_id, content, created_at from messages
     where server_id = $1 and ($2::bigint is null or id < $2) order by id desc limit 50`,
    [p.id, before]
  );
  sendJson(res, 200, { messages: rows.reverse().map(publicMessage) });
});

function publicMessage(m) {
  return { id: Number(m.id), userId: m.user_id, content: m.content, createdAt: m.created_at };
}

// ---- soundpad
route('GET', '/api/servers/:id/sounds', async (req, res, p) => {
  const u = await authed(req);
  await requireMember(p.id, u.id);
  const rows = await db.q('select * from sounds where server_id = $1 order by created_at', [p.id]);
  sendJson(res, 200, { sounds: rows.map(publicSound) });
});

function publicSound(s) {
  return { id: s.id, name: s.name, file: s.file, duration: s.duration, createdBy: s.created_by };
}

route('POST', '/api/servers/:id/sounds', async (req, res, p, url) => {
  const u = await authed(req);
  await requireMember(p.id, u.id);
  const name = cleanText(url.searchParams.get('name'), 32) || 'Som';
  const duration = Number(url.searchParams.get('duration'));
  if (!(duration > 0) || duration > 10.5) throw new HttpError(400, 'O som precisa ter no máximo 10 segundos.');
  const count = await db.one('select count(*)::int as n from sounds where server_id = $1', [p.id]);
  if (count.n >= 60) throw new HttpError(400, 'O soundpad deste servidor está cheio (60 sons).');
  const data = await readBody(req, KINDS.sound.max + 1);
  const file = await saveFile('sound', req.headers['content-type'], data, u.id);
  const id = newId();
  const row = await db.one(
    'insert into sounds (id, server_id, name, file, duration, created_by) values ($1, $2, $3, $4, $5, $6) returning *',
    [id, p.id, name, file, duration, u.id]
  );
  toServer(p.id, { type: 'sounds-changed', serverId: p.id });
  sendJson(res, 200, { sound: publicSound(row) });
}, { raw: true });

route('DELETE', '/api/servers/:id/sounds/:sid', async (req, res, p) => {
  const u = await authed(req);
  await requireMember(p.id, u.id);
  const s = await db.one('delete from sounds where id = $1 and server_id = $2 returning file', [p.sid, p.id]);
  if (s) await deleteFile(s.file);
  toServer(p.id, { type: 'sounds-changed', serverId: p.id });
  sendJson(res, 200, { ok: true });
});

// ---- arquivos públicos (nomes aleatórios, nunca mudam: cache longo)
route('GET', '/f/:id', async (req, res, p) => {
  const f = await getFile(p.id);
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'Content-Type': f.mime,
    'Content-Length': f.data.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  res.end(f.data);
});

route('GET', '/health', async (req, res) => sendJson(res, 200, { ok: true }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) return await r.handler(req, res, m.groups || {}, url);
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Não encontrado.');
    serveStatic(url, res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Erro no servidor.' });
  }
});

function serveStatic(url, res) {
  const file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
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
}

// ---------- tempo real (WebSocket) ----------
const conns = new Map(); // connId -> conexão
const userConns = new Map(); // userId -> Set(conexão)
const voiceRooms = new Map(); // serverId -> Map(connId -> conexão)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

function send(c, msg) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

// Manda para todos os membros do servidor que estão online.
function toServer(serverId, msg) {
  const set = memberCache.get(serverId);
  if (!set) return;
  for (const uid of set) for (const c of userConns.get(uid) || []) send(c, msg);
}

// Avisa quem divide servidor com essa pessoa que o perfil dela mudou.
async function announceUser(row) {
  for (const c of userConns.get(row.id) || []) c.displayName = row.display_name;
  const rows = await db.q('select server_id from members where user_id = $1', [row.id]);
  const targets = new Set();
  for (const r of rows) for (const uid of await membersOf(r.server_id)) targets.add(uid);
  const msg = { type: 'user', user: publicUser(row) };
  for (const uid of targets) for (const c of userConns.get(uid) || []) send(c, msg);
}

function roster(serverId) {
  const room = voiceRooms.get(serverId);
  return room ? [...room.values()].map((c) => ({ connId: c.id, userId: c.userId, state: c.state })) : [];
}

function sendRoster(serverId) {
  toServer(serverId, { type: 'voice-roster', serverId, members: roster(serverId) });
}

async function joinVoice(c, serverId) {
  await requireMember(serverId, c.userId);
  if (c.voice === serverId) return;
  if (c.voice) leaveVoice(c);
  // Mesma conta em outro aparelho: tira o outro da call.
  for (const other of userConns.get(c.userId) || []) {
    if (other !== c && other.voice) {
      send(other, { type: 'voice-kicked', message: 'Você entrou na call em outro aparelho.' });
      leaveVoice(other);
    }
  }
  const room = voiceRooms.get(serverId) || new Map();
  if (room.size >= MAX_PER_ROOM) throw new HttpError(409, `A call está cheia (máximo ${MAX_PER_ROOM}).`);
  const peers = [...room.values()].map((p) => ({ connId: p.id, userId: p.userId, state: p.state }));
  c.voice = serverId;
  c.state = { muted: false, deafened: false, sharing: false };
  room.set(c.id, c);
  voiceRooms.set(serverId, room);
  send(c, { type: 'voice-welcome', serverId, connId: c.id, peers, iceServers: await getIceServers() });
  if (musicByRoom.has(serverId)) send(c, musicMsg(serverId, musicByRoom.get(serverId)));
  for (const p of room.values()) if (p !== c) send(p, { type: 'peer-joined', connId: c.id, userId: c.userId, state: c.state });
  sendRoster(serverId);
}

function leaveVoice(c) {
  const serverId = c.voice;
  if (!serverId) return;
  c.voice = null;
  const room = voiceRooms.get(serverId);
  if (room) {
    room.delete(c.id);
    if (room.size === 0) { voiceRooms.delete(serverId); musicByRoom.delete(serverId); }
    else for (const p of room.values()) send(p, { type: 'peer-left', connId: c.id });
  }
  sendRoster(serverId);
}

// ---------- ouvir junto (YouTube) ----------
// O servidor guarda "o que está tocando e em que segundo"; cada PC toca o vídeo
// no próprio player do YouTube e se acerta por essa referência.
const musicByRoom = new Map(); // serverId -> estado
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

function music(serverId) {
  let m = musicByRoom.get(serverId);
  if (!m) {
    m = { queue: [], current: null, playing: false, position: 0, updatedAt: Date.now() };
    musicByRoom.set(serverId, m);
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

function musicMsg(serverId, m) {
  return { type: 'music', serverId, state: m, now: Date.now() };
}

async function handleMusic(c, msg) {
  const room = voiceRooms.get(c.voice);
  if (!room) return;
  const m = music(c.voice);
  const a = msg.action;
  if (a === 'add') {
    const id = youtubeId(msg.url);
    if (!id) return send(c, { type: 'toast', message: 'Link do YouTube inválido.' });
    if (m.queue.length >= MAX_QUEUE) return send(c, { type: 'toast', message: 'A fila está cheia.' });
    const item = { key: crypto.randomBytes(4).toString('hex'), id, title: await youtubeTitle(id), by: c.displayName };
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
  for (const p of room.values()) send(p, musicMsg(c.voice, m));
}

// ---------- mensagens do WebSocket ----------
const chatRate = new Map(); // userId -> [timestamps]

async function handleChat(c, msg) {
  const serverId = String(msg.serverId || '');
  await requireMember(serverId, c.userId);
  const content = String(msg.content || '').replace(/\r/g, '').trim().slice(0, 2000);
  if (!content) return;
  const now = Date.now();
  const recent = (chatRate.get(c.userId) || []).filter((t) => now - t < 5000);
  if (recent.length >= 8) return send(c, { type: 'toast', message: 'Calma! Você está mandando mensagens rápido demais.' });
  recent.push(now);
  chatRate.set(c.userId, recent);
  const row = await db.one(
    'insert into messages (server_id, user_id, content) values ($1, $2, $3) returning id, user_id, content, created_at',
    [serverId, c.userId, content]
  );
  toServer(serverId, { type: 'chat', serverId, message: publicMessage(row), nonce: msg.nonce });
}

async function handleChatDelete(c, msg) {
  const serverId = String(msg.serverId || '');
  const row = await db.one('delete from messages where id = $1 and server_id = $2 and user_id = $3 returning id',
    [Number(msg.id) || 0, serverId, c.userId]);
  if (row) toServer(serverId, { type: 'chat-delete', serverId, id: Number(row.id) });
}

const soundRate = new Map();

function handleSound(c, msg) {
  const room = voiceRooms.get(c.voice);
  if (!room) return;
  const now = Date.now();
  if (now - (soundRate.get(c.id) || 0) < 600) return;
  soundRate.set(c.id, now);
  const out = { type: 'sound', soundId: String(msg.soundId || '').slice(0, 20), userId: c.userId };
  for (const p of room.values()) send(p, out);
}

wss.on('connection', (ws) => {
  const c = { id: crypto.randomBytes(6).toString('hex'), ws, userId: null, voice: null, state: {} };
  ws.on('pong', () => { ws.dead = false; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'auth' && !c.userId) {
        const u = await userFromToken(msg.token);
        if (!u) return send(c, { type: 'auth-failed' });
        c.userId = u.id;
        c.displayName = u.display_name;
        conns.set(c.id, c);
        const first = !userConns.has(u.id);
        if (first) userConns.set(u.id, new Set());
        userConns.get(u.id).add(c);
        const servers = await db.q('select server_id from members where user_id = $1', [u.id]);
        const rosters = {};
        for (const s of servers) {
          await membersOf(s.server_id);
          rosters[s.server_id] = roster(s.server_id);
          if (first) toServer(s.server_id, { type: 'presence', userId: u.id, online: true });
        }
        return send(c, { type: 'ready', connId: c.id, rosters });
      }
      if (!c.userId) return;

      switch (msg.type) {
        case 'voice-join': await joinVoice(c, String(msg.serverId || '')); break;
        case 'voice-leave': leaveVoice(c); break;
        case 'signal':
        case 'watch': {
          const target = voiceRooms.get(c.voice)?.get(msg.to);
          if (target) send(target, { type: msg.type, from: c.id, data: msg.data, on: msg.on });
          break;
        }
        case 'state': {
          if (!c.voice) break;
          c.state = { muted: !!msg.state?.muted, deafened: !!msg.state?.deafened, sharing: !!msg.state?.sharing };
          for (const p of voiceRooms.get(c.voice)?.values() || []) {
            if (p !== c) send(p, { type: 'state', connId: c.id, state: c.state });
          }
          sendRoster(c.voice);
          break;
        }
        case 'chat': await handleChat(c, msg); break;
        case 'chat-delete': await handleChatDelete(c, msg); break;
        case 'music': await handleMusic(c, msg); break;
        case 'sound': handleSound(c, msg); break;
      }
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(c, { type: 'toast', message: e instanceof HttpError ? e.message : 'Erro no servidor.' });
    }
  });

  ws.on('close', async () => {
    if (!c.userId) return;
    leaveVoice(c);
    conns.delete(c.id);
    const set = userConns.get(c.userId);
    set?.delete(c);
    if (set && set.size === 0) {
      userConns.delete(c.userId);
      try {
        const servers = await db.q('select server_id from members where user_id = $1', [c.userId]);
        for (const s of servers) toServer(s.server_id, { type: 'presence', userId: c.userId, online: false });
      } catch {}
    }
  });
});

// Derruba conexões mortas e mantém proxies (Render etc.) acordados.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.dead) { ws.terminate(); continue; }
    ws.dead = true;
    ws.ping();
  }
}, 25000);

db.init().then(() => {
  server.listen(PORT, () => console.log(`DLS Call rodando em http://localhost:${PORT}`));
}).catch((e) => {
  console.error('Falha ao abrir o banco de dados:', e);
  process.exit(1);
});
