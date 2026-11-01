'use strict';
// DLS Call — telas do app: login, servidores, canais, membros, perfis e configurações.

// ---------- início ----------
function showScreen(id) {
  for (const s of ['#screen-boot', '#screen-auth', '#screen-app']) $(s).classList.toggle('hidden', s !== id);
}

async function boot() {
  G.token = store.get('token');
  if (!G.token) { showAuth(); return; }
  showScreen('#screen-boot');
  try {
    enterApp(await api('GET', '/api/me', undefined, { noLogout: true }));
  } catch (e) {
    if (e.status === 401) { store.set('token', null); G.token = null; showAuth(); return; }
    // Servidor acordando ou sem internet: tenta de novo.
    $('#screen-boot p').textContent = 'Conectando ao servidor…';
    setTimeout(boot, 3000);
  }
}

function enterApp({ me, servers }) {
  G.me = me;
  G.users.set(me.id, me);
  G.servers = servers;
  applyWallpaper();
  showScreen('#screen-app');
  connectWs();
  renderMe();
  const last = store.get('lastServer');
  selectServer(servers.some((s) => s.id === last) ? last : servers[0]?.id || null);
}

function logout(expired = false) {
  if (G.token && !expired) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + G.token } }).catch(() => {});
  if (S.voiceServer) leaveVoice(true);
  G.token = null;
  store.set('token', null);
  const ws = G.ws;
  G.ws = null;
  ws?.close();
  Object.assign(G, { me: null, servers: [], serverId: null, unread: new Set() });
  G.users.clear(); G.members.clear(); G.rosters.clear(); G.online.clear();
  CH.messages.clear(); CH.hasMore.clear();
  closeModals();
  applyWallpaper();
  if (expired) toast('Sua sessão expirou. Entre de novo.');
  showAuth();
}

// ---------- login / cadastro ----------
let authMode = 'login';
function showAuth() {
  showScreen('#screen-auth');
  setAuthMode(authMode);
  setTimeout(() => $('#in-user').focus(), 50);
}

