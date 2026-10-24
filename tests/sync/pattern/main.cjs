// Sync-check pattern (§4.5 step 20): a fullscreen window that flashes white and beeps 1 kHz at
// the same moment every 2 s. Record it with Capture Studio, then run tests/sync/analyze.ts.
// Run: node_modules/.bin/electron tests/sync/pattern/main.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#000000',
    title: 'Capture Studio sync check',
    webPreferences: { backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
