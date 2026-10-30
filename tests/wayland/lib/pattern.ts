/**
 * The sync-check pattern window (`tests/sync/pattern/`) under harness control: started without a
 * click, switched into pause mode (red screen, 3 kHz tone) and closed through its stdin.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { ELECTRON, ROOT, type Mode } from './app';

const PATTERN_MAIN = path.join(ROOT, 'tests/sync/pattern/main.cjs');

export interface PatternOptions {
  mode: Mode;
  display?: number;
  grid?: boolean;
  /** Dry runs keep the speakers quiet. */
  mute?: boolean;
}

export class Pattern {
  private constructor(private readonly child: ChildProcess) {}

  static async start(options: PatternOptions): Promise<Pattern> {
    const args = [
      // Dry runs record the X11 root window, so the pattern must be an X11 window too.
      ...(options.mode === 'dry-run' ? ['--ozone-platform=x11'] : []),
      PATTERN_MAIN,
      '--autostart',
      ...(options.display !== undefined ? [`--display=${String(options.display)}`] : []),
      ...(options.grid ? ['--grid'] : []),
      ...(options.mute ? ['--mute'] : []),
    ];
    const env = { ...process.env };
    if (options.mode === 'dry-run') env.WAYLAND_DISPLAY = '';
    const child = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the pattern window did not start')), 20_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('pattern ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', () => reject(new Error('the pattern window exited')));
    });
    // The first beep is scheduled about a second after start.
    await new Promise((r) => setTimeout(r, 1_500));
    return new Pattern(child);
  }

  /** Pause mode on or off (R1.14 scenario). */
  pause(on: boolean): void {
    this.child.stdin?.write(`pause ${on ? 'on' : 'off'}\n`);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const gone = new Promise((r) => this.child.once('exit', r));
    this.child.stdin?.write('quit\n');
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 3_000);
    await gone;
    clearTimeout(timer);
  }
}