function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $$('.register-only').forEach((el) => el.classList.toggle('hidden', mode !== 'register'));
  $('#btn-auth').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('#auth-sub').textContent = mode === 'login' ? 'Que bom te ver de novo!' : 'Crie sua conta para entrar nos servidores.';
  $('#in-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}
$$('.auth-tabs .tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-auth');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const body = { username: $('#in-user').value.trim(), password: $('#in-pass').value };
    if (authMode === 'register') body.displayName = $('#in-display').value.trim();
    const r = await api('POST', authMode === 'login' ? '/api/login' : '/api/register', body, { noLogout: true });
    G.token = r.token;
    store.set('token', r.token);
    $('#in-pass').value = '';
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- servidor aberto ----------
async function selectServer(id) {
  G.serverId = id;
  store.set('lastServer', id);
  $('#members-list').innerHTML = '';
  renderRail();
  renderSidebar();
  if (!id) { showView('empty'); return; }
  showView(S.voiceServer === id && G.view === 'voice' ? 'voice' : 'chat');
  try {
    const r = await api('GET', `/api/servers/${id}/members`);
    for (const u of r.members) {
      if (u.id === G.me.id) continue;
      G.users.set(u.id, u);
      if (u.online) G.online.add(u.id); else G.online.delete(u.id);
    }
    G.members.set(id, r.members.map((u) => u.id));
    if (G.serverId === id) { renderMembers(); renderChat(true); renderSidebar(); renderVoice(); }
  } catch (e) { toast(e.message); }
}

function showView(view) {
  G.view = view;
  $('#view-empty').classList.toggle('hidden', view !== 'empty');
  $('#view-chat').classList.toggle('off', view !== 'chat');
  $('#view-voice').classList.toggle('off', view !== 'voice');
  $('.main-head').classList.toggle('hidden', view === 'empty');
  $('#head-icon').textContent = view === 'voice' ? '🔊' : '#';
  $('#head-title').textContent = view === 'voice' ? 'Geral' : 'chat';
  if (view === 'chat' && G.serverId) {
    openChat(G.serverId);
    setTimeout(() => chatInput.focus(), 0);
  }
  renderSidebar();
  renderRail();
  renderVoice();
  renderMusic();
  renderSoundpad();
}

// ---------- barra de servidores ----------
function renderRail() {
  const box = $('#rail-servers');
  box.innerHTML = '';
  for (const s of G.servers) {
    const btn = h('button', {
      class: 'rail-btn' + (s.id === G.serverId ? ' active' : '') + (G.unread.has(s.id) ? ' unread' : ''),
      title: s.name,
      onclick: () => { if (s.id !== G.serverId) selectServer(s.id); },
    }, serverIconEl(s), S.voiceServer === s.id ? h('span', { class: 'rail-voice', title: 'Você está na call deste servidor' }, '🔊') : null);
    box.append(btn);
  }
}

// ---------- canais ----------
function renderSidebar() {
  const srv = G.servers.find((s) => s.id === G.serverId);
  $('#server-name').textContent = srv?.name || 'DLS Call';
  $('#btn-server-menu').disabled = !srv;
  $('.channels').classList.toggle('hidden', !srv);
  $('#chan-chat').classList.toggle('active', G.view === 'chat');
  $('#chan-voice').classList.toggle('active', G.view === 'voice');
  $('#chat-unread').classList.toggle('hidden', !(G.view !== 'chat' && G.unread.has(G.serverId)));
  const list = $('#voice-list');
  list.innerHTML = '';
  for (const r of G.rosters.get(G.serverId) || []) {
    const u = userById(r.userId);
    const icons = h('span', { class: 'icons' });
    if (r.state?.sharing) icons.append(h('span', { class: 'live-badge', text: 'AO VIVO' }));
    if (r.state?.deafened) icons.append(svg(ICON_DEAF));
    else if (r.state?.muted) icons.append(svg(ICON_MIC_OFF));
    const li = h('li', { class: 'voice-member' }, avatarEl(u, 'xs', 'u:' + r.userId), h('span', { class: 'name', text: u.displayName }), icons);
    li.addEventListener('click', (e) => {
      const peer = [...S.peers.values()].find((p) => p.userId === r.userId);
      if (peer) openVolume(peer, e);
      else openProfile(r.userId, e);
    });
    list.append(li);
  }
}

$('#chan-chat').addEventListener('click', () => showView('chat'));
$('#chan-voice').addEventListener('click', () => {
  if (S.voiceServer === G.serverId) showView('voice');
  else { showView('voice'); joinVoice(G.serverId); }
});

// ---------- membros ----------
function renderMembers() {
  const box = $('#members-list');
  box.innerHTML = '';
  const ids = G.members.get(G.serverId) || [];
  const users = ids.map(userById).sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
  const isOnline = (u) => u.id === G.me.id || G.online.has(u.id);
  const groups = [['Online', users.filter(isOnline)], ['Offline', users.filter((u) => !isOnline(u))]];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    box.append(h('div', { class: 'mem-group', text: `${label} — ${list.length}` }));
    for (const u of list) {
      const row = h('button', { class: 'mem-row' + (isOnline(u) ? '' : ' offline') },
        h('span', { class: 'av-wrap' }, avatarEl(u, 'sm', 'u:' + u.id), h('span', { class: 'status ' + (isOnline(u) ? 'on' : 'off') })),
        h('span', { class: 'name', text: u.displayName }));
      row.addEventListener('click', (e) => openProfile(u.id, e));
      box.append(row);
    }
  }
}

$('#btn-members').addEventListener('click', () => {
  G.showMembers = !G.showMembers;
  $('#screen-app').classList.toggle('no-members', !G.showMembers);
});

// ---------- perfil ----------
function profileCard(u) {
  const banner = h('div', { class: 'pc-banner' });
  if (u.banner) banner.append(h('img', { src: fileUrl(u.banner), alt: '' }));
  else if (u.bannerColor) banner.style.background = u.bannerColor;
  return h('div', { class: 'profile-card' },
    banner,
    h('div', { class: 'pc-avatar' }, avatarEl(u, 'xxl')),
    h('div', { class: 'pc-body' },
      h('div', { class: 'pc-name', text: u.displayName }),
      h('div', { class: 'pc-user', text: '@' + u.username }),
      u.createdAt ? h('div', { class: 'pc-since', text: 'No DLS Call desde ' + new Date(u.createdAt).toLocaleDateString('pt-BR') }) : null));
}

function openProfile(userId, e) {
  e?.stopPropagation();
  const u = userById(userId);
  const pop = $('#profile-pop');
  pop.innerHTML = '';
  const card = profileCard(u);
  if (u.id === G.me.id) {
    card.querySelector('.pc-body').append(h('button', { class: 'btn secondary small', text: 'Editar perfil', onclick: () => { pop.classList.add('hidden'); openSettings('profile'); } }));
  }
  pop.append(card);
  pop.classList.remove('hidden');
  const x = e ? e.clientX : innerWidth / 2;
  const y = e ? e.clientY : innerHeight / 3;
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(x - r.width / 2, innerWidth - r.width - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#profile-pop')) $('#profile-pop').classList.add('hidden');
});

