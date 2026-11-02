/**
 * Automation end to end: the real app with automation turned on, driven over its socket the way
 * the MCP server does. A synthetic project (grey screen, magenta camera, a mic with a tone, then
 * two seconds of silence, then a tone again) is listed, read, previewed with a dry run, edited in
 * the editor (which opens for it), undone and redone, its pause found from the waveform cache and
 * cut, a frame captured, and the result exported and checked with ffprobe.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { AUTOMATION_PROTOCOL_VERSION } from '../../src/shared/automation/protocol';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { timelineDurationUs } from '../../src/shared/project/timeline-ops';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { recordedProject } from '../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
const FFMPEG = path.join(FFMPEG_DIR, 'ffmpeg');
const FFPROBE = path.join(FFMPEG_DIR, 'ffprobe');
const S = 1_000_000;
const SECONDS = 6;

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

function makeProject(projects: string): ProjectV1 {
  const doc = recordedProject({
    durationUs: SECONDS * S,
    pauses: [],
    system: false,
    screenSize: { width: 1280, height: 720 },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
  const media = path.join(projects, 'Automation.cstudio', 'media');
  mkdirSync(media, { recursive: true });
  const d = String(SECONDS);
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=30:duration=${d}`,
    '-vf',
    'hue=s=0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-g',
    '30',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0xFF00FF:s=640x480:r=30:d=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'camera.mp4'),
  ]);
  // A tone with silence from 2 s to 4 s.
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${d}`,
    '-af',
    "volume='if(between(t,2,4),0,0.8)':eval=frame",
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    path.join(media, 'microphone.mp4'),
  ]);
  writeFileSync(
    path.join(projects, 'Automation.cstudio', 'project.json'),
    JSON.stringify(doc, null, 2),
  );
  return doc;
}

/** A minimal client for the automation socket (the MCP server has its own). */
class SocketClient {
  private nextId = 1;
  private buffered = '';
  private readonly pending = new Map<number, (reply: Reply) => void>();

  private constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffered += chunk;
      let i = this.buffered.indexOf('\n');
      while (i >= 0) {
        const reply = JSON.parse(this.buffered.slice(0, i)) as Reply;
        this.buffered = this.buffered.slice(i + 1);
        if (reply.id !== null) this.pending.get(reply.id)?.(reply);
        i = this.buffered.indexOf('\n');
      }
    });
  }

  static async connect(socketPath: string, timeoutMs = 30_000): Promise<SocketClient> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(socketPath);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
        return new SocketClient(socket);
      } catch (error) {
        if (Date.now() > end) throw error;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  request(method: string, params: unknown = {}): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** The result, or throws with the error code. */
  async call<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    const reply = await this.request(method, params);
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
    return reply.result as T;
  }

  close(): void {
    this.socket.destroy();
  }
}

type Reply =
  | { id: number | null; ok: true; result: unknown }
  | { id: number | null; ok: false; error: { code: string; message: string } };

