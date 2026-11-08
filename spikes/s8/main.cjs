// Throwaway spike S8 (Phase 3 plan step 0): does the pinned Electron reuse a ScreenCast portal
// restore token, so a second screen acquisition needs no dialog? Run twice: the second launch
// checks reuse across processes. A step that returns in under 1.5 s had no human click.
'use strict';
const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.resolve(__dirname, '..', 'out', 's8');
fs.mkdirSync(OUT, { recursive: true });
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
const run = process.env.S8_RUN ?? '1';
const steps = [];
const log = (m) => console.log(`[s8 run ${run}] ${m}`);
async function sources(label) {
  const t = Date.now();
  try {
    const s = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const ms = Date.now() - t;
    steps.push({ step: label, ms, ids: s.map((x) => x.id) });
    log(`${label}: ${ms} ms, ids ${s.map((x) => x.id).join(',')}`);
    return s[0]?.id ?? null;
  } catch (e) {
    steps.push({ step: label, ms: Date.now() - t, error: String(e) });
    log(`${label}: error ${e}`);
    return null;
  }
}
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  w.webContents.on('console-message', (e) => log(`[page] ${e.message}`));
  await w.loadFile(path.join(__dirname, 'index.html'));
  const open = async (label, id) => {
    const r = await w.webContents.executeJavaScript(`openSource(${JSON.stringify(id)})`);
    await new Promise((res) => setTimeout(res, 2000));
    let videoNodes = null;
    try {
      const dump = JSON.parse(require('node:child_process').execFileSync('pw-dump', { encoding: 'utf8' }));
      videoNodes = dump.filter((o) => o.type === 'PipeWire:Interface:Node' && /Video\/Source/.test(o.info?.props?.['media.class'] ?? '')).map((o) => `${o.info.props['node.name']} (${o.info.state})`);
    } catch (e) { videoNodes = String(e).slice(0, 80); }
    r.videoSourceNodes2sAfterStop = videoNodes;
    steps.push({ step: label, ...r });
    log(`${label}: ${JSON.stringify(r)}`);
  };
  if (process.env.S8_STALE_ID) await open('getUserMedia #0 (id from the previous launch)', process.env.S8_STALE_ID);
  const a = await sources('getSources #1');
  if (a) await open('getUserMedia #1 (id from #1)', a);
  if (a) await open('getUserMedia #2 (same id again, no getSources)', a);
  if (a && process.env.S8_GAP_S) {
    await new Promise((r) => setTimeout(r, Number(process.env.S8_GAP_S) * 1000));
    await open(`getUserMedia #2b (same id after ${process.env.S8_GAP_S} s idle)`, a);
  }
  if (process.env.S8_SKIP_SECOND) { fs.writeFileSync(path.join(OUT, `run-${run}.json`), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, steps }, null, 2)); app.quit(); return; }
  const b = await sources('getSources #2');
  if (b) await open('getUserMedia #3 (id from #2)', b);
  fs.writeFileSync(path.join(OUT, `run-${run}.json`), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, steps }, null, 2));
  app.quit();
});
