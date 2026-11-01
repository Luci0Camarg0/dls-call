'use strict';
// DLS Call — call de voz e transmissão de tela.
//
// Cada amigo se conecta direto com cada outro (WebRTC, peer-to-peer).
// Cada conexão tem 3 "canais" fixos: [0] microfone, [1] vídeo da tela, [2] som do PC.
// Ligar/desligar a tela é só trocar a faixa do canal (replaceTrack), sem renegociar nada.
// A tela só é enviada para quem clicou em "Assistir", para poupar a internet de quem transmite.

const VIDEO_CODEC_ORDER = ['video/H264', 'video/VP8']; // H264 costuma ter aceleração por placa de vídeo

const S = {
  voiceServer: null, // servidor em cuja call estou
  joining: false, rejoin: null, iceServers: [],
  mic: null, micTrack: null,
  noise: store.get('noise') !== '0',
  micId: store.get('mic') || '', micLabel: store.get('micLabel') || '',
  outId: store.get('out') || '',
  muted: false, deafened: false,
  screen: null, screenVideo: null, screenAudio: null, fps: 30, previewSelf: false,
  watchers: new Set(),
  peers: new Map(), // connId -> amigo
  focused: null,
  analyser: null, micSource: null,
};

// ---------- microfone ----------
function micConstraints(deviceId) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: S.noise, noiseSuppression: S.noise, autoGainControl: true,
    channelCount: 1,
  };
}

// Abre o microfone escolhido. Se ele sumiu (trocou de porta USB etc.), procura pelo nome;
// se não achar, usa o padrão do Windows e avisa.
async function getMicStream() {
  const tries = [];
  if (S.micId && S.micId !== 'default') tries.push(S.micId);
  if (S.micLabel) {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const byLabel = devs.find((d) => d.label === S.micLabel);
      if (byLabel && !tries.includes(byLabel.deviceId)) tries.push(byLabel.deviceId);
    } catch {}
  }
  for (const id of tries) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(id) }); } catch {}
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(null) });
  if (tries.length) toast('O microfone escolhido não foi encontrado. Usando o padrão do Windows.', 4000);
  return stream;
}

