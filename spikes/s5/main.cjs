// Throwaway spike S5 (spec §4.0): mediabunny fMP4 writing, crash recovery, timestamp decode.
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.resolve(__dirname, '..', 'out', 's5');
fs.mkdirSync(OUT, { recursive: true });
const BIN = path.resolve(__dirname, '..', '..', 'resources', 'bin', 'linux-x64');
const FILE = path.join(OUT, 'rec.mp4');
let fd = null, writes = 0, lastFsync = Date.now(), maxPos = 0, outOfOrder = 0;
const probe = (f) => { try { return execFileSync(path.join(BIN, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,nb_read_packets', '-count_packets', '-of', 'json', f]).toString(); } catch (e) { return 'PROBE FAILED ' + String(e.stderr || e.message); } };
ipcMain.handle('open', () => { console.log('[main] open'); fs.rmSync(FILE, { force: true }); fd = fs.openSync(FILE, 'w'); return FILE; });
ipcMain.handle('write', (_e, data, pos) => {
  if (pos < maxPos) outOfOrder++;
  fs.writeSync(fd, data, 0, data.length, pos); writes++; maxPos = Math.max(maxPos, pos + data.length);
  if (Date.now() - lastFsync > 2000) { fs.fsyncSync(fd); lastFsync = Date.now(); }
});
ipcMain.handle('close', () => { console.log('[main] close, writes', writes); fs.fsyncSync(fd); fs.closeSync(fd); return { writes, outOfOrder, size: fs.statSync(FILE).size, probe: JSON.parse(probe(FILE)) }; });
ipcMain.handle('crash-recover', () => {
  const buf = fs.readFileSync(FILE); const cut = Math.floor(buf.length * 0.55);
  const t = path.join(OUT, 'truncated.rec.mp4'), r = path.join(OUT, 'recovered.mp4');
  fs.writeFileSync(t, buf.subarray(0, cut)); fs.rmSync(r, { force: true });
  let err = '';
  try { execFileSync(path.join(BIN, 'ffmpeg'), ['-v', 'error', '-y', '-i', t, '-c', 'copy', '-movflags', '+faststart', r]); } catch (e) { err = String(e.stderr || e.message).slice(0, 300); }
  return { cutBytes: cut, remuxErrors: err, probe: fs.existsSync(r) ? JSON.parse(probe(r)) : null };
});
ipcMain.handle('report', (_e, r) => { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(r, null, 2)); console.log(JSON.stringify(r, null, 2)); app.quit(); });
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, nodeIntegrationInWorker: true, contextIsolation: false, backgroundThrottling: false } });
  w.webContents.on('console-message', (e) => console.log('[page]', e.message));
  w.webContents.on('did-finish-load', () => console.log('[main] page loaded'));
  w.webContents.on('did-fail-load', (_e, c, d) => console.log('[main] load failed', c, d));
  w.webContents.on('render-process-gone', (_e, d) => console.log('[main] renderer gone', JSON.stringify(d)));
  console.log('[main] window created');
  w.loadFile(path.join(__dirname, 'index.html'));
});
