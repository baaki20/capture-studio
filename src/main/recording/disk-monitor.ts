/**
 * Free-space watch during recording (R1.17): checks the projects folder's file system every 10 s.
 * Below the warning threshold it warns once; below the stop threshold it asks the session manager
 * to stop and finalize. A failed check is logged and retried on the next tick.
 */
import { promises as fs } from 'node:fs';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';

export const DISK_CHECK_INTERVAL_MS = 10_000;

export interface DiskThresholds {
  warnBytes: number;
  stopBytes: number;
}

export type DiskLevel = 'ok' | 'warn' | 'stop';

/** Free bytes available to this user on the file system holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return stats.bavail * stats.bsize;
}

export function diskLevel(free: number, thresholds: DiskThresholds): DiskLevel {
  if (free < thresholds.stopBytes) return 'stop';
  if (free < thresholds.warnBytes) return 'warn';
  return 'ok';
}

export interface DiskMonitorOptions {
  dir: string;
  thresholds: DiskThresholds;
  onWarn: (free: number) => void;
  onStop: (free: number) => void;
  intervalMs?: number;
  /** Injected for tests; defaults to `statfs`. */
  freeBytes?: (dir: string) => Promise<number>;
  logger?: Logger;
}

export class DiskMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;
  private stopped = false;
  private checking = false;

  constructor(private readonly options: DiskMonitorOptions) {}

  /** Checks once immediately, then on every interval. */
  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(
      () => void this.check(),
      this.options.intervalMs ?? DISK_CHECK_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check; returns the level seen (or null when the check failed or was skipped). */
  async check(): Promise<DiskLevel | null> {
    if (this.checking || this.stopped) return null;
    this.checking = true;
    try {
      const free = await (this.options.freeBytes ?? freeBytes)(this.options.dir);
      const level = diskLevel(free, this.options.thresholds);
      if (level === 'stop') {
        this.stopped = true;
        this.stop();
        this.options.onStop(free);
      } else if (level === 'warn' && !this.warned) {
        this.warned = true;
        this.options.onWarn(free);
      }
      return level;
    } catch (error) {
      (this.options.logger ?? silentLogger).warn(`disk monitor: check failed`, error);
      return null;
    } finally {
      this.checking = false;
    }
  }
}
