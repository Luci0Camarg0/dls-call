'use strict';
// DLS Call — Soundpad: sons de até 10 s do servidor, tocados para todos da call.
// Quem aperta manda só "toque o som X"; cada PC toca o som da própria memória (sem atraso e sem pesar a voz).
// As teclas de atalho são de cada pessoa e ficam salvas na conta.

const SP = {
  serverId: null, sounds: [], buffers: new Map(), loading: new Map(),
  visible: false, vol: 70, bindingId: null, pendingFile: null, pendingDuration: 0,
};

const KEY_NAMES = {
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'Delete',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', Space: 'Space',
};

// Converte uma tecla apertada no formato de atalho do Electron (ex.: "Ctrl+Shift+1", "F5", "num3").
function accelFromEvent(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (/^Numpad\d$/.test(e.code)) key = 'num' + e.code.slice(6);
  else key = KEY_NAMES[e.code] || null;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

// Atalho válido: F1–F24, teclado numérico ou qualquer tecla com Ctrl/Alt/Shift.
// (Uma letra sozinha roubaria a tecla do jogo e do chat.)
function accelAllowed(a) {
  return /(^|\+)F\d{1,2}$/.test(a) || /(^|\+)num/.test(a) || /^(Ctrl|Alt|Shift)\+/.test(a);
}

function accelLabel(a) {
  return String(a || '').replace(/num(\d)/, 'Num $1').replace('numadd', 'Num +').replace('numsub', 'Num -')
    .replace('nummult', 'Num *').replace('numdiv', 'Num /').replace('numdec', 'Num ,');
}

function binds() { return G.me?.prefs?.soundBinds || {}; }

async function saveBinds(next) {
  G.me.prefs = { ...G.me.prefs, soundBinds: next };
  registerHotkeys();
  renderSoundpad();
  try {
    const r = await api('PATCH', '/api/me', { prefs: { soundBinds: next } });
    G.me = r.me;
  } catch (e) { toast(e.message); }
}

// ---------- carregar e tocar ----------
async function loadSounds() {
  const sid = SP.serverId;
  if (!sid) return;
  try {
    const r = await api('GET', `/api/servers/${sid}/sounds`);
    if (SP.serverId !== sid) return;
    SP.sounds = r.sounds;
    for (const s of SP.sounds) loadBuffer(s);
  } catch (e) { toast(e.message); }
  registerHotkeys();
  renderSoundpad();
}

function loadBuffer(s) {
  if (SP.buffers.has(s.id) || SP.loading.has(s.id)) return SP.loading.get(s.id);
  const p = fetch(fileUrl(s.file))
    .then((r) => r.arrayBuffer())
    .then((buf) => audioCtx().decodeAudioData(buf))
    .then((ab) => { SP.buffers.set(s.id, ab); })
    .catch(() => {})
    .finally(() => SP.loading.delete(s.id));
  SP.loading.set(s.id, p);
  return p;
}

function triggerSound(id) {
  if (!S.voiceServer) return;
  wsSend({ type: 'sound', soundId: id });
}

on('sound', async (msg) => {
  const s = SP.sounds.find((x) => x.id === msg.soundId);
  if (!s) return;
  if (!SP.buffers.has(s.id)) await loadBuffer(s);
  const buf = SP.buffers.get(s.id);
  if (!buf || S.deafened) return;
  const ctx = audioCtx();
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  g.gain.value = SP.vol / 100;
  src.buffer = buf;
  src.connect(g).connect(ctx.destination);
  src.start();
  const btn = $(`.sp-btn[data-id="${s.id}"]`);
  if (btn) {
    btn.classList.add('playing');
    setTimeout(() => btn.classList.remove('playing'), Math.min(10000, buf.duration * 1000));
  }
});

on('sounds-changed', (msg) => { if (msg.serverId === SP.serverId) loadSounds(); });

function soundpadJoined(serverId) {
  if (SP.serverId === serverId) return;
  SP.serverId = serverId;
  SP.sounds = [];
  SP.vol = G.me?.prefs?.soundVol ?? 70;
  $('#sp-vol').value = SP.vol;
  loadSounds();
}

function soundpadLeft() {
  SP.serverId = null;
  SP.sounds = [];
  SP.visible = false;
  registerHotkeys();
  renderSoundpad();
}

// ---------- atalhos ----------
function activeBinds() {
  const b = binds();
  const map = new Map(); // atalho -> id do som
  for (const s of SP.sounds) if (b[s.id]) map.set(b[s.id], s.id);
  return map;
}

function registerHotkeys() {
  if (!desktop?.setHotkeys) return;
  desktop.setHotkeys(S.voiceServer && SP.serverId ? [...activeBinds().keys()] : []);
}

if (desktop?.onHotkey) {
  desktop.onHotkey((accel) => {
    const id = activeBinds().get(accel);
    if (id) triggerSound(id);
  });
}

// No navegador (sem o .exe), os atalhos funcionam com a janela em foco.
document.addEventListener('keydown', (e) => {
  if (desktop?.setHotkeys || !SP.serverId || !S.voiceServer || e.repeat) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (!$('#modal-bind').classList.contains('hidden')) return;
  const a = accelFromEvent(e);
  const id = a && activeBinds().get(a);
  if (id) { e.preventDefault(); triggerSound(id); }
});

function openBind(sound) {
  SP.bindingId = sound.id;
  $('#bind-name').textContent = sound.name;
  $('#bind-key').textContent = binds()[sound.id] ? accelLabel(binds()[sound.id]) : 'Aperte a tecla…';
  $('#bind-error').textContent = '';
  if (desktop?.setHotkeys) desktop.setHotkeys([]); // libera as teclas enquanto escolhe
  openModal('#modal-bind');
}

$('#modal-bind').addEventListener('closed', () => { SP.bindingId = null; registerHotkeys(); });

document.addEventListener('keydown', (e) => {
  if (!SP.bindingId || $('#modal-bind').classList.contains('hidden')) return;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { closeModals(); return; }
  const a = accelFromEvent(e);
  if (!a) { $('#bind-error').textContent = 'Essa tecla não pode ser usada.'; return; }
  if (!accelAllowed(a)) {
    $('#bind-error').textContent = 'Use F1–F12, o teclado numérico ou combine com Ctrl / Alt / Shift.';
    return;
  }
  const next = { ...binds() };
  for (const [k, v] of Object.entries(next)) if (v === a) delete next[k]; // uma tecla, um som
  next[SP.bindingId] = a;
  $('#bind-key').textContent = accelLabel(a);
  closeModals();
  saveBinds(next);
}, true);

$('#bind-clear').addEventListener('click', () => {
  const next = { ...binds() };
  delete next[SP.bindingId];
  closeModals();
  saveBinds(next);
});

// ---------- painel ----------
function renderSoundpad() {
  $('#soundpad').classList.toggle('hidden', !SP.visible || !S.voiceServer);
  $('#btn-soundpad').classList.toggle('on', SP.visible && !!S.voiceServer);
  $('#sp-hint').textContent = desktop?.setHotkeys
    ? 'Os atalhos funcionam mesmo com o jogo aberto, enquanto você estiver na call.'
    : 'No navegador, os atalhos só funcionam com esta janela em foco. No app (.exe) funcionam com o jogo aberto.';
  const grid = $('#sp-grid');
  grid.innerHTML = '';
  if (!SP.sounds.length) {
    grid.append(h('p', { class: 'hint', text: 'Nenhum som ainda. Adicione um! Sons longos são cortados nos primeiros 10 segundos.' }));
    return;
  }
  const b = binds();
  for (const s of SP.sounds) {
    const del = h('button', { class: 'sp-mini', title: 'Apagar para todos', text: '✕' });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = 'Apagar?';
        setTimeout(() => { del.classList.remove('confirm'); del.textContent = '✕'; }, 3000);
        return;
      }
      api('DELETE', `/api/servers/${SP.serverId}/sounds/${s.id}`).catch((err) => toast(err.message));
    });
    const btn = h('div', { class: 'sp-btn', dataset: { id: s.id }, role: 'button', tabindex: '0', title: `Tocar "${s.name}" para todos` },
      h('span', { class: 'sp-name', text: s.name }),
      h('span', { class: 'sp-meta' },
        h('button', { class: 'sp-key' + (b[s.id] ? ' set' : ''), text: b[s.id] ? accelLabel(b[s.id]) : '⌨ tecla',
          title: 'Definir tecla de atalho', onclick: (e) => { e.stopPropagation(); openBind(s); } }),
        del));
    btn.addEventListener('click', () => triggerSound(s.id));
    grid.append(btn);
  }
}