function renderMe() {
  if (!G.me) return;
  $('#me-avatar').replaceChildren(avatarEl(G.me, 'sm', 'u:' + G.me.id));
  $('#me-name').textContent = G.me.displayName;
  $('#me-user').textContent = '@' + G.me.username;
}
$('#me-card').addEventListener('click', (e) => openProfile(G.me.id, e));

// ---------- wallpaper ----------
function applyWallpaper() {
  const p = G.me?.prefs || {};
  const wall = $('#wallpaper');
  const has = !!p.wallpaper;
  document.body.classList.toggle('has-wall', has);
  wall.style.backgroundImage = has ? `url("${fileUrl(p.wallpaper)}")` : '';
  wall.style.filter = has && p.blur ? `blur(${p.blur}px)` : '';
  $('#wall-dim').style.opacity = has ? String((p.dim ?? 40) / 100) : '0';
}

// ---------- eventos em tempo real ----------
on('ready', (msg) => {
  G.rosters = new Map(Object.entries(msg.rosters || {}));
  renderSidebar();
  renderVoice();
});
on('voice-roster', (msg) => {
  G.rosters.set(msg.serverId, msg.members);
  renderSidebar();
  if (G.serverId === msg.serverId && S.voiceServer !== msg.serverId) renderVoice();
});
on('presence', (msg) => {
  if (msg.online) G.online.add(msg.userId); else G.online.delete(msg.userId);
  renderMembers();
});
on('user', (msg) => {
  const u = msg.user;
  if (u.id === G.me.id) { G.me = { ...G.me, ...u }; renderMe(); }
  else G.users.set(u.id, { ...G.users.get(u.id), ...u });
  renderMembers();
  renderSidebar();
  renderVoice();
  if (G.view === 'chat') renderChat(true);
});
on('member-joined', (msg) => {
  if (msg.user.id !== G.me.id) { G.users.set(msg.user.id, msg.user); G.online.add(msg.user.id); }
  const ids = G.members.get(msg.serverId);
  if (ids && !ids.includes(msg.user.id)) ids.push(msg.user.id);
  if (G.serverId === msg.serverId) renderMembers();
});
on('member-left', (msg) => {
  const ids = G.members.get(msg.serverId);
  if (ids) G.members.set(msg.serverId, ids.filter((x) => x !== msg.userId));
  if (msg.userId === G.me.id) removeServerLocal(msg.serverId);
  else if (G.serverId === msg.serverId) renderMembers();
});
on('server-update', (msg) => {
  const i = G.servers.findIndex((s) => s.id === msg.server.id);
  if (i >= 0) G.servers[i] = msg.server;
  renderRail();
  renderSidebar();
  renderVoice();
});

function removeServerLocal(id) {
  G.servers = G.servers.filter((s) => s.id !== id);
  if (S.voiceServer === id) leaveVoice(true);
  if (G.serverId === id) selectServer(G.servers[0]?.id || null);
  else renderRail();
}

// ---------- criar / entrar em servidor ----------
function openAdd() {
  $('#add-error').textContent = '';
  $('#in-join-code').value = '';
  $('#in-create-name').value = '';
  openModal('#modal-add');
  setTimeout(() => $('#in-join-code').focus(), 50);
}
$('#btn-add-server').addEventListener('click', openAdd);
$('#btn-empty-add').addEventListener('click', openAdd);

$('#in-join-code').addEventListener('input', (e) => {
  let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4);
  e.target.value = v;
});

function addServerLocal(s) {
  if (!G.servers.some((x) => x.id === s.id)) G.servers.push(s);
  closeModals();
  selectServer(s.id);
}

$('#form-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/servers/join', { code: $('#in-join-code').value });
    addServerLocal(r.server);
    toast(`Você entrou em ${r.server.name}!`);
  } catch (err) { $('#add-error').textContent = err.message; }
});

$('#form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/servers', { name: $('#in-create-name').value });
    addServerLocal(r.server);
    openServerSettings();
    toast('Servidor criado! Mande o código de convite para os amigos.', 4000);
  } catch (err) { $('#add-error').textContent = err.message; }
});

// ---------- configurações do servidor ----------
function openServerSettings() {
  const s = G.servers.find((x) => x.id === G.serverId);
  if (!s) return;
  $('#srv-icon-preview').replaceWith(Object.assign(serverIconEl(s, 'big'), { id: 'srv-icon-preview' }));
  $('#srv-name').value = s.name;
  $('#srv-invite-code').textContent = s.invite;
  $('#srv-error').textContent = '';
  $('#srv-leave').textContent = 'Sair do servidor';
  $('#srv-leave').classList.remove('confirm');
  openModal('#modal-server');
}
$('#btn-server-menu').addEventListener('click', openServerSettings);

