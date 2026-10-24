/**
 * Capture-engine smoke test (step 9): the real engine page, preload and pipeline workers record
 * ~3 s of screen, camera and mic through the real media utility's stream writers, then ffprobe
 * checks the files.
 *
 * Camera and mic are Chromium's fake devices (`--use-fake-device-for-media-stream`). The screen
 * comes from `desktopCapturer` with the X11 capturer (`--ozone-platform=x11`, the PipeWire
 * capturer disabled: Xvfb in CI, XWayland on a Wayland desktop), which lists screens without the
 * portal. The portal path itself (GNOME Wayland) is
 * covered by the manual checklist only.
 *
 * Main's side is played by `electronApp.evaluate`: it creates the engine window, wires the stream
 * and clock ports to a forked media utility, and drives the `engine.*` commands like the session
 * manager does.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const ROOT = path.join(import.meta.dirname, '../..');
const FFPROBE = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`, 'ffprobe');

/** The utility entry chunk that `out/main/index.js` forks (`?modulePath`). */
function utilityEntry(): string {
  const main = readFileSync(path.join(ROOT, 'out/main/index.js'), 'utf8');
  const chunk = /chunks\/index-[\w-]+\.js/.exec(main)?.[0];
  if (!chunk) throw new Error('media utility chunk not found in out/main/index.js');
  return path.join(ROOT, 'out/main', chunk);
}

interface SmokeConfig {
  preload: string;
  page: string;
  utility: string;
  dir: string;
  recordMs: number;
  pauseMs: number;
}

interface ProbeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  sample_rate?: string;
}