function probeDurationSec(file: string): number {
  const out = execFileSync(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  return Number(out.toString().trim());
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('an assistant lists, edits, undoes, finds pauses, captures and exports over the socket', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-automation-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-automation-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  settings.automation = { enabled: true };
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const doc = makeProject(projects);
  const app = await electron.launch({
    args: ['--ozone-platform=x11', '--disable-features=WebRTCPipeWireCapturer', MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_TEST: '1',
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: FFMPEG_DIR,
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  let client: SocketClient | null = null;
  try {
    await app.firstWindow();
    client = await SocketClient.connect(path.join(userData, 'automation', 'automation.sock'));
    const c = client;
    const editorPage = () => app.windows().find((w) => w.url().includes('editor/index.html'));

    expect(
      await c.call('hello', { client: 'e2e', protocolVersion: AUTOMATION_PROTOCOL_VERSION }),
    ).toMatchObject({ app: 'capture-studio', protocolVersion: AUTOMATION_PROTOCOL_VERSION });
    const { projects: listed } = await c.call<{ projects: { id: string; open: boolean }[] }>(
      'projects.list',
    );
    expect(listed).toEqual([expect.objectContaining({ id: doc.id, open: false })]);

    const saved = await c.call<{ live: boolean; version: number }>('project.get', {
      projectId: doc.id,
    });
    expect(saved).toMatchObject({ live: false, version: 0 });

    // A dry run never opens a window.
    const dry = await c.call<{ applied: boolean; change: { duration: { deltaSeconds: number } } }>(
      'project.edit',
      {
        projectId: doc.id,
        label: 'Cut the first second',
        dryRun: true,
        ops: [{ type: 'cutRange', inUs: 0, outUs: S }],
      },
    );
    expect(dry.applied).toBe(false);
    expect(dry.change.duration.deltaSeconds).toBe(-1);
    expect(editorPage()).toBeUndefined();

    // A real edit opens the editor and lands in its history.
    const edit = await c.call<{ applied: boolean; undoLabel: string }>('project.edit', {
      projectId: doc.id,
      label: 'Cut the first second',
      ifVersion: 0,
      ops: [{ type: 'cutRange', inUs: 0, outUs: S }],
    });
    expect(edit).toMatchObject({ applied: true, undoLabel: 'Cut the first second' });
    const editor = editorPage()!;
    expect(editor).toBeTruthy();
    const liveDuration = () =>
      editor.evaluate(() => {
        const d = window.csEditorDebug?.doc();
        return d ? d.timeline.tracks.flatMap((t) => t.clips) : null;
      });
    const durationOf = async () => {
      const current = (await editor.evaluate(() => window.csEditorDebug?.doc() ?? null))!;
      return timelineDurationUs(current);
    };
    expect(await liveDuration()).not.toBeNull();
    expect(await durationOf()).toBe(5 * S);
    await expect(editor.getByTestId('notice')).toContainText('Assistant: Cut the first second');

    expect(await c.call('project.undo', { projectId: doc.id })).toMatchObject({
      done: true,
      label: 'Cut the first second',
    });
    expect(await durationOf()).toBe(SECONDS * S);
    expect(await c.call('project.redo', { projectId: doc.id })).toMatchObject({ done: true });
    expect(await durationOf()).toBe(5 * S);

    // The pause (2–4 s in the file, 1–3 s on the timeline after the cut) from the peaks cache.
    let silences: { ranges: { startUs: number; endUs: number }[] } | null = null;
    await expect
      .poll(
        async () => {
          const reply = await c.request('audio.silences', {
            projectId: doc.id,
            thresholdDb: -40,
            minDurationUs: 1 * S,
            padUs: 100_000,
          });
          if (reply.ok) silences = reply.result as typeof silences;
          return reply.ok ? 'ready' : reply.error.code;
        },
        { timeout: 60_000 },
      )
      .toBe('ready');
    expect(silences!.ranges).toHaveLength(1);
    const [pause] = silences!.ranges;
    expect(pause!.startUs / S).toBeCloseTo(1.1, 1);
    expect(pause!.endUs / S).toBeCloseTo(2.9, 1);

    await c.call('project.edit', {
      projectId: doc.id,
      label: 'Remove pauses',
      ops: [{ type: 'cutRange', inUs: pause!.startUs, outUs: pause!.endUs }],
    });
    const trimmedUs = await durationOf();
    expect(trimmedUs / S).toBeCloseTo(5 - 1.8, 1);

    // Frames come from the preview's WebGL2 compositor. Software-only virtual displays (plain
    // Xvfb) may not provide it, which the parity test needs too: then this step is noted, not run.
    const previewWorks = await expect
      .poll(
        () =>
          editor.evaluate(
            async () => (await window.csEditorDebug?.capturePreview(500_000)) != null,
          ),
        { timeout: 15_000 },
      )
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    if (previewWorks) {
      await expect
        .poll(
          async () => {
            const reply = await c.request('preview.frame', {
              projectId: doc.id,
              atUs: 500_000,
              maxWidth: 320,
            });
            return reply.ok ? (reply.result as { pngBase64: string; width: number }) : null;
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          width: 320,
          pngBase64: expect.stringMatching(/^iVBORw0KGgo/),
        });
    } else {
      const reply = await c.request('preview.frame', {
        projectId: doc.id,
        atUs: 500_000,
        maxWidth: 320,
      });
      expect(reply).toMatchObject({ ok: false, error: { code: 'not-ready' } });
      test.info().annotations.push({
        type: 'not run',
        description: 'frame capture: the preview cannot render on this display (no WebGL2)',
      });
    }

    const started = await c.call<{ status: string; jobId: string; path: string }>('export.start', {
      projectId: doc.id,
      options: { resolution: '720p', fps: 30, quality: 'draft', encoder: 'software' },
    });
    expect(started.status).toBe('started');
    await expect
      .poll(
        async () =>
          (await c.call<{ state: string }>('export.status', { jobId: started.jobId })).state,
        { timeout: 90_000 },
      )
      .toBe('done');
    expect(existsSync(started.path)).toBe(true);
    expect(probeDurationSec(started.path)).toBeCloseTo(trimmedUs / S, 0);

    // Refusals come back with codes.
    const refused = await c.request('project.edit', {
      projectId: doc.id,
      label: 'Swap',
      ops: [{ type: 'replaceDocument', doc }],
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
  } finally {
    client?.close();
    await app.close().catch(() => undefined);
    await test
      .info()
      .attach('main.log', { path: path.join(userData, 'logs', 'main.log') })
      .catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