$('#srv-invite').addEventListener('click', async () => {
  const code = $('#srv-invite-code').textContent;
  try { await navigator.clipboard.writeText(code); toast('Código copiado! Mande para seus amigos.'); }
  catch { toast('Código: ' + code); }
});

$('#srv-save').addEventListener('click', async () => {
  try {
    const r = await api('PATCH', `/api/servers/${G.serverId}`, { name: $('#srv-name').value });
    const i = G.servers.findIndex((x) => x.id === r.server.id);
    if (i >= 0) G.servers[i] = r.server;
    renderRail(); renderSidebar();
    closeModals();
  } catch (err) { $('#srv-error').textContent = err.message; }
});

$('#srv-icon-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await api('POST', `/api/servers/${G.serverId}/icon`, await prepareImage(file, 'icon'));
    const i = G.servers.findIndex((x) => x.id === r.server.id);
    if (i >= 0) G.servers[i] = r.server;
    $('#srv-icon-preview').replaceWith(Object.assign(serverIconEl(r.server, 'big'), { id: 'srv-icon-preview' }));
    renderRail();
  } catch (err) { $('#srv-error').textContent = err.message; }
});

$('#srv-leave').addEventListener('click', async () => {
  const b = $('#srv-leave');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm');
    b.textContent = 'Clique de novo para sair';
    return;
  }
  const id = G.serverId;
  try {
    await api('DELETE', `/api/servers/${id}/membership`);
    closeModals();
    removeServerLocal(id);
  } catch (err) { $('#srv-error').textContent = err.message; }
});

// ---------- configurações do usuário ----------
let micTestOpen = false;

function openSettings(tab = 'profile') {
  openModal('#modal-settings');
  setSettingsTab(tab);
}

function setSettingsTab(tab) {
  $$('.settings-nav .nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
  if (tab === 'profile') fillProfileTab();
  if (tab === 'look') fillLookTab();
  if (tab === 'audio') fillAudioTab();
}
$$('.settings-nav .nav-item[data-tab]').forEach((b) => b.addEventListener('click', () => setSettingsTab(b.dataset.tab)));
$('#btn-settings').addEventListener('click', () => openSettings('profile'));
$('#btn-logout').addEventListener('click', () => logout());

$('#modal-settings').addEventListener('closed', () => {
  // Fecha o microfone de teste se não estiver em call.
  if (micTestOpen && !S.voiceServer) setMic(null);
  micTestOpen = false;
});

function setMe(me) {
  G.me = me;
  G.users.set(me.id, me);
  renderMe();
  fillProfilePreview();
  applyWallpaper();
}

// Perfil
function fillProfilePreview() {
  $('#pe-preview').replaceChildren(...profileCard(G.me).childNodes);
}
function fillProfileTab() {
  $('#pe-name').value = G.me.displayName;
  $('#pe-color').value = G.me.bannerColor || '#7b6cff';
  $('#pe-msg').textContent = '';
  fillProfilePreview();
}

async function uploadMe(kind, file) {
  $('#pe-msg').textContent = 'Enviando…';
  try {
    setMe((await api('POST', `/api/me/${kind}`, await prepareImage(file, kind))).me);
    $('#pe-msg').textContent = 'Salvo ✓';
  } catch (err) { $('#pe-msg').textContent = err.message; }
}

$('#pe-avatar').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadMe('avatar', f); });
$('#pe-banner').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadMe('banner', f); });
$('#pe-avatar-rm').addEventListener('click', async () => {
  try { setMe((await api('DELETE', '/api/me/avatar')).me); } catch (err) { toast(err.message); }
});
$('#pe-banner-rm').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/me/banner');
    setMe((await api('PATCH', '/api/me', { bannerColor: null })).me);
  } catch (err) { toast(err.message); }
});

let colorTimer;
$('#pe-color').addEventListener('input', (e) => {
  // Mostra a cor na hora; salva um instante depois (escolher cor tira a imagem do banner).
  const color = e.target.value;
  G.me = { ...G.me, banner: null, bannerColor: color };
  fillProfilePreview();
  clearTimeout(colorTimer);
  colorTimer = setTimeout(async () => {
    try {
      await api('DELETE', '/api/me/banner');
      setMe((await api('PATCH', '/api/me', { bannerColor: color })).me);
    } catch (err) { toast(err.message); }
  }, 500);
});

$('#pe-save').addEventListener('click', async () => {
  try {
    setMe((await api('PATCH', '/api/me', { displayName: $('#pe-name').value })).me);
    $('#pe-msg').textContent = 'Salvo ✓';
  } catch (err) { $('#pe-msg').textContent = err.message; }
});