function ffprobe(file: string): {
  streams: ProbeStream[];
  format: { duration: string };
  packets: { pts_time: string; flags: string }[];
} {
  const out = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,sample_rate:packet=pts_time,flags',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as ReturnType<typeof ffprobe>;
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('the engine records screen, camera and mic into fragmented MP4 files', async () => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-engine-'));
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-engine-profile-'));
  const mainScript = path.join(dir, 'main.cjs');
  // A bare main: the test drives everything through `evaluate`.
  writeFileSync(mainScript, "require('electron').app.on('window-all-closed', () => {});\n");

  const app = await electron.launch({
    args: [
      '--ozone-platform=x11',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      // Never the ScreenCast portal: on a Wayland desktop Chromium would pick the PipeWire
      // capturer from the session type even under XWayland and open a dialog.
      '--disable-features=WebRTCPipeWireCapturer',
      `--user-data-dir=${userData}`,
      mainScript,
    ],
    cwd: ROOT,
    env: { ...process.env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' },
  });
  try {
    const config: SmokeConfig = {
      preload: path.join(ROOT, 'out/preload/engine.cjs'),
      page: path.join(ROOT, 'out/renderer/engine/index.html'),
      utility: utilityEntry(),
      dir,
      recordMs: 3_000,
      pauseMs: 800,
    };
    const result = await app.evaluate(async (electronModule, cfg: SmokeConfig) => {
      const {
        app: electronApp,
        BrowserWindow,
        desktopCapturer,
        ipcMain,
        MessageChannelMain,
        session,
        utilityProcess,
      } = electronModule;
      await electronApp.whenReady();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const fs = process.getBuiltinModule('node:fs');
      const log: string[] = [];
      const step = (text: string) => {
        log.push(text);
        fs.appendFileSync(`${cfg.dir}/progress.log`, `${text}\n`);
      };

      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(true),
      );
      session.defaultSession.setPermissionCheckHandler(() => true);

      step('const utility = utilityProcess');
      const utility = utilityProcess.fork(cfg.utility, [], { stdio: 'inherit' });
      await new Promise<void>((resolve) => utility.once('spawn', () => resolve()));
      const utilityEvents: { type: string; streamId?: string; message?: string }[] = [];
      utility.on('message', (m: { type: string; streamId?: string; message?: string }) => {
        utilityEvents.push(m);
      });

      step('const win = new BrowserWindow(');
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: cfg.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      win.webContents.on('console-message', (event) => step(`[engine] ${event.message}`));

      const pending = new Map<number, (reply: unknown) => void>();
      const stats: unknown[] = [];
      const ended: unknown[] = [];
      let nextId = 1;
      const ready = new Promise<void>((resolve) => ipcMain.once('engine.ready', () => resolve()));
      ipcMain.on('engine.reply', (_e, reply: { requestId: number }) => {
        pending.get(reply.requestId)?.(reply);
      });
      ipcMain.on('engine.stats', (_e, s: unknown) => stats.push(s));
      ipcMain.on('engine.trackEnded', (_e, s: unknown) => ended.push(s));
      const command = (channel: string, payload: unknown) =>
        new Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>((resolve) => {
          const requestId = nextId++;
          step(`-> ${channel}`);
          const timer = setTimeout(
            () => resolve({ ok: false, error: { message: `${channel} timed out` } }),
            20_000,
          );
          pending.set(requestId, (reply) => {
            clearTimeout(timer);
            resolve(reply as { ok: boolean; value?: unknown; error?: { message: string } });
          });
          win.webContents.send(channel, { requestId, payload });
        });

      step('await win.loadFile(cfg.page);');
      await win.loadFile(cfg.page);
      await ready;

      step('const devices = (await');
      const devices = (await win.webContents.executeJavaScript(
        'navigator.mediaDevices.enumerateDevices().then((d) => d.map((x) => ({ kind: x.kind, deviceId: x.deviceId })))',
      )) as { kind: string; deviceId: string }[];
      const camera = devices.find((d) => d.kind === 'videoinput');
      const mic = devices.find((d) => d.kind === 'audioinput');
      step('const sources = await desktopC');
      // On a Wayland desktop this runs under XWayland, where getSources occasionally never
      // answers; treat that as an unusable screen source rather than hanging the test.
      const sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
        sleep(15_000).then(() => null),
      ]);
      if (sources === null) return { error: 'no-screen-source', log };
      const source = sources[0];
      if (!source || !camera || !mic) {
        return { error: 'missing source or devices', devices, sources: sources.length, log };
      }

      const acquire = await command('engine.acquire', {
        screen: { sourceId: source.id, maxWidth: 3840, maxHeight: 2160, fps: 30 },
        camera: { deviceId: camera.deviceId },
        mic: {
          deviceId: mic.deviceId,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (!acquire.ok) return { error: 'acquire failed', acquire, log };

      const kinds = ['screen', 'camera', 'mic'] as const;
      /** Opens one utility stream per kind plus the clock port, and hands them to the engine. */
      const wire = (sessionId: string) => {
        const streams = kinds.map((kind) => ({ streamId: `${sessionId}_${kind}`, kind }));
        const enginePorts: Electron.MessagePortMain[] = [];
        for (const s of streams) {
          const { port1, port2 } = new MessageChannelMain();
          utility.postMessage(
            { type: 'stream.open', streamId: s.streamId, kind: s.kind, dir: cfg.dir },
            [port1],
          );
          enginePorts.push(port2);
        }
        const clock = new MessageChannelMain();
        utility.postMessage({ type: 'clock.attach' }, [clock.port1]);
        enginePorts.push(clock.port2);
        win.webContents.postMessage(
          'engine.ports',
          { sessionId, streams, clockPort: true },
          enginePorts,
        );
      };
      const startTake = (sessionId: string) =>
        command('engine.start', { sessionId, quality: 'standard', fps: 30, region: null });

      // Take 1 is discarded with a restart; the same tracks must record take 2 (R1.18).
      wire('ses_take1');
      const firstStart = await startTake('ses_take1');
      if (!firstStart.ok) return { error: 'first start failed', firstStart, log };
      await sleep(1_000);
      const restart = await command('engine.stop', { reason: 'restart' });
      if (!restart.ok) return { error: 'restart failed', restart, log };

      wire('ses_smoke');
      const start = await startTake('ses_smoke');
      if (!start.ok) return { error: 'start failed', start, log };

      const third = Math.round((cfg.recordMs - cfg.pauseMs) / 2);
      await sleep(third);
      const pause = await command('engine.pause', {});
      await sleep(cfg.pauseMs);
      const resume = await command('engine.resume', {});
      await sleep(third);
      const stop = await command('engine.stop', { reason: 'stop' });
      if (!stop.ok) return { error: 'stop failed', stop, log };

      for (let i = 0; i < 50; i += 1) {
        if (utilityEvents.filter((e) => e.type === 'stream.closed').length >= 6) break;
        await sleep(100);
      }
      utility.kill();
      win.destroy();
      return {
        acquire,
        restart,
        start,
        pause,
        resume,
        stop,
        stats: stats.length,
        ended,
        utilityEvents,
        log,
      };
    }, config);

    writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    test.skip(
      'error' in result && result.error === 'no-screen-source',
      'desktopCapturer.getSources did not answer (X display without capturable screens)',
    );
    // Diagnostics for a failing run.
    if ('error' in result) console.log(JSON.stringify(result, null, 2));
    expect(result).not.toHaveProperty('error');
    const ok = result as {
      acquire: { ok: boolean; value: { status: string; screen: { width: number } } };
      restart: { ok: boolean; value: { streams: { status: string }[] } };
      start: { ok: boolean; value: { t0Us: number; clock: unknown; streams: unknown[] } };
      stop: {
        ok: boolean;
        value: {
          streams: {
            kind: string;
            status: string;
            framesEncoded: number;
            framesPaused: number;
            startOffsetUs?: number;
            sync?: { mode: string };
            checkpoints: unknown[];
          }[];
          pauses: unknown[];
        };
      };
      stats: number;
      utilityEvents: { type: string }[];
    };
    expect(ok.acquire.value.status).toBe('ready');
    expect(ok.acquire.value.screen.width).toBeGreaterThan(0);
    expect(ok.start.value.streams).toHaveLength(3);
    expect(ok.start.value.clock).not.toBeNull();
    expect(ok.stats).toBeGreaterThan(2);
    expect(ok.utilityEvents.filter((e) => e.type === 'stream.closed')).toHaveLength(6);
    expect(ok.restart.value.streams.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);
    expect(ok.utilityEvents.filter((e) => e.type === 'stream.error')).toEqual([]);

    const byKind = new Map(ok.stop.value.streams.map((s) => [s.kind, s]));
    expect(ok.stop.value.pauses).toHaveLength(1);
    for (const kind of ['screen', 'camera', 'mic']) {
      const s = byKind.get(kind);
      expect(s?.status, kind).toBe('ok');
      expect(s?.framesEncoded, kind).toBeGreaterThan(0);
      expect(s?.startOffsetUs, kind).toEqual(expect.any(Number));
      expect(s?.sync?.mode, kind).toMatch(/shared|arrival-calibrated/);
    }
    expect(byKind.get('mic')?.sync?.mode).toBe('arrival-calibrated');
    expect(byKind.get('mic')?.checkpoints.length).toBeGreaterThan(0);
    expect(byKind.get('camera')?.framesPaused).toBeGreaterThan(0);

    for (const kind of ['screen', 'camera']) {
      const probe = ffprobe(path.join(dir, `${kind}.rec.mp4`));
      expect(probe.streams.map((s) => s.codec_type)).toEqual(['video']);
      expect(probe.streams[0]?.codec_name).toMatch(/h264|vp9|av1|vp8/);
      // Keyframes at most 1 s apart (fragments start on keyframes, R1.13).
      const keys = probe.packets
        .filter((p) => p.flags.startsWith('K'))
        .map((p) => Number(p.pts_time))
        .sort((a, b) => a - b);
      expect(keys.length).toBeGreaterThan(1);
      for (let i = 1; i < keys.length; i += 1) {
        expect((keys[i] ?? 0) - (keys[i - 1] ?? 0)).toBeLessThanOrEqual(1.05);
      }
    }
    const mic = ffprobe(path.join(dir, 'mic.rec.mp4'));
    expect(mic.streams.map((s) => s.codec_name)).toEqual(['opus']);
    // Audio stays continuous across the pause (silence), so it covers the whole recording.
    expect(Number(mic.format.duration)).toBeGreaterThan(2.5);
  } finally {
    await app.close();
    // CS_KEEP_ENGINE_SMOKE=1 keeps the recorded files for inspection.
    if (process.env.CS_KEEP_ENGINE_SMOKE === '1') console.log(`engine smoke files: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});
