// Throwaway spikes S9 (Windows), S10 (macOS) and the polling half of S11 (Phase 3 plan step 0).
// Run on the target machine from the project folder:  npx electron spikes/p3-platform/main.cjs
// Writes spikes/out/p3-platform/<platform>.json. The report holds only the OS family and major
// version, never device names, hostnames or paths, so it can be pasted into docs/spikes/.
'use strict';
const { app, BrowserWindow, desktopCapturer, screen, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = path.resolve(__dirname, '..', 'out', 'p3-platform');
fs.mkdirSync(OUT, { recursive: true });
const report = { platform: process.platform, osMajor: osMajor(), electron: process.versions.electron, results: {} };
const log = (k, v) => { report.results[k] = v; console.log(`[p3] ${k}: ${JSON.stringify(v)}`); };

function osMajor() {
  if (process.platform === 'darwin') { const d = Number(os.release().split('.')[0]); return `macOS ${d >= 25 ? d + 1 : d - 9}`; }
  if (process.platform === 'win32') return Number(os.release().split('.')[2]) >= 22000 ? 'Windows 11' : 'Windows 10';
  return process.platform;
}

async function permissions() {
  if (process.platform !== 'darwin') return;
  log('tcc', {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  });
}

async function sources() {
  const s = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  const screens = s.filter((x) => x.id.startsWith('screen:'));
  // Only the id shapes: window titles could name the user's documents.
  log('sources', { screens: screens.map((x) => x.id), windows: s.length - screens.length, displays: screen.getAllDisplays().length });
  return screens;
}

/** Content protection (S9/S10): a protected magenta window must not appear in a screen capture. */
async function contentProtection(page, screenId) {
  const d = screen.getPrimaryDisplay();
  const probe = new BrowserWindow({ x: d.bounds.x + 40, y: d.bounds.y + 40, width: 400, height: 300, frame: false, alwaysOnTop: true, backgroundColor: '#ff00ff', show: false });
  await probe.loadURL('data:text/html,<body style="margin:0;background:%23ff00ff"></body>');
  const result = {};
  for (const protect of [false, true]) {
    probe.setContentProtection(protect);
    probe.showInactive();
    await new Promise((r) => setTimeout(r, 800));
    result[protect ? 'protected' : 'unprotected'] = await page.webContents.executeJavaScript(`magentaShare(${JSON.stringify(screenId)})`);
  }
  probe.destroy();
  log('contentProtection', result);
}

/** System audio (S9/S10): getDisplayMedia with loopback while another window plays a 440 Hz tone. */
async function loopback(page, screenSource) {
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => cb({ video: screenSource, audio: 'loopback' }));
  const tone = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  await tone.loadURL('data:text/html,<script>const c=new AudioContext();const o=c.createOscillator();o.frequency.value=440;o.connect(c.destination);o.start();</script>');
  await new Promise((r) => setTimeout(r, 500));
  log('loopback', await page.webContents.executeJavaScript('loopbackLevel()', true));
  tone.destroy();
}

/** Cursor hiding (S9/S10): grabs a frame with and without `cursor: 'never'`; a person compares them. */
async function cursorHide(page) {
  const r = await page.webContents.executeJavaScript('cursorFrames()', true);
  for (const [k, url] of Object.entries(r.frames)) fs.writeFileSync(path.join(OUT, `cursor-${k}.png`), Buffer.from(url.split(',')[1], 'base64'));
  log('cursorHide', { constraintApplied: r.settings, note: 'Compare cursor-*.png by eye, then delete them.' });
}

/** S11 (polling half): how evenly `screen.getCursorScreenPoint()` can be sampled at 120 Hz in main. */
async function cursorPolling() {
  const times = [];
  const start = process.hrtime.bigint();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      screen.getCursorScreenPoint();
      times.push(Number(process.hrtime.bigint() - start) / 1000);
      if (times.length >= 600) { clearInterval(timer); resolve(); }
    }, 1000 / 120);
  });
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const q = (p) => +(gaps[Math.floor(p * (gaps.length - 1))] / 1000).toFixed(2);
  log('cursorPolling', { samples: times.length, gapMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) } });
}

app.whenReady().then(async () => {
  const page = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await page.loadFile(path.join(__dirname, 'index.html'));
  const steps = [permissions, async () => {
    const screens = await sources();
    if (!screens[0]) return;
    await contentProtection(page, screens[0].id);
    await loopback(page, screens[0]);
    await cursorHide(page);
  }, cursorPolling];
  for (const step of steps) {
    try { await step(); } catch (e) { log(`error in ${step.name || 'step'}`, String(e)); }
  }
  fs.writeFileSync(path.join(OUT, `${process.platform}.json`), JSON.stringify(report, null, 2));
  app.quit();
});
