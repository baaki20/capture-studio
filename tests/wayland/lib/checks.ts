/**
 * Automated checks of the harness: one `Check` per measured requirement, and helpers that read
 * a recorded project (schema, media files, `logs/recording.json`, `logs/metrics.json`) and turn
 * sync analysis into R1.24 verdicts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { MetricsFile } from '../../../src/main/diagnostics/metrics-sampler';
import { parseProject } from '../../../src/shared/project/migrations';
import type { ProjectV1 } from '../../../src/shared/project/schema';
import type { ProjectSyncReport } from '../../sync/analysis';
import { BIN_DIR } from './app';

export type Status = 'pass' | 'fail' | 'not-testable' | 'info' | 'error';

export interface Check {
  requirement: string;
  name: string;
  status: Status;
  value?: string;
  limit?: string;
  detail?: string;
}

export function check(
  requirement: string,
  name: string,
  ok: boolean,
  value?: string,
  limit?: string,
  detail?: string,
): Check {
  return {
    requirement,
    name,
    status: ok ? 'pass' : 'fail',
    ...(value === undefined ? {} : { value }),
    ...(limit === undefined ? {} : { limit }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export function info(requirement: string, name: string, value: string, detail?: string): Check {
  return { requirement, name, status: 'info', value, ...(detail ? { detail } : {}) };
}

export function notTestable(requirement: string, name: string, why: string): Check {
  return { requirement, name, status: 'not-testable', detail: why };
}

export function errorCheck(requirement: string, name: string, error: unknown): Check {
  return {
    requirement,
    name,
    status: 'error',
    detail: error instanceof Error ? error.message : String(error),
  };
}

export const ms = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : `${v.toFixed(digits)} ms`;
export const pct = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : `${(v * 100).toFixed(2)} %`;

// ---------------------------------------------------------------------------------------------
// Projects

export interface MediaFileInfo {
  role: string;
  path: string;
  exists: boolean;
  durationUs: number;
  probedUs: number | null;
  /** Where the file starts on the session clock. */
  startOffsetUs: number;
  endedEarly: boolean;
}

export interface StreamLogStats {
  kind: string;
  label: string | null;
  framesIn?: number;
  framesEncoded?: number;
  framesDropped?: number;
  encoder: { name: string; hardware: boolean } | null;
  endedEarly: boolean;
}

export interface ProjectInfo {
  root: string;
  doc: ProjectV1 | null;
  error: string | null;
  media: MediaFileInfo[];
  log: { streams: StreamLogStats[]; notices: { level: string; message: string }[] } | null;
  metrics: MetricsFile | null;
}

