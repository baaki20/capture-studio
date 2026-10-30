/**
 * Recording metrics sampler (§4.6.4; R1.22, R1.23): grouping by process type and label, one
 * sample at start, per interval and at stop, the latest dropped-frame ratios, and nothing
 * written into a deleted project folder.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  METRICS_FILE,
  MetricsSampler,
  summarizeMetrics,
  type MetricsFile,
  type ProcessMetricLike,
} from '../../src/main/diagnostics/metrics-sampler';

const metric = (
  pid: number,
  type: string,
  workingSetSize: number,
  extra: Partial<ProcessMetricLike> = {},
): ProcessMetricLike => ({
  pid,
  type,
  cpu: { percentCPUUsage: 1.5 },
  memory: { workingSetSize, peakWorkingSetSize: workingSetSize + 10 },
  ...extra,
});

describe('summarizeMetrics', () => {
  it('sums working sets per type and per labelled process', () => {
    const summary = summarizeMetrics(
      [
        metric(1, 'Browser', 100),
        metric(2, 'Tab', 300),
        metric(3, 'Tab', 50),
        metric(4, 'GPU', 200),
        metric(5, 'Utility', 40, { name: 'Capture Studio media' }),
      ],
      (pid) => (pid === 2 ? 'engine' : pid === 3 ? 'shell' : null),
    );
    expect(summary.totalWorkingSetKb).toBe(690);
    expect(summary.byType.Tab).toEqual({
      count: 2,
      workingSetKb: 350,
      peakWorkingSetKb: 370,
      cpuPercent: 3,
    });
    expect(Object.keys(summary.byLabel).sort()).toEqual([
      'Capture Studio media',
      'engine',
      'main',
      'shell',
    ]);
    expect(summary.byLabel.engine?.workingSetKb).toBe(300);
  });
});

describe('MetricsSampler', () => {
  let root: string;
  let clock: number;
  let memory: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-metrics-'));
    await fs.mkdir(path.join(root, 'logs'));
    clock = 1_000;
    memory = 1_000;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  const sampler = () =>
    new MetricsSampler({
      getAppMetrics: () => [metric(1, 'Browser', memory)],
      eventLoopDelayMs: () => 12,
      intervalMs: 60_000,
      now: () => clock,
      nowIso: () => '2026-10-25T10:00:00.000Z',
    });

  const read = async (): Promise<MetricsFile> =>
    JSON.parse(await fs.readFile(path.join(root, 'logs', METRICS_FILE), 'utf8')) as MetricsFile;

  it('samples at start, every interval and at stop, with the latest stats', async () => {
    const s = sampler();
    s.start(root, 'S1');
    await vi.waitFor(async () => expect((await read()).samples).toHaveLength(1));

    s.noteStats({ elapsedUs: 59_000_000, dropped: { screen: 0.002, camera: 0.01 } });
    memory = 1_500;
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    clock += 30_000;
    await s.stop();

    const file = await read();
    expect(file).toMatchObject({ version: 1, sessionId: 'S1', intervalMs: 60_000 });
    expect(file.samples.map((x) => x.reason)).toEqual(['start', 'interval', 'stop']);
    expect(file.samples.map((x) => x.atMs)).toEqual([0, 60_000, 90_000]);
    expect(file.samples[0]?.dropped).toBeNull();
    expect(file.samples[1]).toMatchObject({
      elapsedUs: 59_000_000,
      totalWorkingSetKb: 1_500,
      dropped: { screen: 0.002, camera: 0.01 },
      eventLoopDelayMaxMs: 12,
    });
    expect(s.root).toBeNull();
    expect(s.snapshot()).toBeNull();
  });

  it('writes nothing once the project folder is gone (abort)', async () => {
    const s = sampler();
    s.start(root, 'S2');
    await vi.waitFor(async () => expect((await read()).samples).toHaveLength(1));
    await fs.rm(root, { recursive: true, force: true });
    await s.stop();
    await expect(fs.stat(root)).rejects.toThrow();
  });

  it('starting a new session stops the previous one', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-metrics-'));
    await fs.mkdir(path.join(other, 'logs'));
    try {
      const s = sampler();
      s.start(root, 'A');
      s.start(other, 'B');
      expect(s.root).toBe(other);
      await vi.waitFor(async () => {
        const a = await read();
        expect(a.samples.map((x) => x.reason)).toEqual(['start', 'stop']);
      });
      await s.stop();
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