async function openMic() {
  try {
    setMic(await getMicStream());
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
  if (stream) {
    const ctx = audioCtx();
    S.analyser = S.analyser || Object.assign(ctx.createAnalyser(), { fftSize: 256 });
    S.micSource = ctx.createMediaStreamSource(stream);
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

function applyOutput(el) {
  if (S.outId && el.setSinkId) el.setSinkId(S.outId).catch(() => {});
}

// ---------- entrar / sair da call ----------
async function joinVoice(serverId) {
  if (S.joining) return;
  if (S.voiceServer === serverId) { showView('voice'); return; }
  S.joining = true;
  audioCtx();
  if (S.voiceServer) leaveVoice(true);
  if (!S.mic) await openMic();
  S.joining = false;
  wsSend({ type: 'voice-join', serverId });
}

function leaveVoice(silent = false) {
  if (!S.voiceServer) return;
  wsSend({ type: 'voice-leave' });
  cleanupVoice();
  if (!silent) beep('leave');
}

function cleanupVoice() {
  teardownPeers();
  if (S.screen) { S.screen.getTracks().forEach((t) => t.stop()); S.screen = S.screenVideo = S.screenAudio = null; }
  setMic(null);
  S.voiceServer = null;
  S.rejoin = null;
  S.muted = S.deafened = false;
  S.focused = null;
  S.watchers.clear();
  tileEls.forEach((el) => el.remove());
  tileEls.clear();
  resetMusic();
  soundpadLeft();
  renderVoice();
  renderSidebar();
}

on('voice-welcome', (msg) => {
  S.voiceServer = msg.serverId;
  S.iceServers = msg.iceServers || [];
  for (const p of msg.peers) addPeer(p, true);
  sendState();
  if (!S.rejoin) beep('join');
  S.rejoin = null;
  setConn('ok', 'Voz conectada');
  if (G.serverId === msg.serverId) showView('voice');
  soundpadJoined(msg.serverId);
  renderVoice();
  renderSidebar();
});

on('peer-joined', (msg) => { addPeer(msg, false); beep('join'); renderVoice(); });
on('peer-left', (msg) => { removePeer(msg.connId); beep('leave'); renderVoice(); });
on('signal', (msg) => { const p = S.peers.get(msg.from); if (p) handleSignal(p, msg.data); });
on('state', (msg) => {
  const p = S.peers.get(msg.connId);
  if (!p) return;
  const wasSharing = p.state.sharing;
  p.state = msg.state;
  if (!p.state.sharing) {
    p.watching = false;
    if (S.focused === p.id) S.focused = null;
  } else if (!wasSharing) {
    toast(`${userById(p.userId).displayName} começou a transmitir a tela`);
    beep('live');
  }
  renderVoice();
});
on('watch', (msg) => {
  if (msg.on) S.watchers.add(msg.from); else S.watchers.delete(msg.from);
  const p = S.peers.get(msg.from);
  if (p) updateScreenSenders(p);
  renderVoice();
});
on('voice-kicked', (msg) => { toast(msg.message, 4000); cleanupVoice(); });

// Se a internet cair, volta sozinho para a mesma call quando reconectar.
on('ws-closed', () => {
  if (!S.voiceServer) return;
  S.rejoin = S.voiceServer;
  teardownPeers();
  setConn('warn', 'Reconectando…');
  renderVoice();
});
on('ready', () => {
  if (S.rejoin) {
    const sid = S.rejoin;
    S.voiceServer = null;
    wsSend({ type: 'voice-join', serverId: sid });
    S.rejoin = sid;
  }
});

function sendState() {
  wsSend({ type: 'state', state: { muted: S.muted || !S.micTrack, deafened: S.deafened, sharing: !!S.screen } });
}

function setConn(kind, text) {
  const el = $('#conn-status');
  el.className = 'conn ' + kind;
  el.textContent = text;
}

// ---------- conexões com cada amigo ----------
function newAudio() {
  const a = h('audio', { autoplay: true });
  applyOutput(a);
  $('#audio-sink').append(a);
  return a;
}

function addPeer({ connId, userId, state }, initiator) {
  if (S.peers.has(connId)) removePeer(connId);
  const vol = Number(store.get('vol:' + userId) ?? 1);
  const peer = {
    id: connId, userId, state: state || {}, initiator,
    pc: null, tx: null, queue: Promise.resolve(),
    watching: false, connected: false,
    audio: newAudio(), sysAudio: newAudio(), videoStream: null, videoEl: null, infoEl: null,
    volume: Math.min(1, Math.max(0, vol)),
  };
  peer.audio.volume = peer.sysAudio.volume = peer.volume;
  peer.audio.muted = peer.sysAudio.muted = S.deafened;
  S.peers.set(connId, peer);
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
  pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: 'signal', to: peer.id, data: { candidate: e.candidate } }); };
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
    renderVoice();
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
    wsSend({ type: 'signal', to: peer.id, data: { sdp: peer.pc.localDescription } });
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
        wsSend({ type: 'signal', to: peer.id, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }).catch((e) => console.warn('signal', e));
}

function updateScreenSenders(peer) {
  if (!peer.tx) return;
  const send = !!S.screen && S.watchers.has(peer.id);
  peer.tx.video.sender.replaceTrack(send ? S.screenVideo : null).catch(() => {});
  peer.tx.sys.sender.replaceTrack(send ? S.screenAudio : null).catch(() => {});
  if (send) applyVideoParams(peer.tx.video.sender);
}

async function applyVideoParams(sender) {
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) return;
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
  openModal('#modal-share');
  if (desktop) {
    $('#source-tabs').classList.remove('hidden');
    grid.append(h('p', { text: 'Carregando…', class: 'hint' }));
    try { allSources = await desktop.getSources(); } catch { allSources = []; }
    showSources('screen');
  } else {
    $('#source-tabs').classList.add('hidden');
  }
}

function showSources(kind) {
  $$('#source-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === kind));
  const grid = $('#source-grid');
  grid.innerHTML = '';
  const list = allSources.filter((s) => s.kind === kind);
  if (!list.length) grid.append(h('p', { text: 'Nada encontrado.', class: 'hint' }));
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

// Som do PC na transmissão. restrictOwnAudio deixa de fora o som do próprio app (a voz dos amigos),
// para quem assiste não ouvir a própria voz. No .exe isso depende do recurso RestrictOwnAudio (main.js).
const SCREEN_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true };

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
      audio: withAudio ? SCREEN_AUDIO : false,
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
    renderVoice();
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
  if (S.focused === 'me') S.focused = null;
  sendState();
  beep('off');
  renderVoice();
}

function setWatching(peer, on) {
  peer.watching = on;
  wsSend({ type: 'watch', to: peer.id, on });
  if (on) S.focused = peer.id;
  else if (S.focused === peer.id) S.focused = null;
  renderVoice();
}