$('#btn-soundpad').addEventListener('click', () => { SP.visible = !SP.visible; renderSoundpad(); });
$('#sp-close').addEventListener('click', () => { SP.visible = false; renderSoundpad(); });

let volTimer;
$('#sp-vol').addEventListener('input', (e) => {
  SP.vol = Number(e.target.value);
  clearTimeout(volTimer);
  volTimer = setTimeout(() => {
    api('PATCH', '/api/me', { prefs: { soundVol: SP.vol } }).then((r) => { G.me = r.me; }).catch(() => {});
  }, 600);
});

// ---------- adicionar som ----------
const AUDIO_EXT = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg' };

const MAX_SOUND_SECONDS = 10;

// Pega só o começo do som (até 10 s), em mono, e gera um WAV pequeno.
// Um "fade" curtinho no final evita o estalo do corte.
async function trimToWav(buffer, seconds) {
  const rate = 44100;
  const length = Math.ceil(seconds * rate);
  const off = new OfflineAudioContext(1, length, rate);
  const src = off.createBufferSource();
  const gain = off.createGain();
  src.buffer = buffer;
  gain.gain.setValueAtTime(1, Math.max(0, seconds - 0.05));
  gain.gain.linearRampToValueAtTime(0, seconds);
  src.connect(gain).connect(off.destination);
  src.start(0, 0, seconds);
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const text = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  text(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([out.buffer], { type: 'audio/wav' });
}

$('#sp-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 60e6) { toast('Arquivo grande demais (máximo 60 MB).'); return; }
  let buffer;
  try {
    buffer = await audioCtx().decodeAudioData(await file.arrayBuffer());
  } catch {
    toast('Não consegui ler esse áudio. Tente MP3, OGG ou WAV.');
    return;
  }
  const longo = buffer.duration > MAX_SOUND_SECONDS + 0.05;
  const duration = Math.min(buffer.duration, MAX_SOUND_SECONDS);
  // Som longo (ou arquivo pesado demais): usa só os primeiros 10 s.
  SP.pendingFile = longo || file.size > 2e6 ? await trimToWav(buffer, duration) : file;
  SP.pendingDuration = duration;
  $('#snd-name').value = file.name.replace(/\.[^.]+$/, '').slice(0, 32);
  $('#snd-info').textContent = longo
    ? `${file.name} · tem ${buffer.duration.toFixed(1)} s, vai usar só os primeiros ${MAX_SOUND_SECONDS} s`
    : `${file.name} · ${duration.toFixed(1)} s`;
  $('#snd-error').textContent = '';
  openModal('#modal-sound');
  $('#snd-name').select();
});

$('#form-sound').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = SP.pendingFile;
  if (!file || !SP.serverId) return;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  const type = file.type || AUDIO_EXT[ext] || 'audio/mpeg';
  const name = $('#snd-name').value.trim() || 'Som';
  $('#snd-send').disabled = true;
  try {
    await api('POST', `/api/servers/${SP.serverId}/sounds?name=${encodeURIComponent(name)}&duration=${SP.pendingDuration.toFixed(2)}`,
      new Blob([file], { type }));
    closeModals();
    toast(`Som "${name}" adicionado!`);
  } catch (err) {
    $('#snd-error').textContent = err.message;
  } finally {
    $('#snd-send').disabled = false;
  }
});
