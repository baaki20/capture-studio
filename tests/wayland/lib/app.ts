/**
 * One running Capture Studio for a scenario: launches the built app (`out/main/index.js`) with
 * the harness profile and the test-only control channel, records every state, notice and
 * project event, and drives it through the channel and the real CLI (`--action`, forwarded by
 * the single-instance lock, R1.2).
 *
 * Modes:
 * - `real`: the normal Wayland app; recording opens the GNOME portal, which a human answers.
 * - `dry-run`: `CS_TEST=1` on X11 with Chromium's fake camera and mic and the X11 screen
 *   capturer (no portal), like the e2e tests, so the harness can run with nobody present.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Settings } from '../../../src/shared/settings/schema';
import { ChannelClient } from './channel-client';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const MAIN = path.join(ROOT, 'out/main/index.js');
export const BIN_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
export const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;

export type Mode = 'real' | 'dry-run';

export interface StatePayload {
  state: string;
  sessionId: string | null;
  elapsedUs: number;
  failureReason: string | null;
  root: string | null;
}
export interface Notice {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  stream: string | null;
}
export interface ProjectReady {
  projectId: string;
  root: string;
  name: string;
}
export interface WindowInfo {
  id: number;
  role: string | null;
  title: string;
  visible: boolean;
  minimized: boolean;
  focused: boolean;
}

export interface Timed<T> {
  at: number;
  value: T;
}

export interface LaunchOptions {
  mode: Mode;
  profileDir: string;
  /** Where main's stdout/stderr go. */
  logFile: string;
  env?: Record<string, string>;
}

