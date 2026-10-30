// Sync-check pattern (§4.5 step 20, §4.6.5): a fullscreen window that flashes white and beeps
// 1 kHz at the same moment every 2 s. Record it with Capture Studio, then run
// tests/sync/analyze.ts.
//
// Run: node_modules/.bin/electron tests/sync/pattern/main.cjs [options]
//   --autostart      start without the click (the Wayland harness uses this)
//   --display=<n>    put the window on display n (0-based, in screen.getAllDisplays() order)
//   --grid           show a pixel grid instead (W6: 1-px white lines every 16 device px)
//   --mute           silent (harness dry runs)
//
// Commands on stdin, one per line (the harness drives these):
//   pause on|off     pause mode (R1.14 check): a full red screen and a steady 3 kHz tone, no
//                    flashes or beeps; nothing of it may end up in a paused recording
//   quit             close the window
// It prints "pattern ready" on stdout once the window is showing.
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const readline = require('node:readline');

const args = process.argv.slice(1);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

// The harness starts the pattern without a click, so audio must start without a gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  const displays = screen.getAllDisplays();
  const display = displays[Number(option('display') ?? 0)] ?? screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    fullscreen: true,
    backgroundColor: '#000000',
    title: 'Capture Studio sync check',
    webPreferences: { backgroundThrottling: false },
  });
  const query = {};
  if (flag('autostart')) query.autostart = '1';
  if (flag('grid')) query.mode = 'grid';
  if (flag('mute')) query.mute = '1';
  win.loadFile(path.join(__dirname, 'index.html'), { query });
  win.webContents.once('did-finish-load', () => console.log('pattern ready'));

  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const [command, value] = line.trim().split(/\s+/);
    if (command === 'pause') {
      void win.webContents.executeJavaScript(`window.pattern.setPause(${String(value === 'on')})`);
    } else if (command === 'quit') {
      app.quit();
    }
  });
  input.on('close', () => undefined);
});
app.on('window-all-closed', () => app.quit());
