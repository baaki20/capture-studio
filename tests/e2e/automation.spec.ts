/**
 * Automation end to end: the real app with automation turned on, driven over its socket the way
 * the MCP server does. A synthetic project (grey screen, magenta camera, a mic with a tone, then
 * two seconds of silence, then a tone again) is listed, read, previewed with a dry run, edited in
 * the editor (which opens for it), undone and redone, its pause found from the waveform cache and
 * cut, a frame captured, and the result exported and checked with ffprobe.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { AUTOMATION_PROTOCOL_VERSION } from '../../src/shared/automation/protocol';
import { timelineDurationUs } from '../../src/shared/project/timeline-ops';
import {
  S,
  SECONDS,
  launchOptions,
  makeProject,
  probeDurationSec,
  writeAutomationSettings,
} from './automation-fixture';

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

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('an assistant lists, edits, undoes, finds pauses, captures and exports over the socket', async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-automation-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-automation-projects-'));
  writeAutomationSettings(userData, projects);
  const doc = makeProject(projects);
  const app = await electron.launch(launchOptions(userData));
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

    // The composed frame (the preview may take a moment to decode its first picture).
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