// ---------- mudo / ensurdecer ----------
async function toggleMute() {
  if (!S.voiceServer) { toast('Entre na call para usar o microfone.'); return; }
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
  if (M.ready) { if (S.deafened) M.player.mute(); else M.player.unMute(); }
  beep(S.muted || S.deafened ? 'off' : 'on');
  sendState();
  renderVoice();
}

// ---------- tela da call ----------
const tileEls = new Map();

function voicePeople() {
  if (!S.voiceServer) return [];
  const me = {
    key: 'me', id: 'me', userId: G.me.id, me: true, connected: true,
    state: { muted: S.muted || !S.micTrack, deafened: S.deafened, sharing: !!S.screen },
  };
  return [me, ...[...S.peers.values()].map((p) => ({ ...p, key: p.id }))];
}

function tileMode(p) {
  if (p.me) return S.screen ? (S.previewSelf ? 'self-preview' : 'self-live') : 'idle';
  if (!p.state.sharing) return 'idle';
  return p.watching ? 'watch' : 'cta';
}

function renderVoice() {
  renderControls();
  const inThisCall = S.voiceServer && S.voiceServer === G.serverId;
  const roster = G.rosters.get(G.serverId) || [];
  $('#voice-join-card').classList.toggle('hidden', !!inThisCall);
  $('#stage-bar').classList.toggle('hidden', !S.voiceServer);
  $('#tiles').classList.toggle('hidden', !S.voiceServer);
  if (!inThisCall) {
    $('#voice-join-text').textContent = roster.length
      ? `Na call agora: ${roster.map((r) => userById(r.userId).displayName).join(', ')}`
      : 'Ninguém na call ainda.';
    $('#btn-voice-join').textContent = S.voiceServer ? 'Mudar para esta call' : 'Entrar na call';
  }
  $('#voice-status').classList.toggle('hidden', !S.voiceServer);
  if (S.voiceServer) {
    const srv = G.servers.find((s) => s.id === S.voiceServer);
    $('#conn-sub').textContent = `Geral / ${srv?.name || ''}`;
  }
  renderTiles();
  const share = $('#btn-share');
  share.classList.toggle('live', !!S.screen);
  share.querySelector('span').textContent = S.screen ? 'Parar transmissão' : 'Compartilhar tela';
}

function renderControls() {
  const mutedNow = S.muted || S.deafened || (S.voiceServer && !S.micTrack);
  $('#btn-mute').classList.toggle('active', !!mutedNow);
  $('#btn-mute').title = mutedNow ? 'Ativar microfone' : 'Silenciar microfone';
  $('#btn-deafen').classList.toggle('active', S.deafened);
  $('#btn-deafen').title = S.deafened ? 'Ativar áudio' : 'Desativar áudio';
}

