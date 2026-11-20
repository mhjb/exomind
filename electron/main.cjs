// The Mac app. Plain CommonJS on purpose (package.json is "type": "module", hence .cjs): Electron's
// main process runs it directly, with no build step between a working checkout and a working .app.
//
// The server is a Node process, so this one starts it on a free loopback
// port and points a window at it. Closing the window leaves the app (and so the playlist poller)
// running, which is what replaces the server in a terminal tab.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const APP_NAME = 'Exo-mind';
// Stated outright rather than derived from the name, and the same folder the server picks for
// itself in a checkout (server/config.ts), so `npm run dev` and the app share one config.
app.setPath('userData', path.join(app.getPath('appData'), 'exo-mind'));
app.setName(APP_NAME);

const DEV = !app.isPackaged;
/** Where the bundled server and UI live: app-server/ in a checkout, Resources/server in the .app. */
const SERVER_DIR = DEV ? path.join(__dirname, '..', 'app-server') : path.join(process.resourcesPath, 'server');
const SERVER = path.join(SERVER_DIR, 'server.mjs');

let server = null;
let win = null;
let baseUrl = '';
/** The last lines the server printed, so a crash can say what happened. */
const tail = [];

// ---------- one copy only ----------
// Two servers polling the same playlist into the same vault would each process every new video.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function dataRoot() {
  return app.getPath('userData');
}

function buildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'build-info.json'), 'utf8'));
  } catch {
    return {};
  }
}

// ---------- starting the server ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${url}/api/config`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline || !server) reject(new Error('The server did not start.\n\n' + tail.slice(-12).join('\n')));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

async function startServer() {
  if (!fs.existsSync(SERVER)) throw new Error(`No built server at ${SERVER}. Run \`npm run app:build\` first.`);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const info = buildInfo();

  server = fork(SERVER, [], {
    // ELECTRON_RUN_AS_NODE makes the child plain Node, using Electron's own Node build. The server
    // has no native modules, so nothing needs rebuilding for it.
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      EXO_PORT: String(port),
      EXO_DATA_DIR: dataRoot(),
      EXO_DIST: path.join(SERVER_DIR, 'dist'),
      // The checkout this was built from: its data/ is copied across on first launch.
      ...(info.builtFrom ? { EXO_LEGACY_DATA: path.join(info.builtFrom, 'data') } : {}),
      EXO_DEFAULT_VAULT: path.join(app.getPath('documents'), 'Exo-mind vault'),
    },
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Kept line by line: an app opened from Finder has nowhere to print, and "it exited" is not
  // something anyone can act on. The same lines go to a log file for the same reason.
  const logFile = path.join(dataRoot(), 'server.log');
  try {
    fs.mkdirSync(dataRoot(), { recursive: true });
    fs.writeFileSync(logFile, `--- ${new Date().toISOString()} v${app.getVersion()}\n`);
  } catch {
    /* logging is a nicety */
  }
  const relay = (stream, out) => {
    let rest = '';
    stream?.on('data', (d) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) {
        out.write(`[server] ${l}\n`);
        tail.push(l);
        if (tail.length > 200) tail.shift();
        try {
          fs.appendFileSync(logFile, l + '\n');
        } catch {
          /* ignore */
        }
      }
    });
  };
  relay(server.stdout, process.stdout);
  relay(server.stderr, process.stderr);
  server.on('exit', (code) => {
    server = null;
    if (!app.isQuitting) {
      const shown = tail.slice(-12).join('\n') || '(the server printed nothing)';
      dialog.showErrorBox(`${APP_NAME} stopped`, `The server exited unexpectedly (code ${code}).\n\n${shown}\n\nFull log: ${logFile}`);
      app.quit();
    }
  });

  await waitForServer(baseUrl);
}