/** Container duration of a file in µs, or null when ffprobe cannot read it. */
export function probeDurationUs(file: string): number | null {
  const r = spawnSync(
    path.join(BIN_DIR, 'ffprobe'),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  const seconds = Number(r.stdout.trim());
  return r.status === 0 && Number.isFinite(seconds) ? Math.round(seconds * 1e6) : null;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export async function inspectProject(root: string): Promise<ProjectInfo> {
  const raw = await readJson(path.join(root, 'project.json'));
  const parsed = raw ? parseProject(raw) : null;
  const doc = parsed?.ok ? parsed.project : null;
  const error = !raw
    ? 'project.json is missing or unreadable'
    : parsed && !parsed.ok
      ? `${parsed.reason}: ${parsed.message} ${parsed.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
      : null;
  const media: MediaFileInfo[] = (doc?.media ?? []).map((m) => {
    const file = path.join(root, m.path);
    const exists = existsSync(file);
    return {
      role: m.role,
      path: m.path,
      exists,
      durationUs: m.durationUs,
      probedUs: exists ? probeDurationUs(file) : null,
      startOffsetUs: m.startOffsetUs,
      endedEarly: m.endedEarly === true,
    };
  });
  const log = (await readJson(path.join(root, 'logs', 'recording.json'))) as {
    streams?: (StreamLogStats & { stats?: Partial<StreamLogStats> | null })[];
    notices?: { level: string; message: string }[];
  } | null;
  return {
    root,
    doc,
    error,
    media,
    log: log
      ? {
          streams: (log.streams ?? []).map((s) => ({
            kind: s.kind,
            label: s.label,
            encoder: s.encoder,
            endedEarly: s.endedEarly,
            ...(s.stats ?? {}),
          })),
          notices: log.notices ?? [],
        }
      : null,
    metrics: (await readJson(path.join(root, 'logs', 'metrics.json'))) as MetricsFile | null,
  };
}

/** R1.25-style validity: schema, state, every media file present and readable. */
export function projectChecks(p: ProjectInfo, requirement: string, state = 'complete'): Check[] {
  const checks: Check[] = [
    check(
      requirement,
      'project.json validates against schema v1',
      p.doc !== null,
      undefined,
      undefined,
      p.error ?? undefined,
    ),
  ];
  if (!p.doc) return checks;
  checks.push(
    check(
      requirement,
      `recording.state is "${state}"`,
      p.doc.recording?.state === state,
      p.doc.recording?.state ?? 'none',
    ),
  );
  const bad = p.media.filter((m) => !m.exists || m.probedUs === null || m.probedUs <= 0);
  checks.push(
    check(
      requirement,
      'every media file exists and probes',
      bad.length === 0 && p.media.length > 0,
      `${String(p.media.length - bad.length)}/${String(p.media.length)}`,
      undefined,
      bad.map((m) => m.path).join(', ') || undefined,
    ),
  );
  return checks;
}

/**
 * Dropped-frame ratios: the engine's accounting (§9.3) from the last metrics sample at or before
 * `atMs` (default: the last), else frames from `recording.json`.
 */
export function droppedRatios(
  p: ProjectInfo,
  atMs?: number,
): { screen: number | null; camera: number | null; source: string } {
  const samples = (p.metrics?.samples ?? []).filter(
    (s) => s.dropped && (atMs === undefined || s.atMs <= atMs),
  );
  const last = samples.at(-1);
  if (last?.dropped) {
    return {
      screen: last.dropped.screen,
      camera: last.dropped.camera,
      source: `metrics.json at ${(last.atMs / 60_000).toFixed(1)} min`,
    };
  }
  const ratio = (kind: string) => {
    const s = p.log?.streams.find((x) => x.kind === kind);
    if (!s) return null;
    const total = s.framesIn ?? (s.framesEncoded ?? 0) + (s.framesDropped ?? 0);
    return total > 0 ? (s.framesDropped ?? 0) / total : null;
  };
  return { screen: ratio('screen'), camera: ratio('camera'), source: 'recording.json totals' };
}

export function droppedChecks(p: ProjectInfo, requirement: string, atMs?: number): Check[] {
  const d = droppedRatios(p, atMs);
  const out: Check[] = [];
  for (const kind of ['screen', 'camera'] as const) {
    const v = d[kind];
    if (v === null) {
      if (kind === 'screen') out.push(errorCheck(requirement, 'screen dropped frames', 'no stats'));
      continue;
    }
    out.push(
      check(requirement, `${kind} dropped frames < 1 %`, v < 0.01, pct(v), '< 1 %', d.source),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sync (R1.24)

/** R1.24 verdicts from a sync report. `limitMs` is 40 at the start and 60 after 30 minutes. */
export function syncChecks(
  report: ProjectSyncReport,
  options: { label: string; limitMs: number; at?: (role: string) => number | null },
): Check[] {
  const out: Check[] = [];
  out.push(info('R1.24', `${options.label}: screen flashes found`, String(report.flashes)));
  for (const [role, name] of [
    ['system-audio', 'screen ↔ system audio'],
    ['microphone', 'screen ↔ mic'],
  ] as const) {
    const o = report.offsets[role];
    const value = options.at ? options.at(role) : (o?.summary?.medianMs ?? null);
    if (value === null) {
      out.push(
        errorCheck(
          'R1.24',
          `${options.label}: ${name}`,
          `no matched events (${String(o?.pairs.length ?? 0)} pairs)`,
        ),
      );
      continue;
    }
    out.push(
      check(
        'R1.24',
        `${options.label}: ${name}`,
        Math.abs(value) <= options.limitMs,
        ms(value, 1),
        `≤ ${String(options.limitMs)} ms`,
        o?.summary
          ? `${String(o.summary.pairs)} pairs, p10 ${ms(o.summary.p10Ms, 1)}, p90 ${ms(o.summary.p90Ms, 1)}, trend ${o.summary.trendPpm.toFixed(1)} ppm`
          : undefined,
      ),
    );
  }
  return out;
}

export function cameraMicCheck(report: ProjectSyncReport): Check {
  const cm = report.cameraMic;
  if (cm.method === 'none' || cm.medianMs === null) {
    return errorCheck(
      'R1.24',
      'camera ↔ mic',
      'the camera saw no flashes and no claps were paired (aim the camera at the screen or a mirror, or clap in view)',
    );
  }
  return check(
    'R1.24',
    `camera ↔ mic (${cm.method})`,
    Math.abs(cm.medianMs) <= 60,
    ms(cm.medianMs, 1),
    '≤ 60 ms',
    `${String(cm.pairs)} pairs${cm.method === 'clap' ? '; claps are accurate to about one camera frame' : ''}`,
  );
}
