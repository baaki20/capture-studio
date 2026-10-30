/**
 * Process metrics during a recording (§4.6.4; R1.22, R1.23). While a session records, every
 * `intervalMs` (60 s) the sampler reads `app.getAppMetrics()` and appends one sample to
 * `<project>/logs/metrics.json`, beside `recording.json` (which the session manager rewrites on
 * every change, so the samples get their own file):
 *
 * - working set (and CPU) per Chromium process type, and per labelled process (engine, shell,
 *   controls, editor, media utility) so a leak can be attributed;
 * - the latest dropped-frame ratios from `rec.stats` (the engine's accounting, §9.3), so the
 *   soak test can read the ratio after the first 10 minutes;
 * - the main process's worst event-loop delay since the previous sample.
 *
 * A sample is also taken at the start and when the recording stops. The file is rewritten
 * atomically each time; a failed write is logged and retried with the next sample. Nothing is
 * written once the project folder is gone (abort).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';

export const METRICS_FILE = 'metrics.json';
export const METRICS_INTERVAL_MS = 60_000;
export const METRICS_VERSION = 1;

/** The parts of Electron's `ProcessMetric` the sampler reads. */
export interface ProcessMetricLike {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  cpu: { percentCPUUsage: number };
  /** Kilobytes, as Electron reports them. */
  memory: { workingSetSize: number; peakWorkingSetSize: number; privateBytes?: number };
}

export interface ProcessGroup {
  count: number;
  workingSetKb: number;
  peakWorkingSetKb: number;
  cpuPercent: number;
}

export interface MetricsSample {
  /** Wall-clock ms since the sampler started. */
  atMs: number;
  /** Recording time without pauses (µs) from the latest stats, or null before the first. */
  elapsedUs: number | null;
  totalWorkingSetKb: number;
  byType: Record<string, ProcessGroup>;
  /** Processes the app could name (engine, shell, controls, editor, media utility…). */
  byLabel: Record<string, ProcessGroup>;
  /** Latest dropped-frame ratios (0–1) from `rec.stats`; null before the first. */
  dropped: { screen: number; camera: number | null } | null;
  /** Worst main-process event-loop delay since the previous sample, ms. */
  eventLoopDelayMaxMs: number | null;
  /** Why the sample was taken. */
  reason: 'start' | 'interval' | 'stop';
}

export interface MetricsFile {
  version: typeof METRICS_VERSION;
  sessionId: string;
  startedAt: string;
  intervalMs: number;
  samples: MetricsSample[];
}

export interface StatsSnapshot {
  elapsedUs: number;
  dropped: { screen: number; camera: number | null };
}

export interface MetricsSamplerDeps {
  /** `app.getAppMetrics()`. */
  getAppMetrics: () => readonly ProcessMetricLike[];
  /** A name for a process (from its window or utility), or null. */
  labelPid?: (pid: number) => string | null;
  /** Max event-loop delay since the last call (ms), then resets; null when unavailable. */
  eventLoopDelayMs?: () => number | null;
  intervalMs?: number;
  now?: () => number;
  nowIso?: () => string;
  write?: (file: string, text: string) => Promise<void>;
  /** Whether the project folder still exists (nothing is written into a deleted folder). */
  rootExists?: (root: string) => Promise<boolean>;
  logger?: Logger;
}

interface Active {
  root: string;
  file: MetricsFile;
  startedAtMs: number;
  timer: ReturnType<typeof setInterval>;
  writing: Promise<void>;
}

function emptyGroup(): ProcessGroup {
  return { count: 0, workingSetKb: 0, peakWorkingSetKb: 0, cpuPercent: 0 };
}

function addTo(groups: Record<string, ProcessGroup>, key: string, m: ProcessMetricLike): void {
  const group = (groups[key] ??= emptyGroup());
  group.count += 1;
  group.workingSetKb += m.memory.workingSetSize;
  group.peakWorkingSetKb += m.memory.peakWorkingSetSize;
  group.cpuPercent = Math.round((group.cpuPercent + m.cpu.percentCPUUsage) * 10) / 10;
}

