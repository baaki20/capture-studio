// Throwaway feasibility harness for spec §4.0 spikes S1, S2, S3, S4 and S7.
// Run: node_modules/.bin/electron spikes/feasibility/main.cjs
'use strict';
const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,GlobalShortcutsPortal');

const OUT = path.resolve(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
const FFMPEG = path.resolve(__dirname, '..', '..', 'resources', 'bin', 'linux-x64', 'ffmpeg');
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[spike]', ...a);

const results = { round: process.env.SPIKE_ROUND || '1',
  env: {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    session: process.env.XDG_SESSION_TYPE,
    desktop: process.env.XDG_CURRENT_DESKTOP,
  },
};
let win;
let pwRec = null;

function save() {
  fs.writeFileSync(path.join(OUT, process.env.SPIKE_ROUND === '2' ? 'results-round2.json' : 'results.json'), JSON.stringify(results, null, 2));
}

app.whenReady().then(() => {
  results.env.ozone = app.commandLine.getSwitchValue('ozone-platform') || 'default';
  win = new BrowserWindow({
    width: 900,
    height: 760,
    title: 'Capture Studio — feasibility tests',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  // Path (b): getDisplayMedia from the page, satisfied through the portal via desktopCapturer.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const t = Date.now();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      log('path B sources', sources.length, 'in', Date.now() - t, 'ms');
      if (!sources.length) return cb({});
      cb({ video: sources[0] });
    } catch (e) {
      log('path B error', e);
      cb({});
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('console-message', (_e, _lvl, msg) => log('[page]', msg));
});

// Path (a): main asks the portal for a source, the page calls getUserMedia with its id.
ipcMain.handle('pick-a', async () => {
  const t = Date.now();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  log('path A sources', sources.map((s) => `${s.id} ${s.name}`), 'in', Date.now() - t, 'ms');
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

// S4 plan (b): record the default sink's monitor with pw-record while the page plays beeps.
ipcMain.handle('pw-start', () => {
  const file = path.join(OUT, (process.env.SPIKE_ROUND === '2' ? 's4-pw-record-2.wav' : 's4-pw-record.wav'));
  try { fs.rmSync(file, { force: true }); } catch {}
  pwRec = spawn('pw-record', ['-P', '{ stream.capture.sink=true }', '--rate', '48000', '--channels', '2', file]);
  pwRec.on('error', (e) => log('pw-record error', e.message));
  return file;
});
ipcMain.handle('pw-stop', async () => {
  if (!pwRec) return null;
  const file = path.join(OUT, (process.env.SPIKE_ROUND === '2' ? 's4-pw-record-2.wav' : 's4-pw-record.wav'));
  pwRec.kill('SIGINT');
  await new Promise((r) => pwRec.once('exit', r));
  pwRec = null;
  try {
    const out = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { file, size: fs.statSync(file).size, out };
  } catch (e) {
    return { file, size: fs.existsSync(file) ? fs.statSync(file).size : 0, out: String(e.stderr || e.message) };
  }
});

// S7: global shortcut through the GlobalShortcuts portal.
ipcMain.handle('hotkey-register', () => {
  const accel = 'CommandOrControl+Alt+Shift+K';
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => {
      log('HOTKEY FIRED, focused =', win.isFocused());
      win.webContents.send('hotkey', { at: Date.now(), focused: win.isFocused() });
    });
  } catch (e) {
    log('hotkey error', e.message);
  }
  log('hotkey register', accel, ok);
  return { accel, ok, registered: globalShortcut.isRegistered(accel) };
});

ipcMain.handle('result', (_e, key, value) => {
  results[key] = value;
  save();
  log('result', key, JSON.stringify(value).slice(0, 400));
});
ipcMain.handle('done', () => {
  save();
  log('ALL DONE ->', path.join(OUT, process.env.SPIKE_ROUND === '2' ? 'results-round2.json' : 'results.json'));
  setTimeout(() => app.quit(), 1500);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { save(); app.quit(); });