/** Environment and switches of a mode (dry runs match `tests/e2e/recorder-ui.spec.ts`). */
export function modeLaunch(mode: Mode): { args: string[]; env: Record<string, string> } {
  if (mode === 'real') return { args: [], env: {} };
  return {
    args: [
      '--ozone-platform=x11',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--disable-features=WebRTCPipeWireCapturer',
    ],
    env: { CS_TEST: '1', XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' },
  };
}

export class AppSession {
  readonly states: Timed<StatePayload>[] = [];
  readonly notices: Timed<Notice>[] = [];
  readonly projects: Timed<ProjectReady>[] = [];
  readonly exited: Promise<number | null>;
  private exitCode: number | null | undefined = undefined;

  private constructor(
    readonly options: LaunchOptions,
    readonly socket: string,
    readonly child: ChildProcess,
    readonly channel: ChannelClient,
    readonly env: NodeJS.ProcessEnv,
    readonly args: string[],
  ) {
    this.exited = new Promise((resolve) => {
      child.once('exit', (code) => {
        this.exitCode = code;
        resolve(code);
      });
    });
    channel.onEvent((e) => {
      const at = Date.now();
      if (e.event === 'state') this.states.push({ at, value: e.payload as StatePayload });
      else if (e.event === 'notice') this.notices.push({ at, value: e.payload as Notice });
      else if (e.event === 'project-ready') {
        this.projects.push({ at, value: e.payload as ProjectReady });
      }
    });
  }

  static async launch(options: LaunchOptions): Promise<AppSession> {
    await fs.mkdir(options.profileDir, { recursive: true });
    const socket = path.join(options.profileDir, 'control.sock');
    const { args, env: modeEnv } = modeLaunch(options.mode);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...modeEnv,
      CS_USER_DATA_DIR: options.profileDir,
      CS_FFMPEG_DIR: BIN_DIR,
      CS_HARNESS_SOCKET: socket,
      ...options.env,
    };
    const log = createWriteStream(options.logFile, { flags: 'a' });
    const child = spawn(ELECTRON, [...args, MAIN], { cwd: ROOT, env, stdio: 'pipe' });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const channel = await ChannelClient.connect(socket, 45_000);
    const session = new AppSession(options, socket, child, channel, env, args);
    await session.waitForShell();
    return session;
  }

  get running(): boolean {
    return this.exitCode === undefined;
  }

  call<T = unknown>(cmd: string, args?: unknown, timeoutMs?: number): Promise<T> {
    return this.channel.call<T>(cmd, args, timeoutMs);
  }

  status(): Promise<
    StatePayload & { root: string | null; pid: number; tray: { present: boolean; state: string } }
  > {
    return this.call('status');
  }

  windows(): Promise<WindowInfo[]> {
    return this.call('windows');
  }

  evalIn<T = unknown>(window: string, code: string): Promise<T> {
    return this.call<T>('eval', { window, code });
  }

  /** Waits until the shell's setup panel can record. */
  async waitForShell(timeoutMs = 30_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const ready = await this.evalIn<boolean>(
        'shell',
        `!!document.querySelector('[data-testid="record-button"]')`,
      ).catch(() => false);
      if (ready) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('the setup panel did not appear');
  }

  /**
   * Applies setup choices (settings) and reloads the shell so its setup panel shows them; the
   * panel hands them to the recorder when Record is clicked.
   */
  async configure(patch: { recorder?: Partial<Settings['recorder']> } & Record<string, unknown>) {
    await this.call('settings.patch', patch);
    await this.evalIn('shell', 'setTimeout(() => location.reload(), 0); true');
    await new Promise((r) => setTimeout(r, 500));
    await this.waitForShell();
  }

  /** Clicks Record in the setup panel (it releases its previews first, like a user). */
  async clickRecord(): Promise<void> {
    await this.evalIn(
      'shell',
      `document.querySelector('[data-testid="record-button"]').click(); true`,
    );
  }

  /** Dispatches an action through the control channel. */
  action(type: string): Promise<unknown> {
    return this.call('action', { type });
  }

  /**
   * Runs `capture-studio --action <type>` as a second instance, the way a GNOME shortcut does.
   * Resolves with how long the second process took and when it was started.
   */
  async cli(type: string): Promise<{ startedAt: number; exitMs: number; code: number | null }> {
    const startedAt = Date.now();
    const child = spawn(ELECTRON, [...this.args, MAIN, '--action', type], {
      cwd: ROOT,
      env: this.env,
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { startedAt, exitMs: Date.now() - startedAt, code };
  }

  /** The exact command line a GNOME custom shortcut should run (W10). */
  shortcutCommand(type: string): string {
    const quote = (v: string) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
    return [
      'env',
      `CS_USER_DATA_DIR=${quote(this.options.profileDir)}`,
      `CS_FFMPEG_DIR=${quote(BIN_DIR)}`,
      quote(ELECTRON),
      quote(MAIN),
      '--action',
      type,
    ].join(' ');
  }

  /** A position in the state history, for `waitState(…, from)`. */
  mark(): number {
    return this.states.length;
  }

  /** Resolves with the first state at or after history position `from` that matches. */
  async waitState(
    predicate: (s: StatePayload) => boolean,
    timeoutMs: number,
    from = 0,
  ): Promise<Timed<StatePayload> & { index: number }> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const index = this.states.findIndex((s, i) => i >= from && predicate(s.value));
      const hit = this.states[index];
      if (hit) return { ...hit, index };
      if (!this.running) throw new Error('the app exited');
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no matching state within ${String(Math.round(timeoutMs / 1000))} s`);
  }

  /** The project folder of the recording in progress (once its first stats arrived). */
  async waitRoot(timeoutMs: number): Promise<string> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const status = await this.status();
      if (status.root && ['recording', 'paused'].includes(status.state)) return status.root;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('no recording folder');
  }

  async waitProject(since: number, timeoutMs: number): Promise<Timed<ProjectReady>> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = this.projects.find((p) => p.at >= since);
      if (hit) return hit;
      if (!this.running) throw new Error('the app exited');
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no project became ready');
  }

  /** SIGKILL the main process (R1.21) and wait for it to be gone. */
  async kill(): Promise<void> {
    const { pid } = await this.status();
    process.kill(pid, 'SIGKILL');
    await this.exited;
    this.channel.close();
  }

  /** Quits normally (falls back to SIGTERM). */
  async quit(): Promise<void> {
    if (!this.running) return;
    await this.call('quit').catch(() => undefined);
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000));
    if ((await Promise.race([this.exited, timeout])) === 'timeout') this.child.kill('SIGTERM');
    await this.exited;
    this.channel.close();
  }
}
