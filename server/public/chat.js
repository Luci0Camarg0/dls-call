'use strict';
// DLS Call — chat de texto do servidor (mensagens ficam salvas).

const CH = {
  messages: new Map(), // serverId -> [mensagem]
  hasMore: new Map(),
  loading: false,
};

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const IMG_RE = /\.(gif|png|jpe?g|webp)(\?[^\s]*)?$/i;

function fmtWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 864e5;
  if (diff === 0) return `Hoje às ${hm}`;
  if (diff === 1) return `Ontem às ${hm}`;
  return `${d.toLocaleDateString('pt-BR')} ${hm}`;
}

// Texto da mensagem com links clicáveis e imagens/GIFs por link aparecendo direto.
function messageBody(text) {
  const body = h('div', { class: 'msg-text' });
  const images = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) body.append(text.slice(last, m.index));
    const url = m[0];
    body.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }));
    let u;
    try { u = new URL(url); } catch {}
    if (u && (IMG_RE.test(u.pathname) || /(^|\.)media\d*\.giphy\.com$|^media\.tenor\.com$/.test(u.hostname))) images.push(url);
    last = m.index + url.length;
  }
  if (last < text.length) body.append(text.slice(last));
  const frag = [body];
  for (const src of images.slice(0, 3)) {
    const img = h('img', { class: 'msg-img', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove()); // link quebrado: mostra só o texto
    frag.push(img);
  }
  return frag;
}

function messageEl(m, grouped) {
  const u = userById(m.userId);
  const mine = m.userId === G.me.id;
  const el = h('div', { class: 'msg' + (grouped ? ' grouped' : ''), dataset: { id: m.id } });
  if (grouped) {
    el.append(h('span', { class: 'msg-side-time', text: new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }));
  } else {
    const av = avatarEl(u, 'md');
    av.addEventListener('click', (e) => openProfile(u.id, e));
    el.append(av);
  }
  const main = h('div', { class: 'msg-main' });
  if (!grouped) {
    const name = h('span', { class: 'msg-author', text: u.displayName });
    name.addEventListener('click', (e) => openProfile(u.id, e));
    main.append(h('div', { class: 'msg-head' }, name, h('span', { class: 'msg-time', text: fmtWhen(m.createdAt) })));
  }
  main.append(...messageBody(m.content));
  el.append(main);
  if (mine) {
    el.append(h('div', { class: 'msg-actions' },
      h('button', { title: 'Apagar mensagem', text: '🗑', onclick: () => wsSend({ type: 'chat-delete', serverId: G.serverId, id: m.id }) })));
  }
  return el;
}

function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

function renderChat(keepScroll = false) {
  const list = $('#chat-list');
  const scroll = $('#chat-scroll');
  const msgs = CH.messages.get(G.serverId) || [];
  const prevHeight = scroll.scrollHeight;
  const prevTop = scroll.scrollTop;
  list.innerHTML = '';
  let prev = null;
  for (const m of msgs) {
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
      list.append(h('div', { class: 'day-sep' }, h('span', { text: new Date(m.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) })));
      prev = null;
    }
    const grouped = prev && prev.userId === m.userId && new Date(m.createdAt) - new Date(prev.createdAt) < 7 * 60 * 1000;
    list.append(messageEl(m, grouped));
    prev = m;
  }
  const srv = G.servers.find((s) => s.id === G.serverId);
  $('#chat-top').innerHTML = '';
  if (CH.hasMore.get(G.serverId) === false) {
    $('#chat-top').append(h('div', { class: 'chat-welcome' },
      h('h2', { text: `Bem-vindo a ${srv?.name || 'este servidor'}!` }),
      h('p', { text: 'Este é o começo do #chat. Mande um oi para a galera 👋' })));
  }
  if (keepScroll) scroll.scrollTop = prevTop + (scroll.scrollHeight - prevHeight);
  else scroll.scrollTop = scroll.scrollHeight;
}

async function openChat(serverId) {
  G.unread.delete(serverId);
  $('#chat-input').placeholder = 'Conversar em #chat';
  if (!CH.messages.has(serverId)) {
    CH.messages.set(serverId, []);
    renderChat();
    await loadOlder(serverId, true);
  } else renderChat();
}

async function loadOlder(serverId, first = false) {
  if (CH.loading || CH.hasMore.get(serverId) === false) return;
  CH.loading = true;
  const msgs = CH.messages.get(serverId) || [];
  try {
    const before = !first && msgs[0] ? `?before=${msgs[0].id}` : '';
    const r = await api('GET', `/api/servers/${serverId}/messages${before}`);
    const known = new Set(msgs.map((m) => m.id));
    CH.messages.set(serverId, [...r.messages.filter((m) => !known.has(m.id)), ...msgs]);
    CH.hasMore.set(serverId, r.messages.length === 50);
    if (G.serverId === serverId) renderChat(!first);
  } catch (e) { toast(e.message); }
  CH.loading = false;
}

$('#chat-scroll').addEventListener('scroll', () => {
  if ($('#chat-scroll').scrollTop < 120 && G.serverId) loadOlder(G.serverId);
});

on('chat', (msg) => {
  const list = CH.messages.get(msg.serverId);
  if (list && !list.some((m) => m.id === msg.message.id)) list.push(msg.message);
  const visible = G.serverId === msg.serverId && G.view === 'chat' && !document.hidden;
  if (G.serverId === msg.serverId && G.view === 'chat') {
    const scroll = $('#chat-scroll');
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 150;
    renderChat(!nearBottom && msg.message.userId !== G.me.id);
  }
  if (msg.message.userId !== G.me.id && !visible) {
    G.unread.add(msg.serverId);
    beep('msg');
    renderRail();
    renderSidebar();
  }
});

on('chat-delete', (msg) => {
  const list = CH.messages.get(msg.serverId);
  if (!list) return;
  CH.messages.set(msg.serverId, list.filter((m) => m.id !== msg.id));
  if (G.serverId === msg.serverId) renderChat(true);
});

// Envio: Enter manda, Shift+Enter pula linha.
const chatInput = $('#chat-input');
function autoGrow() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(200, chatInput.scrollHeight) + 'px';
}
chatInput.addEventListener('input', autoGrow);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !G.serverId) return;
  if (!G.wsReady) { toast('Sem conexão. Tentando reconectar…'); return; }
  wsSend({ type: 'chat', serverId: G.serverId, content: text });
  chatInput.value = '';
  autoGrow();
});