function api(method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${route}`, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          if (res.statusCode >= 400) reject(new Error(j.error || `HTTP ${res.statusCode}`));
          else resolve(j);
        } catch {
          reject(new Error(`${route} returned ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- window ----------

function stateFile() {
  return path.join(dataRoot(), 'window-state.json');
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveState(patch) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {
    /* not worth a dialog */
  }
}

/** A URL on the app's own server — by origin, so :4747 is not mistaken for :47470. */
function isOwn(url) {
  try {
    return new URL(url).origin === baseUrl;
  } catch {
    return false;
  }
}

// No title bar: the buttercup band is the top of the window. The traffic lights sit in the band's
// left end (it is 44px tall; the lights are centred in it), so the band is padded past them and is
// what the window is dragged by. Everything clickable in it stays clickable. In full screen the
// lights go away, and so does the padding. The UI also runs in a browser, so this lives here
// rather than in its stylesheet (see house-style-variations.md).
const DRAG_CSS = `
  .band { -webkit-app-region: drag; user-select: none; }
  .band :is(a, button, input, select, label) { -webkit-app-region: no-drag; }
`;
// !important: the page's own `.band { padding: 0 16px }` is just as specific and comes later in
// the cascade, so without it the lights sit on top of the title.
const INSET_CSS = `.band { padding-left: 84px !important; }`;
let insetKey = null;

async function applyChrome() {
  if (!win) return;
  await win.webContents.insertCSS(DRAG_CSS);
  insetKey = win.isFullScreen() ? null : await win.webContents.insertCSS(INSET_CSS);
}

function createWindow() {
  const saved = readState().bounds || {};
  win = new BrowserWindow({
    width: saved.width || 1400,
    height: saved.height || 900,
    x: saved.x,
    y: saved.y,
    minWidth: 760,
    minHeight: 480,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      // The page is our own server on loopback and needs nothing from Electron: no preload, no bridge.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  if (readState().maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  const keep = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized() || win.isFullScreen()) saveState({ maximized: win.isMaximized() });
    else saveState({ bounds: win.getBounds(), maximized: false });
  };
  win.on('resized', keep);
  win.on('moved', keep);
  win.on('closed', () => (win = null));
  win.on('enter-full-screen', () => {
    if (insetKey) void win.webContents.removeInsertedCSS(insetKey);
    insetKey = null;
  });
  win.on('leave-full-screen', async () => {
    if (!insetKey) insetKey = await win.webContents.insertCSS(INSET_CSS);
  });
  win.webContents.on('did-finish-load', () => void applyChrome());

  // Links to videos, articles and channels open in the real browser; the app window only ever
  // shows the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOwn(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  win.loadURL(baseUrl);
}

function showWindow() {
  if (!baseUrl) return;
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

/** The UI routes by hash (#/queue, #/graph…), so moving between views needs no reload. */
function go(hash) {
  showWindow();
  const set = () => win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', set);
  else void set();
}

async function checkPlaylist() {
  try {
    await api('POST', '/api/poll');
    go('#/queue');
  } catch (e) {
    dialog.showErrorBox('Could not check the playlist', e.message);
  }
}

async function openVault() {
  try {
    const s = await api('GET', '/api/status');
    const err = await shell.openPath(s.vaultPath);
    if (err) throw new Error(err);
  } catch (e) {
    dialog.showErrorBox('Could not open the vault', e.message);
  }
}

// ---------- menu ----------

function buildMenu() {
  const login = app.getLoginItemSettings().openAtLogin;
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => go('#/settings') },
        {
          label: 'Open at Login',
          type: 'checkbox',
          checked: login,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked });
            buildMenu();
          },
        },
        { type: 'separator' },
        { label: 'Open Vault Folder', click: () => void openVault() },
        { label: 'Open Data Folder', click: () => void shell.openPath(dataRoot()) },
        { label: 'Open Server Log', click: () => void shell.openPath(path.join(dataRoot(), 'server.log')) },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        { label: 'Library', accelerator: 'Cmd+1', click: () => go('#/') },
        { label: 'Queue', accelerator: 'Cmd+2', click: () => go('#/queue') },
        { label: 'Graph', accelerator: 'Cmd+3', click: () => go('#/graph') },
        { label: 'Tags', accelerator: 'Cmd+4', click: () => go('#/tags') },
        { label: 'Usage', accelerator: 'Cmd+5', click: () => go('#/usage') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'Cmd+[', click: () => win?.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'Cmd+]', click: () => win?.webContents.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Check Playlist Now', accelerator: 'Cmd+Shift+R', click: () => void checkPlaylist() },
      ],
    },
    {
      // A plain label, not role: "viewMenu" — a role brings its own submenu, and giving it one as
      // well makes AppKit log representedObject warnings at launch.
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- lifecycle ----------

app.on('before-quit', () => {
  app.isQuitting = true;
  server?.kill();
});

// Standard Mac behaviour, and the point: with the window closed the app keeps running, so the
// playlist is still checked on schedule. Quit (Cmd+Q) to stop it.
app.on('window-all-closed', () => {});

app.on('activate', () => showWindow());

app.whenReady().then(async () => {
  buildMenu();
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox(`${APP_NAME} could not start`, e.message);
    app.isQuitting = true;
    app.quit();
    return;
  }
  // Opened at login: run in the background until the Dock icon is clicked.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) createWindow();
});
