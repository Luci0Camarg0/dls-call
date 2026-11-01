'use strict';
// DLS Call — base compartilhada pelos outros scripts: estado global, API, WebSocket e utilidades.

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const desktop = window.dlsDesktop || null; // existe só dentro do app .exe

// Estado do app (conta, servidores, quem está online etc.)
const G = {
  token: null,
  me: null,
  servers: [],
  serverId: null, // servidor aberto na tela
  view: 'chat', // 'chat' | 'voice'
  users: new Map(), // userId -> usuário
  members: new Map(), // serverId -> [userId]
  online: new Set(),
  rosters: new Map(), // serverId -> [{connId, userId, state}]
  unread: new Set(),
  ws: null, connId: null, wsReady: false, wsHandlers: {},
  showMembers: true,
};

// ---------- utilidades ----------
const store = {
  get(k) { try { return localStorage.getItem('dls:' + k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem('dls:' + k); else localStorage.setItem('dls:' + k, v); } catch {} },
};

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function svg(path, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.innerHTML = `<path fill="currentColor" d="${path}"/>`;
  return s;
}
const ICON_MIC_OFF = 'M15 10.6V5a3 3 0 0 0-5.9-.8L15 10.6zM19 12h-2c0 .7-.2 1.4-.4 2l1.5 1.6A7 7 0 0 0 19 12zM4.3 3 3 4.3l6 6V12a3 3 0 0 0 4.5 2.6l1.6 1.6A5 5 0 0 1 7 12H5a7 7 0 0 0 6 6.9V22h2v-3.1c1-.1 2-.5 2.8-1l3.9 3.9 1.3-1.3L4.3 3z';
const ICON_DEAF = 'M3.3 2 2 3.3l2.4 2.4A9 9 0 0 0 3 12v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1c0-1.3.4-2.5 1-3.6L19.7 22l1.3-1.3L3.3 2zM12 5a7 7 0 0 1 7 7v1h-2a2 2 0 0 0-1.5.7l5 5 .5.1V12a9 9 0 0 0-14-7.5l1.5 1.4A7 7 0 0 1 12 5z';
const ICON_SCREEN = 'M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h5v2H7v2h10v-2h-2v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11z';

function colorFor(name) {
  let x = 0;
  for (const c of String(name)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 55% 48%)`;
}

const fileUrl = (id) => (id ? `/f/${encodeURIComponent(id)}` : null);

function userById(id) {
  if (G.me && id === G.me.id) return G.me;
  return G.users.get(id) || { id, displayName: 'Alguém', username: '?' };
}

// Avatar redondo: a foto (ou GIF) da pessoa, ou a inicial colorida.
function avatarEl(user, cls = '', speakKey = null) {
  const name = user?.displayName || '?';
  const el = h('span', { class: 'avatar ' + cls, dataset: speakKey ? { speak: speakKey } : undefined });
  if (user?.avatar) {
    el.append(h('img', { src: fileUrl(user.avatar), alt: '', draggable: 'false', loading: 'lazy' }));
  } else {
    el.textContent = (name[0] || '?').toUpperCase();
    el.style.setProperty('--c', colorFor(user?.username || name));
  }
  return el;
}

function serverIconEl(s, cls = '') {
  const el = h('span', { class: 'srv-icon ' + cls });
  if (s?.icon) el.append(h('img', { src: fileUrl(s.icon), alt: '', draggable: 'false' }));
  else {
    el.textContent = String(s?.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  }
  return el;
}

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- som (um AudioContext para bipes, soundpad e medidor do microfone) ----------
let actx = null;
function audioCtx() {
  if (!actx) {
    actx = new AudioContext();
    const out = store.get('out');
    if (out && actx.setSinkId) actx.setSinkId(out).catch(() => {});
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}

function beep(kind) {
  if (!actx) return;
  const notes = { join: [520, 780], leave: [780, 520], on: [660], off: [440], live: [600, 900], msg: [880] }[kind];
  if (!notes) return;
  const t0 = actx.currentTime;
  notes.forEach((f, i) => {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.09);
    g.gain.exponentialRampToValueAtTime(kind === 'msg' ? 0.04 : 0.08, t0 + i * 0.09 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.12);
    o.connect(g).connect(actx.destination);
    o.start(t0 + i * 0.09);
    o.stop(t0 + i * 0.09 + 0.13);
  });
}

// ---------- API ----------
async function api(method, path, body, opts = {}) {
  const headers = {};
  if (G.token) headers.Authorization = 'Bearer ' + G.token;
  let payload;
  if (body instanceof Blob) {
    payload = body;
    headers['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let r;
  try {
    r = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new Error('Sem conexão com o servidor.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !opts.noLogout && G.token) { logout(true); }
  if (!r.ok) throw Object.assign(new Error(j.error || 'Algo deu errado.'), { status: r.status });
  return j;
}

// ---------- imagens: diminui fotos antes de enviar (GIF vai como está, para não perder a animação) ----------
const UPLOAD_LIMITS = { avatar: 5e6, banner: 8e6, wallpaper: 8e6, icon: 5e6 };
const IMAGE_SIZES = { avatar: [256, 256, true], icon: [256, 256, true], banner: [960, 380, false], wallpaper: [1920, 1080, false] };

async function prepareImage(file, kind) {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem.');
  if (file.type === 'image/gif') {
    if (kind === 'wallpaper') throw new Error('Para o wallpaper use JPG, PNG ou WebP.');
    if (file.size > UPLOAD_LIMITS[kind]) throw new Error(`GIF grande demais (máximo ${UPLOAD_LIMITS[kind] / 1e6} MB).`);
    return file;
  }
  const [maxW, maxH, square] = IMAGE_SIZES[kind];
  const bmp = await createImageBitmap(file);
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height, w, hgt;
  if (square) {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side;
    w = hgt = Math.min(maxW, side);
  } else {
    const scale = Math.min(1, maxW / sw, maxH / sh);
    w = Math.round(sw * scale); hgt = Math.round(sh * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = hgt;
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, w, hgt);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.86));
  if (!blob) throw new Error('Não foi possível ler essa imagem.');
  return blob;
}

// ---------- WebSocket (tempo real) ----------
function on(type, fn) { (G.wsHandlers[type] ||= []).push(fn); }
function wsSend(msg) { if (G.ws?.readyState === 1 && G.wsReady) G.ws.send(JSON.stringify(msg)); }

let wsRetry = 0;
function connectWs() {
  if (!G.token) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  G.ws = ws;
  G.wsReady = false;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: G.token }));
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'ready') { G.wsReady = true; G.connId = msg.connId; wsRetry = 0; }
    if (msg.type === 'auth-failed') { logout(true); return; }
    for (const fn of G.wsHandlers[msg.type] || []) {
      try { fn(msg); } catch (err) { console.error(err); }
    }
  };
  ws.onclose = () => {
    if (G.ws !== ws) return;
    G.wsReady = false;
    for (const fn of G.wsHandlers['ws-closed'] || []) fn();
    if (!G.token) return;
    setTimeout(connectWs, Math.min(10000, 1500 * ++wsRetry));
  };
}

on('toast', (m) => toast(m.message, 3500));

// Mantém o servidor gratuito acordado enquanto o app está aberto.
setInterval(() => { if (G.token) fetch('/health').catch(() => {}); }, 4 * 60 * 1000);

// Fecha modais com Esc ou clicando fora.
function closeModals() {
  $$('.modal').forEach((m) => { if (!m.classList.contains('hidden')) { m.classList.add('hidden'); m.dispatchEvent(new Event('closed')); } });
}
function openModal(id) { $(id).classList.remove('hidden'); }
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModals();
  else if (e.target.classList?.contains('modal')) closeModals();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal-bind:not(.hidden)')) closeModals(); });

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