function renderTiles() {
  const box = $('#tiles');
  const list = voicePeople();
  const alive = new Set();
  list.forEach((p, i) => {
    alive.add(p.key);
    const mode = tileMode(p);
    const u = userById(p.userId);
    const sig = `${mode}|${u.displayName}|${u.avatar || ''}`;
    let el = tileEls.get(p.key);
    if (!el || el.dataset.sig !== sig) {
      const fresh = buildTile(p, mode, u);
      fresh.dataset.sig = sig;
      if (el) el.replaceWith(fresh);
      el = fresh;
      tileEls.set(p.key, el);
    }
    el.classList.toggle('focused', S.focused === p.key && (mode === 'watch' || mode === 'self-preview'));
    el.classList.toggle('connecting', !p.connected);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
  for (const [k, el] of tileEls) if (!alive.has(k)) { el.remove(); tileEls.delete(k); }
  box.classList.toggle('has-focus', !!box.querySelector('.tile.focused'));
}

function nameTag(p, u) {
  const tag = h('div', { class: 'tile-name' }, p.me ? `${u.displayName} (você)` : u.displayName);
  if (p.state.sharing) tag.prepend(h('span', { class: 'live-badge', text: 'AO VIVO' }));
  if (p.state.deafened) tag.append(svg(ICON_DEAF, 14));
  else if (p.state.muted) tag.append(svg(ICON_MIC_OFF, 14));
  return tag;
}

function toggleFocus(key) {
  S.focused = S.focused === key ? null : key;
  renderVoice();
}

function buildTile(p, mode, u) {
  const el = h('div', { class: 'tile', dataset: { mode, speak: p.key } });
  if (mode === 'idle') {
    el.append(avatarEl(u, 'xl'), nameTag(p, u));
  } else if (mode === 'cta') {
    el.append(h('div', { class: 'watch-cta' },
      avatarEl(u, 'lg'),
      h('p', { text: `${u.displayName} está transmitindo a tela` }),
      h('button', { class: 'btn primary', text: 'Assistir', onclick: () => setWatching(S.peers.get(p.id), true) })),
      nameTag(p, u));
  } else if (mode === 'self-live') {
    el.append(h('div', { class: 'watch-cta' },
      avatarEl(u, 'lg'),
      h('p', { text: `Você está ao vivo · ${S.watchers.size ? S.watchers.size + ' assistindo' : 'ninguém assistindo ainda'}` }),
      h('button', { class: 'btn secondary', text: 'Ver prévia', onclick: () => { S.previewSelf = true; S.focused = 'me'; renderVoice(); } })),
      nameTag(p, u));
  } else {
    const peer = p.me ? null : S.peers.get(p.id);
    const video = h('video', { autoplay: true, playsinline: true });
    video.muted = true;
    video.srcObject = p.me ? S.screen : peer.videoStream;
    const info = h('div', { class: 'stream-info' });
    if (peer) { peer.videoEl = video; peer.infoEl = info; }
    const actions = h('div', { class: 'tile-actions' },
      h('button', { text: 'Tela cheia', onclick: (e) => { e.stopPropagation(); fullscreen(el); } }),
      p.me
        ? h('button', { text: 'Fechar prévia', onclick: (e) => { e.stopPropagation(); S.previewSelf = false; if (S.focused === 'me') S.focused = null; renderVoice(); } })
        : h('button', { text: 'Parar de assistir', onclick: (e) => { e.stopPropagation(); setWatching(peer, false); } }));
    el.classList.add('stream');
    el.append(video, nameTag(p, u), info, actions);
    el.addEventListener('click', () => toggleFocus(p.key));
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
function openVolume(peer, e) {
  volPeer = peer;
  const pop = $('#vol-pop');
  $('#vol-name').textContent = userById(peer.userId).displayName;
  $('#vol-range').value = Math.round(peer.volume * 100);
  $('#vol-val').textContent = `Volume: ${Math.round(peer.volume * 100)}%`;
  pop.classList.remove('hidden');
  pop.style.left = Math.min(e.clientX, innerWidth - 236) + 'px';
  pop.style.top = Math.min(e.clientY, innerHeight - 110) + 'px';
  e.stopPropagation();
}
$('#vol-range').addEventListener('input', (e) => {
  if (!volPeer) return;
  const v = Number(e.target.value) / 100;
  volPeer.volume = v;
  volPeer.audio.volume = volPeer.sysAudio.volume = v;
  store.set('vol:' + volPeer.userId, String(v));
  $('#vol-val').textContent = `Volume: ${e.target.value}%`;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#vol-pop')) $('#vol-pop').classList.add('hidden');
});

// ---------- laços leves: quem está falando, info do vídeo ----------
function setSpeaking(key, onOff) {
  $$(`[data-speak="${key}"]`).forEach((el) => el.classList.toggle('speaking', onOff));
}

setInterval(() => {
  const lvl = micLevel();
  if (!$('#modal-settings').classList.contains('hidden')) $('#mic-meter').style.width = Math.min(100, lvl * 400) + '%';
  if (!S.voiceServer) return;
  setSpeaking('me', lvl > 0.04 && !S.muted && !S.deafened && !!S.micTrack);
  setSpeaking('u:' + G.me.id, lvl > 0.04 && !S.muted && !S.deafened && !!S.micTrack);
  const now = performance.timeOrigin + performance.now();
  for (const p of S.peers.values()) {
    let onOff = false;
    try {
      const src = p.tx?.mic.receiver.getSynchronizationSources?.()[0];
      onOff = !!src && src.audioLevel > 0.02 && now - src.timestamp < 500 && !p.state.muted;
    } catch {}
    setSpeaking(p.id, onOff);
    setSpeaking('u:' + p.userId, onOff);
  }
}, 150);

setInterval(async () => {
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
}, 2000);

// ---------- botões ----------
$('#btn-mute').addEventListener('click', toggleMute);
$('#btn-deafen').addEventListener('click', toggleDeafen);
$('#btn-share').addEventListener('click', openShareModal);
$('#btn-go-live').addEventListener('click', goLive);
$('#btn-leave').addEventListener('click', () => leaveVoice());
$('#btn-voice-join').addEventListener('click', () => { if (G.serverId) joinVoice(G.serverId); });
$$('#source-tabs .tab').forEach((t) => t.addEventListener('click', () => showSources(t.dataset.kind)));
