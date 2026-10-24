'use strict';
// DLS Call — cliente (roda no site e dentro do app .exe)
//
// Como funciona: cada amigo se conecta direto com cada outro amigo (WebRTC, peer-to-peer).
// Cada conexão tem 3 "canais" fixos: [0] microfone, [1] vídeo da tela, [2] som do PC.
// Ligar/desligar a tela é só trocar a faixa do canal (replaceTrack), sem renegociar nada.
// E a tela só é enviada para quem clicou em "Assistir", para poupar a internet de quem transmite.

const $ = (s) => document.querySelector(s);
const desktop = window.dlsDesktop || null; // existe só dentro do app .exe
const VIDEO_CODEC_ORDER = ['video/H264', 'video/VP8']; // H264 costuma ter aceleração por placa de vídeo

const S = {
  ws: null, myId: null, code: null, name: '', iceServers: [],
  joined: false, leaving: false,
  mic: null, micTrack: null, noise: true, micId: '',
  muted: false, deafened: false,
  screen: null, screenVideo: null, screenAudio: null, fps: 30, previewSelf: false,
  watchers: new Set(),
  peers: new Map(),
  focused: null,
  actx: null, analyser: null, micSource: null,
  timers: [],
};

// ---------- utilidades ----------
const store = {
  get(k) { try { return localStorage.getItem('dls:' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('dls:' + k, v); } catch {} },
};

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
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

function colorFor(name) {
  let x = 0;
  for (const c of name) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 55% 48%)`;
}

function avatar(name, id, cls = '') {
  const a = h('div', { class: 'avatar ' + cls, text: (name[0] || '?').toUpperCase(), dataset: { speak: id } });
  a.style.setProperty('--c', colorFor(name));
  return a;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function beep(kind) {
  if (!S.actx) return;
  const notes = { join: [520, 780], leave: [780, 520], on: [660], off: [440], live: [600, 900] }[kind];
  if (!notes) return;
  const t0 = S.actx.currentTime;
  notes.forEach((f, i) => {
    const o = S.actx.createOscillator();
    const g = S.actx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.09);
    g.gain.exponentialRampToValueAtTime(0.08, t0 + i * 0.09 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.12);
    o.connect(g).connect(S.actx.destination);
    o.start(t0 + i * 0.09);
    o.stop(t0 + i * 0.09 + 0.13);
  });
}

// ---------- tela de entrada ----------
const inName = $('#in-name');
const inCode = $('#in-code');
inName.value = store.get('name') || '';
inCode.value = store.get('code') || '';

inCode.addEventListener('input', () => {
  let v = inCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4);
  inCode.value = v;
});
for (const el of [inName, inCode]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

function loginError(msg) { $('#login-error').textContent = msg || ''; }
function setBusy(b) { $('#btn-join').disabled = b; $('#btn-create').disabled = b; }

function checkName() {
  const n = inName.value.trim();
  if (!n) { loginError('Digite seu nome primeiro.'); inName.focus(); return null; }
  return n;
}

$('#btn-join').addEventListener('click', () => {
  const name = checkName();
  if (!name) return;
  if (inCode.value.replace('-', '').length !== 8) { loginError('Digite o código de convite (8 letras/números).'); inCode.focus(); return; }
  start(name, inCode.value);
});

$('#btn-create').addEventListener('click', async () => {
  const name = checkName();
  if (!name) return;
  setBusy(true);
  loginError('');
  try {
    const r = await fetch('/api/invite', { method: 'POST' });
    const { code } = await r.json();
    inCode.value = code;
    start(name, code);
  } catch {
    loginError('Não foi possível falar com o servidor.');
    setBusy(false);
  }
});

async function start(name, code) {
  setBusy(true);
  loginError('');
  S.name = name;
  S.code = code;
  S.leaving = false;
  store.set('name', name);
  S.noise = store.get('noise') !== '0';
  S.micId = store.get('mic') || '';
  if (!S.actx) S.actx = new AudioContext();
  S.actx.resume();
  await openMic();
  connect();
}

// ---------- microfone ----------
function micConstraints() {
  return {
    deviceId: S.micId ? { ideal: S.micId } : undefined,
    echoCancellation: S.noise, noiseSuppression: S.noise, autoGainControl: true,
    channelCount: 1,
  };
}

async function openMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
    setMic(stream);
    return true;
  } catch (e) {
    console.warn('microfone', e);
    setMic(null);
    S.muted = true;
    toast('Microfone não disponível — você entrou só ouvindo.', 4000);
    return false;
  }
}

function setMic(stream) {
  if (S.mic) S.mic.getTracks().forEach((t) => t.stop());
  S.mic = stream;
  S.micTrack = stream ? stream.getAudioTracks()[0] : null;
  if (S.micTrack) S.micTrack.enabled = !S.muted && !S.deafened;
  for (const p of S.peers.values()) p.tx?.mic.sender.replaceTrack(S.micTrack).catch(() => {});
  if (S.micSource) { S.micSource.disconnect(); S.micSource = null; }
  if (stream && S.actx) {
    S.analyser = S.analyser || Object.assign(S.actx.createAnalyser(), { fftSize: 256 });
    S.micSource = S.actx.createMediaStreamSource(stream);
    S.micSource.connect(S.analyser);
  }
}

function micLevel() {
  if (!S.micSource || !S.analyser) return 0;
  const buf = new Uint8Array(S.analyser.fftSize);
  S.analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
  return Math.sqrt(sum / buf.length);
}

// ---------- servidor (sinalização) ----------
function wsSend(msg) { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(msg)); }
function signal(to, data) { wsSend({ type: 'signal', to, data }); }
function sendState() { wsSend({ type: 'state', state: { muted: S.muted || !S.micTrack, deafened: S.deafened, sharing: !!S.screen } }); }

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => wsSend({ type: 'join', code: S.code, name: S.name });
  ws.onmessage = (e) => { try { onServer(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    if (S.ws !== ws || S.leaving) return;
    if (!S.joined) {
      loginError('Não foi possível conectar ao servidor. Tente de novo.');
      cleanup();
      return;
    }
    setConn('warn', 'Reconectando…');
    teardownPeers();
    render();
    setTimeout(() => { if (!S.leaving && S.joined) connect(); }, 2000);
  };
}

function onServer(msg) {
  switch (msg.type) {
    case 'welcome': {
      S.myId = msg.id;
      S.code = msg.code;
      S.iceServers = msg.iceServers || [];
      store.set('code', msg.code);
      if (!S.joined) { S.joined = true; showCall(); beep('join'); }
      setConn('ok', 'Voz conectada');
      // Quem chega é quem liga para os que já estão na sala.
      for (const p of msg.peers) addPeer(p, true);
      sendState();
      render();
      break;
    }
    case 'peer-joined':
      addPeer(msg, false);
      beep('join');
      render();
      break;
    case 'peer-left':
      removePeer(msg.id);
      beep('leave');
      render();
      break;
    case 'signal': {
      const p = S.peers.get(msg.from);
      if (p) handleSignal(p, msg.data);
      break;
    }
    case 'state': {
      const p = S.peers.get(msg.id);
      if (!p) break;
      const wasSharing = p.state.sharing;
      p.state = msg.state;
      if (!p.state.sharing) {
        p.watching = false;
        if (S.focused === p.id) S.focused = null;
      } else if (!wasSharing) {
        toast(`${p.name} começou a transmitir a tela`);
        beep('live');
      }
      render();
      break;
    }
    case 'watch': {
      if (msg.on) S.watchers.add(msg.from); else S.watchers.delete(msg.from);
      const p = S.peers.get(msg.from);
      if (p) updateScreenSenders(p);
      break;
    }
    case 'error':
      if (!S.joined) { loginError(msg.message); cleanup(); }
      else { toast(msg.message, 4000); leave(); }
      break;
  }
}

// ---------- conexões com cada amigo ----------
function newAudio() {
  const a = h('audio', { autoplay: '' });
  $('#audio-sink').append(a);
  return a;
}

function addPeer({ id, name, state }, initiator) {
  if (S.peers.has(id)) removePeer(id);
  const peer = {
    id, name, state: state || {}, initiator,
    pc: null, tx: null, queue: Promise.resolve(),
    watching: false, connected: false,
    audio: newAudio(), sysAudio: newAudio(), videoStream: null, videoEl: null, info: '',
    volume: Number(store.get('vol:' + name) ?? 1),
  };
  peer.audio.volume = peer.sysAudio.volume = Math.min(1, Math.max(0, peer.volume));
  peer.audio.muted = peer.sysAudio.muted = S.deafened;
  S.peers.set(id, peer);
  createPc(peer);
  if (initiator) negotiate(peer);
}

function removePeer(id) {
  const p = S.peers.get(id);
  if (!p) return;
  p.pc?.close();
  p.audio.remove();
  p.sysAudio.remove();
  S.peers.delete(id);
  S.watchers.delete(id);
  if (S.focused === id) S.focused = null;
}

function teardownPeers() {
  for (const id of [...S.peers.keys()]) removePeer(id);
}

function createPc(peer) {
  const pc = new RTCPeerConnection({ iceServers: S.iceServers, bundlePolicy: 'max-bundle' });
  peer.pc = pc;
  if (peer.initiator) {
    attachTx(peer, [
      pc.addTransceiver('audio', { direction: 'sendrecv' }),
      pc.addTransceiver('video', { direction: 'sendrecv' }),
      pc.addTransceiver('audio', { direction: 'sendrecv' }),
    ]);
  }
  pc.onicecandidate = (e) => { if (e.candidate) signal(peer.id, { candidate: e.candidate }); };
  pc.ontrack = (e) => {
    const idx = pc.getTransceivers().indexOf(e.transceiver);
    const ms = new MediaStream([e.track]);
    if (idx === 0) { peer.audio.srcObject = ms; peer.audio.play().catch(() => {}); }
    else if (idx === 1) { peer.videoStream = ms; if (peer.videoEl) peer.videoEl.srcObject = ms; }
    else if (idx === 2) { peer.sysAudio.srcObject = ms; peer.sysAudio.play().catch(() => {}); }
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    peer.connected = st === 'connected';
    if (st === 'connected') updateScreenSenders(peer);
    if (st === 'failed' && peer.initiator) negotiate(peer, true); // tenta de novo (ICE restart)
    render();
  };
}

function attachTx(peer, t) {
  peer.tx = { mic: t[0], video: t[1], sys: t[2] };
  preferCodecs(t[1]);
  t[0].sender.replaceTrack(S.micTrack).catch(() => {});
  updateScreenSenders(peer);
}

function preferCodecs(tx) {
  try {
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps || !tx.setCodecPreferences) return;
    const rank = (c) => { const i = VIDEO_CODEC_ORDER.indexOf(c.mimeType); return i < 0 ? 99 : i; };
    tx.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
  } catch (e) { console.warn('codecs', e); }
}

function negotiate(peer, iceRestart = false) {
  peer.queue = peer.queue.then(async () => {
    const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await peer.pc.setLocalDescription(offer);
    signal(peer.id, { sdp: peer.pc.localDescription });
  }).catch((e) => console.warn('negotiate', e));
}

function handleSignal(peer, data) {
  peer.queue = peer.queue.then(async () => {
    const pc = peer.pc;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        if (!peer.tx) {
          const t = pc.getTransceivers();
          t.forEach((x) => { x.direction = 'sendrecv'; });
          attachTx(peer, t);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        signal(peer.id, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }).catch((e) => console.warn('signal', e));
}

// Envia a tela só para quem está assistindo.
function updateScreenSenders(peer) {
  if (!peer.tx) return;
  const send = !!S.screen && S.watchers.has(peer.id);
  peer.tx.video.sender.replaceTrack(send ? S.screenVideo : null).catch(() => {});
  peer.tx.sys.sender.replaceTrack(send ? S.screenAudio : null).catch(() => {});
  if (send) applyVideoParams(peer.tx.video.sender);
}

async function applyVideoParams(sender) {
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) return; // ainda negociando; tenta de novo ao conectar
  p.encodings[0].maxBitrate = S.fps >= 60 ? 4_500_000 : 2_500_000;
  p.encodings[0].maxFramerate = S.fps;
  p.degradationPreference = 'maintain-resolution'; // segura os 720p; se faltar internet, cai o fps
  try { await sender.setParameters(p); }
  catch {
    delete p.degradationPreference;
    try { await sender.setParameters(p); } catch (e) { console.warn('params', e); }
  }
}

// ---------- transmissão de tela ----------
let pickedSource = null;
let allSources = [];

async function openShareModal() {
  if (S.screen) { stopShare(); return; }
  $('#sel-fps').value = store.get('fps') || '30';
  $('#chk-audio').checked = store.get('sysaudio') === '1';
  const grid = $('#source-grid');
  grid.innerHTML = '';
  pickedSource = null;
  if (desktop) {
    $('#source-tabs').classList.remove('hidden');
    $('#modal-share').classList.remove('hidden');
    grid.append(h('p', { text: 'Carregando…', class: 'conn-sub' }));
    try { allSources = await desktop.getSources(); } catch { allSources = []; }
    showSources('screen');
  } else {
    $('#source-tabs').classList.add('hidden');
    $('#modal-share').classList.remove('hidden');
  }
}

function showSources(kind) {
  document.querySelectorAll('#source-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === kind));
  const grid = $('#source-grid');
  grid.innerHTML = '';
  const list = allSources.filter((s) => s.kind === kind);
  if (!list.length) grid.append(h('p', { text: 'Nada encontrado.', class: 'conn-sub' }));
  for (const s of list) {
    const el = h('button', { class: 'source' + (pickedSource === s.id ? ' selected' : ''), title: s.name },
      h('img', { src: s.thumbnail, alt: '' }), h('span', { text: s.name }));
    el.addEventListener('click', () => {
      pickedSource = s.id;
      grid.querySelectorAll('.source').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
    });
    el.addEventListener('dblclick', goLive);
    grid.append(el);
  }
  if (!pickedSource && list[0] && kind === 'screen') {
    pickedSource = list[0].id;
    grid.firstChild.classList.add('selected');
  }
}

async function goLive() {
  const fps = Number($('#sel-fps').value) || 30;
  const withAudio = $('#chk-audio').checked;
  if (desktop && !pickedSource) { toast('Escolha uma tela ou janela.'); return; }
  store.set('fps', String(fps));
  store.set('sysaudio', withAudio ? '1' : '0');
  closeModals();
  try {
    if (desktop) await desktop.selectSource(pickedSource, withAudio);
    const video = { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: fps, max: fps } };
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video,
      audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } : false,
      systemAudio: withAudio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude',
    });
    const vt = stream.getVideoTracks()[0];
    vt.contentHint = 'motion';
    vt.applyConstraints(video).catch(() => {});
    vt.addEventListener('ended', stopShare);
    S.fps = fps;
    S.screen = stream;
    S.screenVideo = vt;
    S.screenAudio = stream.getAudioTracks()[0] || null;
    S.watchers.clear();
    S.previewSelf = false;
    sendState();
    beep('live');
    toast('Você está ao vivo! Seus amigos precisam clicar em “Assistir”.', 3500);
    render();
  } catch (e) {
    console.warn('share', e);
    if (e.name !== 'NotAllowedError') toast('Não foi possível transmitir a tela.');
  }
}

function stopShare() {
  if (!S.screen) return;
  S.screen.getTracks().forEach((t) => t.stop());
  S.screen = S.screenVideo = S.screenAudio = null;
  S.watchers.clear();
  for (const p of S.peers.values()) updateScreenSenders(p);
  if (S.focused === S.myId) S.focused = null;
  sendState();
  beep('off');
  render();
}

function setWatching(peer, on) {
  peer.watching = on;
  wsSend({ type: 'watch', to: peer.id, on });
  if (on) S.focused = peer.id;
  else if (S.focused === peer.id) S.focused = null;
  render();
}

// ---------- mudo / ensurdecer ----------
async function toggleMute() {
  if (!S.micTrack) {
    S.muted = false;
    if (!(await openMic())) return;
  } else if (S.deafened) {
    S.deafened = false;
    S.muted = false;
  } else {
    S.muted = !S.muted;
  }
  applyAudioState();
}

function toggleDeafen() {
  S.deafened = !S.deafened;
  applyAudioState();
}

function applyAudioState() {
  if (S.micTrack) S.micTrack.enabled = !S.muted && !S.deafened;
  for (const p of S.peers.values()) p.audio.muted = p.sysAudio.muted = S.deafened;
  beep(S.muted || S.deafened ? 'off' : 'on');
  sendState();
  render();
}

// ---------- telas ----------
function showCall() {
  $('#screen-login').classList.add('hidden');
  $('#screen-call').classList.remove('hidden');
  $('#lbl-code').textContent = S.code;
  $('#lbl-code-small').textContent = S.code;
  $('#me-name').textContent = S.name;
  const av = $('#me-avatar');
  av.textContent = S.name[0].toUpperCase();
  av.style.setProperty('--c', colorFor(S.name));
  av.dataset.speak = 'me';
  setBusy(false);
  startLoops();
}

function setConn(kind, text) {
  const el = $('#conn-status');
  el.className = 'conn ' + kind;
  el.textContent = text;
}

function cleanup() {
  S.leaving = true;
  S.ws?.close();
  S.ws = null;
  teardownPeers();
  if (S.screen) { S.screen.getTracks().forEach((t) => t.stop()); S.screen = S.screenVideo = S.screenAudio = null; }
  setMic(null);
  S.joined = false;
  S.muted = S.deafened = false;
  S.focused = null;
  S.watchers.clear();
  S.timers.forEach(clearInterval);
  S.timers = [];
  tileEls.forEach((el) => el.remove());
  tileEls.clear();
  setBusy(false);
}

function leave() {
  beep('leave');
  cleanup();
  $('#screen-call').classList.add('hidden');
  $('#screen-login').classList.remove('hidden');
}

function render() {
  if (!S.joined) return;
  renderMembers();
  renderTiles();
  const mutedNow = S.muted || S.deafened || !S.micTrack;
  $('#btn-mute').classList.toggle('active', mutedNow);
  $('#btn-mute').title = mutedNow ? 'Ativar microfone' : 'Silenciar microfone';
  $('#btn-deafen').classList.toggle('active', S.deafened);
  $('#btn-deafen').title = S.deafened ? 'Ativar áudio' : 'Desativar áudio';
  const share = $('#btn-share');
  share.classList.toggle('live', !!S.screen);
  share.querySelector('span').textContent = S.screen ? 'Parar transmissão' : 'Compartilhar tela';
}

function people() {
  const me = {
    id: S.myId, name: S.name, me: true, connected: true,
    state: { muted: S.muted || !S.micTrack, deafened: S.deafened, sharing: !!S.screen },
  };
  return [me, ...S.peers.values()];
}

function renderMembers() {
  const list = $('#member-list');
  list.innerHTML = '';
  for (const p of people()) {
    const icons = h('span', { class: 'icons' });
    if (p.state.sharing) icons.append(h('span', { class: 'live-badge', text: 'AO VIVO' }));
    if (p.state.deafened) icons.append(svg(ICON_DEAF));
    else if (p.state.muted) icons.append(svg(ICON_MIC_OFF));
    const li = h('li', { class: 'member' + (p.connected ? '' : ' connecting'), title: p.connected ? '' : 'Conectando…' },
      avatar(p.name, p.me ? 'me' : p.id, 'sm'),
      h('span', { class: 'name', text: p.me ? `${p.name} (você)` : p.name }),
      icons);
    if (!p.me) li.addEventListener('click', (e) => openVolume(p, e));
    list.append(li);
  }
}

// Os quadros do palco são reaproveitados entre renderizações para o vídeo não piscar.
const tileEls = new Map();

function tileMode(p) {
  if (p.me) return S.screen ? (S.previewSelf ? 'self-preview' : 'self-live') : 'idle';
  if (!p.state.sharing) return 'idle';
  return p.watching ? 'watch' : 'cta';
}

function renderTiles() {
  const box = $('#tiles');
  const list = people();
  const alive = new Set();
  list.forEach((p, i) => {
    const key = p.me ? 'me' : p.id;
    alive.add(key);
    const mode = tileMode(p);
    let el = tileEls.get(key);
    if (!el || el.dataset.mode !== mode || el.dataset.name !== p.name) {
      const fresh = buildTile(p, mode);
      if (el) el.replaceWith(fresh);
      el = fresh;
      tileEls.set(key, el);
    }
    el.classList.toggle('focused', S.focused === (p.me ? S.myId : p.id) && (mode === 'watch' || mode === 'self-preview'));
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
  for (const [k, el] of tileEls) if (!alive.has(k)) { el.remove(); tileEls.delete(k); }
  box.classList.toggle('has-focus', !!box.querySelector('.tile.focused'));
}

function nameTag(p) {
  const tag = h('div', { class: 'tile-name' }, p.me ? `${p.name} (você)` : p.name);
  if (p.state.sharing) tag.prepend(h('span', { class: 'live-badge', text: 'AO VIVO' }));
  return tag;
}

function toggleFocus(id) {
  S.focused = S.focused === id ? null : id;
  render();
}

function buildTile(p, mode) {
  const id = p.me ? S.myId : p.id;
  const el = h('div', { class: 'tile', dataset: { mode, name: p.name, speak: p.me ? 'me' : p.id } });

  if (mode === 'idle') {
    el.append(avatar(p.name, ''), nameTag(p));
  } else if (mode === 'cta') {
    el.append(h('div', { class: 'watch-cta' },
      avatar(p.name, ''),
      h('p', { text: `${p.name} está transmitindo a tela` }),
      h('button', { class: 'btn primary', text: 'Assistir', onclick: () => setWatching(p, true) })),
      nameTag(p));
  } else if (mode === 'self-live') {
    el.append(h('div', { class: 'watch-cta' },
      avatar(p.name, ''),
      h('p', { text: `Você está ao vivo · ${S.watchers.size ? 'amigos assistindo' : 'transmitindo'}` }),
      h('button', { class: 'btn secondary', text: 'Ver prévia', onclick: () => { S.previewSelf = true; S.focused = S.myId; render(); } })),
      nameTag(p));
  } else {
    // watch ou self-preview: mostra o vídeo
    const video = h('video', { autoplay: '', playsinline: '' });
    video.muted = true;
    video.srcObject = p.me ? S.screen : p.videoStream;
    if (!p.me) p.videoEl = video;
    const info = h('div', { class: 'stream-info' });
    if (!p.me) p.infoEl = info;
    const actions = h('div', { class: 'tile-actions' },
      h('button', { text: 'Tela cheia', onclick: (e) => { e.stopPropagation(); fullscreen(el); } }),
      p.me
        ? h('button', { text: 'Fechar prévia', onclick: (e) => { e.stopPropagation(); S.previewSelf = false; if (S.focused === S.myId) S.focused = null; render(); } })
        : h('button', { text: 'Parar de assistir', onclick: (e) => { e.stopPropagation(); setWatching(p, false); } }));
    el.classList.add('stream');
    el.append(video, nameTag(p), info, actions);
    el.addEventListener('click', () => toggleFocus(id));
    el.addEventListener('dblclick', () => fullscreen(el));
  }
  return el;
}

function fullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => {});
}

// ---------- volume de cada amigo ----------
let volPeer = null;
function openVolume(p, e) {
  volPeer = p;
  const pop = $('#vol-pop');
  $('#vol-name').textContent = p.name;
  $('#vol-range').value = Math.round(p.volume * 100);
  $('#vol-val').textContent = `Volume: ${Math.round(p.volume * 100)}%`;
  pop.classList.remove('hidden');
  const x = Math.min(e.clientX, innerWidth - 236);
  const y = Math.min(e.clientY, innerHeight - 110);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  e.stopPropagation();
}
$('#vol-range').addEventListener('input', (e) => {
  if (!volPeer) return;
  const v = Number(e.target.value) / 100;
  volPeer.volume = v;
  volPeer.audio.volume = volPeer.sysAudio.volume = v;
  store.set('vol:' + volPeer.name, String(v));
  $('#vol-val').textContent = `Volume: ${e.target.value}%`;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#vol-pop')) $('#vol-pop').classList.add('hidden');
});

// ---------- configurações ----------
async function openSettings() {
  $('#modal-settings').classList.remove('hidden');
  $('#chk-noise').checked = S.noise;
  const sel = $('#sel-mic');
  sel.innerHTML = '';
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const current = S.micTrack?.getSettings().deviceId;
    for (const d of devs) {
      const o = h('option', { value: d.deviceId, text: d.label || 'Microfone' });
      if (d.deviceId === current) o.selected = true;
      sel.append(o);
    }
    if (!devs.length) sel.append(h('option', { value: '', text: 'Nenhum microfone encontrado' }));
  } catch {}
}

async function reopenMic() {
  const hadMic = !!S.micTrack;
  await openMic();
  if (hadMic || S.micTrack) render();
  sendState();
}

$('#sel-mic').addEventListener('change', (e) => { S.micId = e.target.value; store.set('mic', S.micId); reopenMic(); });
$('#chk-noise').addEventListener('change', (e) => { S.noise = e.target.checked; store.set('noise', S.noise ? '1' : '0'); reopenMic(); });

function closeModals() {
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
document.querySelectorAll('#source-tabs .tab').forEach((t) => t.addEventListener('click', () => showSources(t.dataset.kind)));

// ---------- laços leves (quem está falando, info do vídeo, manter servidor acordado) ----------
function startLoops() {
  S.timers.forEach(clearInterval);
  S.timers = [
    setInterval(speakingLoop, 150),
    setInterval(statsLoop, 2000),
    setInterval(() => fetch('/health').catch(() => {}), 4 * 60 * 1000),
  ];
}

function setSpeaking(key, on) {
  document.querySelectorAll(`[data-speak="${key}"]`).forEach((el) => el.classList.toggle('speaking', on));
}

function speakingLoop() {
  const lvl = micLevel();
  if (!$('#modal-settings').classList.contains('hidden')) $('#mic-meter').style.width = Math.min(100, lvl * 400) + '%';
  setSpeaking('me', lvl > 0.04 && !S.muted && !S.deafened && !!S.micTrack);
  const now = performance.timeOrigin + performance.now();
  for (const p of S.peers.values()) {
    let on = false;
    try {
      const src = p.tx?.mic.receiver.getSynchronizationSources?.()[0];
      on = !!src && src.audioLevel > 0.02 && now - src.timestamp < 500 && !p.state.muted;
    } catch {}
    setSpeaking(p.id, on);
  }
}

async function statsLoop() {
  for (const p of S.peers.values()) {
    if (!p.watching || !p.videoEl || !p.infoEl) continue;
    let fps = 0;
    try {
      const stats = await p.tx.video.receiver.getStats();
      stats.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') fps = Math.round(r.framesPerSecond || 0); });
    } catch {}
    const v = p.videoEl;
    p.infoEl.textContent = v.videoWidth ? `${v.videoWidth}×${v.videoHeight} · ${fps} fps` : 'carregando…';
  }
}

// ---------- botões ----------
$('#btn-mute').addEventListener('click', toggleMute);
$('#btn-deafen').addEventListener('click', toggleDeafen);
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-share').addEventListener('click', openShareModal);
$('#btn-go-live').addEventListener('click', goLive);
$('#btn-leave').addEventListener('click', leave);
$('#btn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(S.code); toast('Código copiado! Mande para seus amigos.'); }
  catch { toast('Código: ' + S.code); }
});
window.addEventListener('beforeunload', () => { S.leaving = true; S.ws?.close(); });