/** Groups process metrics by type and by label (pure; unit-tested). */
export function summarizeMetrics(
  metrics: readonly ProcessMetricLike[],
  labelPid: (pid: number) => string | null = () => null,
): Pick<MetricsSample, 'totalWorkingSetKb' | 'byType' | 'byLabel'> {
  const byType: Record<string, ProcessGroup> = {};
  const byLabel: Record<string, ProcessGroup> = {};
  let total = 0;
  for (const m of metrics) {
    total += m.memory.workingSetSize;
    addTo(byType, m.type, m);
    const label =
      labelPid(m.pid) ??
      (m.type === 'Browser' ? 'main' : null) ??
      (m.type === 'Utility' ? (m.name ?? m.serviceName ?? null) : null);
    if (label) addTo(byLabel, label, m);
  }
  return { totalWorkingSetKb: total, byType, byLabel };
}

export class MetricsSampler {
  private active: Active | null = null;
  private latest: StatsSnapshot | null = null;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly deps: MetricsSamplerDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? (() => Date.now());
  }

  /** The session being sampled, if any. */
  get root(): string | null {
    return this.active?.root ?? null;
  }

  /** The samples so far (a copy), for diagnostics and the test channel. */
  snapshot(): MetricsFile | null {
    return this.active ? structuredClone(this.active.file) : null;
  }

  /** Starts sampling a session (a new root replaces the previous session). */
  start(root: string, sessionId: string): void {
    if (this.active?.root === root) return;
    void this.stop();
    this.latest = null;
    const intervalMs = this.deps.intervalMs ?? METRICS_INTERVAL_MS;
    this.deps.eventLoopDelayMs?.();
    const active: Active = {
      root,
      startedAtMs: this.now(),
      file: {
        version: METRICS_VERSION,
        sessionId,
        startedAt: (this.deps.nowIso ?? (() => new Date().toISOString()))(),
        intervalMs,
        samples: [],
      },
      timer: setInterval(() => void this.sample('interval'), intervalMs),
      writing: Promise.resolve(),
    };
    active.timer.unref();
    this.active = active;
    void this.sample('start');
  }

  /** `rec.stats`: remembered for the next sample. */
  noteStats(stats: StatsSnapshot): void {
    if (this.active) this.latest = { elapsedUs: stats.elapsedUs, dropped: { ...stats.dropped } };
  }

  /** Takes a final sample and stops; resolves when it is written. */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await this.sample('stop');
    clearInterval(active.timer);
    if (this.active === active) this.active = null;
    await active.writing;
  }

  /** Takes one sample now and queues the file write; resolves when written. */
  async sample(reason: MetricsSample['reason']): Promise<MetricsSample | null> {
    const active = this.active;
    if (!active) return null;
    let summary: ReturnType<typeof summarizeMetrics>;
    try {
      summary = summarizeMetrics(this.deps.getAppMetrics(), this.deps.labelPid);
    } catch (error) {
      this.logger.warn('metrics: getAppMetrics failed', error);
      return null;
    }
    const sample: MetricsSample = {
      atMs: Math.round(this.now() - active.startedAtMs),
      elapsedUs: this.latest ? Math.round(this.latest.elapsedUs) : null,
      ...summary,
      dropped: this.latest ? { ...this.latest.dropped } : null,
      eventLoopDelayMaxMs: this.deps.eventLoopDelayMs?.() ?? null,
      reason,
    };
    active.file.samples.push(sample);
    const text = `${JSON.stringify(active.file, null, 2)}\n`;
    active.writing = active.writing.then(() => this.write(active.root, text));
    await active.writing;
    return sample;
  }

  private async write(root: string, text: string): Promise<void> {
    try {
      const exists = this.deps.rootExists ?? defaultRootExists;
      if (!(await exists(root))) return;
      const file = path.join(root, 'logs', METRICS_FILE);
      await (this.deps.write ?? replaceFile)(file, text);
    } catch (error) {
      this.logger.warn(`metrics: could not write ${METRICS_FILE}`, error);
    }
  }
}

/**
 * Write-and-rename inside the existing `logs/` folder. Unlike `writeFileAtomic` it never creates
 * folders, so a sample racing an abort cannot bring a deleted project folder back.
 */
async function replaceFile(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

async function defaultRootExists(root: string): Promise<boolean> {
  return fs.stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