// Aparência
function fillLookTab() {
  const p = G.me.prefs || {};
  const prev = $('#wp-preview');
  prev.style.backgroundImage = p.wallpaper ? `url("${fileUrl(p.wallpaper)}")` : '';
  prev.classList.toggle('has', !!p.wallpaper);
  $('#wp-blur').value = p.blur ?? 8;
  $('#wp-dim').value = p.dim ?? 40;
  $('#wp-blur-val').textContent = $('#wp-blur').value;
  $('#wp-dim-val').textContent = $('#wp-dim').value;
}

$('#wp-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  toast('Enviando wallpaper…');
  try {
    const r = await api('POST', '/api/me/wallpaper', await prepareImage(f, 'wallpaper'));
    if (r.me.prefs.blur === undefined) r.me.prefs = { ...r.me.prefs, blur: 8, dim: 40 };
    setMe(r.me);
    fillLookTab();
    toast('Wallpaper aplicado!');
  } catch (err) { toast(err.message); }
});
$('#wp-rm').addEventListener('click', async () => {
  try { setMe((await api('DELETE', '/api/me/wallpaper')).me); fillLookTab(); } catch (err) { toast(err.message); }
});

let lookTimer;
for (const id of ['#wp-blur', '#wp-dim']) {
  $(id).addEventListener('input', () => {
    const blur = Number($('#wp-blur').value);
    const dim = Number($('#wp-dim').value);
    $('#wp-blur-val').textContent = blur;
    $('#wp-dim-val').textContent = dim;
    G.me.prefs = { ...G.me.prefs, blur, dim };
    applyWallpaper();
    clearTimeout(lookTimer);
    lookTimer = setTimeout(() => {
      api('PATCH', '/api/me', { prefs: { blur, dim } }).then((r) => { G.me = r.me; }).catch((err) => toast(err.message));
    }, 500);
  });
}

// Voz e áudio
async function fillAudioTab() {
  $('#chk-noise').checked = S.noise;
  $('#audio-msg').textContent = 'As escolhas ficam salvas neste PC.';
  // Fora da call, abre o microfone só para o teste (e para o Windows liberar os nomes dos aparelhos).
  if (!S.mic) {
    try { setMic(await getMicStream()); micTestOpen = true; } catch {}
  }
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const mics = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const outs = devs.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const using = S.micTrack?.getSettings().deviceId;
  const selMic = $('#sel-mic');
  selMic.innerHTML = '';
  selMic.append(h('option', { value: '', text: 'Padrão do Windows' }));
  for (const d of mics) selMic.append(h('option', { value: d.deviceId, text: d.label || 'Microfone' }));
  selMic.value = mics.some((d) => d.deviceId === S.micId) ? S.micId : (S.micId ? using || '' : '');
  const selOut = $('#sel-out');
  selOut.innerHTML = '';
  selOut.append(h('option', { value: '', text: 'Padrão do Windows' }));
  for (const d of outs) selOut.append(h('option', { value: d.deviceId, text: d.label || 'Saída de som' }));
  selOut.value = outs.some((d) => d.deviceId === S.outId) ? S.outId : '';
  selOut.disabled = !HTMLMediaElement.prototype.setSinkId;
}

$('#sel-mic').addEventListener('change', async (e) => {
  const opt = e.target.selectedOptions[0];
  S.micId = e.target.value;
  S.micLabel = S.micId ? opt.textContent : '';
  store.set('mic', S.micId || null);
  store.set('micLabel', S.micLabel || null);
  try {
    setMic(await getMicStream());
    if (!S.voiceServer) micTestOpen = true;
    sendState();
    renderVoice();
    $('#audio-msg').textContent = `Microfone salvo: ${S.micLabel || 'Padrão do Windows'} ✓`;
  } catch {
    $('#audio-msg').textContent = 'Não consegui abrir esse microfone.';
  }
});

$('#sel-out').addEventListener('change', (e) => {
  S.outId = e.target.value;
  store.set('out', S.outId || null);
  for (const a of $$('#audio-sink audio')) a.setSinkId?.(S.outId).catch(() => {});
  if (actx?.setSinkId) actx.setSinkId(S.outId).catch(() => {});
  $('#audio-msg').textContent = 'Saída de som salva ✓';
});

$('#chk-noise').addEventListener('change', async (e) => {
  S.noise = e.target.checked;
  store.set('noise', S.noise ? '1' : '0');
  if (S.mic) { try { setMic(await getMicStream()); sendState(); } catch {} }
});

// ---------- começa ----------
boot();
