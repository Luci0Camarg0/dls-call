// DLS Call — app de desktop (.exe)
// É uma janela leve que abre o site do seu servidor e adiciona o seletor de tela do Windows.

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, Menu, net, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// Mantém voz e tela funcionando mesmo com a janela minimizada.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Tira o som do próprio app da captura de "som do PC" quando o Chromium permitir.
if (!process.env.DLS_NO_RESTRICT) app.commandLine.appendSwitch('enable-features', 'RestrictOwnAudio');

// Endereço do servidor: um arquivo "servidor.txt" ao lado do .exe tem prioridade
// (assim dá para trocar sem recompilar); senão vale o config.json embutido.
function readServerUrl() {
  if (process.env.DLS_SERVER) return process.env.DLS_SERVER; // para testes
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  for (const f of [path.join(exeDir, 'servidor.txt'), path.join(__dirname, 'servidor.txt')]) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v) return v;
    } catch {}
  }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).serverUrl; } catch {}
  return 'http://localhost:3000';
}
const SERVER = readServerUrl().replace(/\/+$/, '');
const SERVER_ORIGIN = new URL(SERVER).origin;

let win = null;
let lastSources = [];
let chosen = null;

// Para testes: DLS_PROFILE abre uma segunda cópia do app com outra conta.
if (process.env.DLS_PROFILE) app.setPath('userData', path.join(app.getPath('appData'), 'DLS Call ' + process.env.DLS_PROFILE));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

function fromServer(e) {
  try { return new URL(e.senderFrame.url).origin === SERVER_ORIGIN; } catch { return false; }
}

ipcMain.handle('dls:get-sources', async (e) => {
  if (!fromServer(e)) return [];
  lastSources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  let n = 0;
  return lastSources
    .filter((s) => !s.name.startsWith('DLS Call'))
    .map((s) => {
      const isScreen = s.id.startsWith('screen:');
      return {
        id: s.id,
        kind: isScreen ? 'screen' : 'window',
        name: isScreen ? `Tela ${++n}` : s.name,
        thumbnail: 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(70).toString('base64'),
      };
    });
});

ipcMain.handle('dls:select-source', (e, id, audio) => {
  if (!fromServer(e)) return;
  const source = lastSources.find((s) => s.id === id);
  chosen = source ? { source, audio: !!audio } : null;
});

// Atalhos do soundpad: funcionam mesmo com outro programa (jogo) em foco.
ipcMain.handle('dls:set-hotkeys', (e, list) => {
  if (!fromServer(e)) return [];
  globalShortcut.unregisterAll();
  const ok = [];
  for (const accel of (Array.isArray(list) ? list : []).slice(0, 60)) {
    try {
      if (globalShortcut.register(String(accel), () => win?.webContents.send('dls:hotkey', accel))) ok.push(accel);
    } catch {}
  }
  return ok;
});

app.on('will-quit', () => globalShortcut.unregisterAll());

function setupSession() {
  const ses = session.defaultSession;

  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!chosen) return callback({});
    const res = { video: chosen.source };
    if (chosen.audio && request.audioRequested) res.audio = 'loopback';
    chosen = null;
    callback(res);
  });

  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => {
    const origin = (() => { try { return new URL(details.requestingUrl).origin; } catch { return ''; } })();
    cb(origin === SERVER_ORIGIN && allowed.has(perm));
  });
  ses.setPermissionCheckHandler((wc, perm, origin) => {
    try { return new URL(origin).origin === SERVER_ORIGIN && allowed.has(perm); } catch { return false; }
  });
}

// O servidor gratuito "dorme" quando ninguém usa; esperamos ele acordar antes de abrir.
async function waitForServer() {
  const started = Date.now();
  for (;;) {
    try {
      const r = await net.fetch(SERVER + '/health', { cache: 'no-store' });
      if (r.ok) return true;
    } catch {}
    const secs = Math.round((Date.now() - started) / 1000);
    if (win && !win.isDestroyed()) {
      win.webContents.executeJavaScript(
        `window.setStatus && setStatus(${JSON.stringify(secs)}, ${JSON.stringify(SERVER)})`
      ).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2000));
    if (!win || win.isDestroyed()) return false;
  }
}

async function openServer() {
  await win.loadFile(path.join(__dirname, 'loading.html'));
  if (await waitForServer()) win.loadURL(SERVER + '/');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 760,
    minHeight: 500,
    title: 'DLS Call',
    backgroundColor: '#111216',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);

  // Só navega dentro do próprio servidor; links externos abrem no navegador.
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    try { if (new URL(url).origin === SERVER_ORIGIN) return; } catch {}
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Se a internet cair ou o servidor reiniciar, volta para a tela de espera.
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url.startsWith(SERVER)) setTimeout(openServer, 1500);
  });
  win.webContents.on('render-process-gone', () => setTimeout(openServer, 1000));
  // Página recarregou: solta os atalhos (a página registra de novo quando entrar na call).
  win.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame) globalShortcut.unregisterAll(); });

  openServer();
}

app.whenReady().then(() => {
  setupSession();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
