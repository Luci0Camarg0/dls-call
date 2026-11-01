'use strict';
// DLS Call — "Ouvir junto" (YouTube).
// O servidor diz "música X, segundo Y, tocando/pausado"; cada PC toca no próprio player
// do YouTube e se corrige se ficar mais de 2 s fora do tempo.

const M = {
  state: null, offset: 0,
  player: null, ready: false, apiPromise: null, loadedKey: null,
  visible: false, collapsed: false, seeking: false, stuck: 0,
  vol: Number(store.get('musicvol') ?? 50),
};
$('#music-vol').value = M.vol;

function musicSend(action, extra = {}) { wsSend({ type: 'music', action, ...extra }); }

function musicExpected() {
  const m = M.state;
  if (!m || !m.current) return 0;
  return m.playing ? m.position + (Date.now() + M.offset - m.updatedAt) / 1000 : m.position;
}

function ensureYT() {
  if (!M.apiPromise) {
    M.apiPromise = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => {
        M.player = new YT.Player('yt-player', {
          width: '100%', height: '100%',
          playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, origin: location.origin },
          events: {
            onReady: () => {
              M.ready = true;
              M.player.setVolume(M.vol);
              if (S.deafened) M.player.mute();
              resolve();
              syncPlayer();
            },
            onStateChange: onYTState,
            onError: () => {
              const cur = M.state?.current;
              if (!cur) return;
              toast('Esse vídeo não pode tocar fora do YouTube. Pulando…', 3500);
              musicSend('error', { key: cur.key });
            },
          },
        });
      };
      document.head.append(h('script', { src: 'https://www.youtube.com/iframe_api' }));
    });
  }
  return M.apiPromise;
}

function onYTState(e) {
  const cur = M.state?.current;
  if (e.data === YT.PlayerState.ENDED && cur && M.loadedKey === cur.key) musicSend('ended', { key: cur.key });
  if (e.data === YT.PlayerState.PLAYING) { M.stuck = 0; $('#music-unlock').classList.add('hidden'); }
}

function syncPlayer() {
  if (!M.ready) return;
  const m = M.state;
  const p = M.player;
  if (!m || !m.current) {
    if (M.loadedKey) { p.stopVideo(); M.loadedKey = null; }
    return;
  }
  const want = musicExpected();
  if (M.loadedKey !== m.current.key) {
    M.loadedKey = m.current.key;
    if (m.playing) p.loadVideoById({ videoId: m.current.id, startSeconds: want });
    else p.cueVideoById({ videoId: m.current.id, startSeconds: want });
    return;
  }
  const st = p.getPlayerState();
  const P = YT.PlayerState;
  if (st === P.ENDED) return;
  if (m.playing) {
    if (Math.abs(p.getCurrentTime() - want) > 2) p.seekTo(want, true);
    if (st !== P.PLAYING && st !== P.BUFFERING) p.playVideo();
    // O navegador às vezes bloqueia som automático; aí pedimos um clique.
    if (st === P.UNSTARTED || st === P.CUED || st === P.PAUSED) {
      if (++M.stuck >= 2) $('#music-unlock').classList.remove('hidden');
    }
  } else {
    if (st === P.PLAYING || st === P.BUFFERING) p.pauseVideo();
    if (Math.abs(p.getCurrentTime() - want) > 1) p.seekTo(want, true);
  }
}

on('music', (msg) => {
  if (msg.serverId !== S.voiceServer) return;
  M.offset = msg.now - Date.now();
  const prev = M.state?.current;
  M.state = msg.state;
  const cur = M.state.current;
  if (cur) {
    if (!M.visible) { M.visible = true; M.collapsed = true; }
    if (!prev || prev.key !== cur.key) toast(`🎵 Tocando: ${cur.title}`);
    ensureYT().then(syncPlayer);
  } else if (M.collapsed && !M.state.queue.length) {
    M.visible = false;
  }
  syncPlayer();
  renderMusic();
});

function renderMusic() {
  const m = M.state;
  const cur = m?.current;
  $('#music').classList.toggle('hidden', !M.visible || !S.voiceServer);
  $('#music').classList.toggle('collapsed', M.collapsed);
  $('#music-collapse').title = M.collapsed ? 'Abrir' : 'Minimizar';
  $('#btn-music').classList.toggle('on', !!cur);
  $('#music-empty').classList.toggle('hidden', !!cur);
  $('#music-title').textContent = cur ? cur.title : 'Nada tocando';
  $('#music-by').textContent = cur ? `adicionado por ${cur.by}` : '';
  $('#music-mini').textContent = M.collapsed && cur ? cur.title : '';
  $('#music-toggle').classList.toggle('active', !!m?.playing);
  $('#music-count').textContent = m?.queue.length ? `(${m.queue.length})` : '';
  const list = $('#music-queue');
  list.innerHTML = '';
  for (const item of m?.queue || []) {
    list.append(h('li', {},
      h('span', { text: item.title, title: item.title }),
      h('small', { text: item.by }),
      h('button', { title: 'Tirar da fila', text: '✕', onclick: () => musicSend('remove', { key: item.key }) })));
  }
}

setInterval(() => {
  const cur = M.state?.current;
  if (!M.visible || M.collapsed || !cur) return;
  const t = M.ready && M.loadedKey === cur.key ? M.player.getCurrentTime() : musicExpected();
  const dur = M.ready ? M.player.getDuration() : 0;
  const seek = $('#music-seek');
  seek.max = Math.max(1, Math.floor(dur));
  if (!M.seeking) seek.value = Math.floor(t);
  $('#music-time').textContent = fmtTime(M.seeking ? seek.value : t);
  $('#music-dur').textContent = fmtTime(dur);
}, 500);
setInterval(syncPlayer, 2000);

function resetMusic() {
  M.state = null;
  M.visible = false;
  M.collapsed = false;
  if (M.ready) M.player.stopVideo();
  M.loadedKey = null;
  renderMusic();
}

$('#btn-music').addEventListener('click', () => {
  if (!M.visible) { M.visible = true; M.collapsed = false; }
  else M.collapsed = !M.collapsed;
  ensureYT();
  renderMusic();
  if (!M.collapsed) $('#music-url').focus();
});
$('#music-collapse').addEventListener('click', () => {
  M.collapsed = !M.collapsed;
  if (!M.collapsed) ensureYT();
  else if (!M.state?.current) M.visible = false;
  renderMusic();
});
$('#music-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#music-url').value.trim();
  if (!url) return;
  ensureYT();
  musicSend('add', { url });
  $('#music-url').value = '';
});
$('#music-toggle').addEventListener('click', () => { if (M.state?.current) musicSend('toggle'); });
$('#music-skip').addEventListener('click', () => { if (M.state?.current) musicSend('skip'); });
$('#music-seek').addEventListener('input', () => { M.seeking = true; $('#music-time').textContent = fmtTime($('#music-seek').value); });
$('#music-seek').addEventListener('change', () => { M.seeking = false; musicSend('seek', { t: Number($('#music-seek').value) }); });
$('#music-vol').addEventListener('input', (e) => {
  M.vol = Number(e.target.value);
  store.set('musicvol', String(M.vol));
  if (M.ready) M.player.setVolume(M.vol);
});
$('#music-unlock').addEventListener('click', () => {
  $('#music-unlock').classList.add('hidden');
  M.stuck = 0;
  if (M.ready) { M.player.playVideo(); syncPlayer(); }
});
