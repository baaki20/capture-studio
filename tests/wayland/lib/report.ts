/**
 * The run report: `docs/verification/wayland-<date>-<time>[-dry-run].json` (everything,
 * machine-readable) and a Markdown summary next to it, both formatted with the project's
 * Prettier settings so `npm run lint` stays clean.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Check, Status } from './checks';
import { ROOT, type Mode } from './app';

export interface ScenarioResult {
  id: string;
  title: string;
  requirements: string[];
  humanActions: string[];
  status: Status;
  checks: Check[];
  notes: string[];
  projects: string[];
  startedAt: string;
  durationS: number;
}

export interface RunReport {
  kind: 'capture-studio-wayland-verification';
  version: 1;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  machine: Record<string, string>;
  scenarios: ScenarioResult[];
  totals: Record<Status, number>;
}

/** A scenario's overall status: any error or fail wins, then pass, then not-testable. */
export function overallStatus(checks: readonly Check[]): Status {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'pass')) return 'pass';
  if (checks.some((c) => c.status === 'not-testable')) return 'not-testable';
  return 'info';
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT }).trim();
  } catch {
    return 'unknown';
  }
}

export function machineInfo(): Record<string, string> {
  const electron = JSON.parse(
    execFileSync(process.execPath, ['-p', "JSON.stringify(require('electron/package.json'))"], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
  ) as { version: string };
  return {
    host: os.hostname(),
    kernel: os.release(),
    cpus: `${String(os.cpus().length)} × ${os.cpus()[0]?.model ?? 'unknown'}`,
    memory: `${(os.totalmem() / 1e9).toFixed(1)} GB`,
    session: process.env.XDG_SESSION_TYPE ?? 'unknown',
    desktop: process.env.XDG_CURRENT_DESKTOP ?? 'unknown',
    electron: electron.version,
    node: process.version,
    git: `${run('git', ['rev-parse', '--short', 'HEAD'])} (${run('git', ['branch', '--show-current'])}${run('git', ['status', '--porcelain']) ? ', uncommitted changes' : ''})`,
  };
}

const ICON: Record<Status, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  error: 'ERROR',
  'not-testable': 'NOT TESTABLE',
  info: 'info',
};

const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(report: RunReport): string {
  const lines: string[] = [
    `# Wayland verification run ${report.startedAt.slice(0, 16).replace('T', ' ')}${report.mode === 'dry-run' ? ' (dry run)' : ''}`,
    '',
    report.mode === 'dry-run'
      ? '> Dry run: X11 test mode with fake camera and mic and no GNOME portal. It proves the harness end to end; its numbers say nothing about Wayland capture.'
      : '> Real run on the GNOME Wayland session with a human answering the portal.',
    '',
    `Machine: ${Object.entries(report.machine)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}`,
    '',
    `Totals: ${(Object.keys(report.totals) as Status[])
      .filter((k) => report.totals[k] > 0)
      .map((k) => `${String(report.totals[k])} ${ICON[k]}`)
      .join(', ')}`,
    '',
    '| Scenario | Requirements | Result | Time |',
    '| --- | --- | --- | --- |',
    ...report.scenarios.map(
      (s) =>
        `| ${s.id} ${cell(s.title)} | ${s.requirements.join(', ')} | ${ICON[s.status]} | ${s.durationS.toFixed(0)} s |`,
    ),
  ];
  for (const s of report.scenarios) {
    lines.push('', `## ${s.id}: ${s.title} — ${ICON[s.status]}`, '');
    if (s.humanActions.length) lines.push(`Human actions: ${s.humanActions.join('; ')}.`, '');
    lines.push('| Requirement | Check | Result | Value | Limit | Detail |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of s.checks) {
      lines.push(
        `| ${c.requirement} | ${cell(c.name)} | ${ICON[c.status]} | ${cell(c.value)} | ${cell(c.limit)} | ${cell(c.detail)} |`,
      );
    }
    if (s.notes.length) lines.push('', ...s.notes.map((n) => `- ${n}`));
    if (s.projects.length) lines.push('', ...s.projects.map((p) => `Project: \`${p}\``));
  }
  return `${lines.join('\n')}\n`;
}

async function formatted(text: string, file: string): Promise<string> {
  try {
    const prettier = await import('prettier');
    const config = (await prettier.resolveConfig(file)) ?? {};
    return await prettier.format(text, { ...config, filepath: file });
  } catch {
    return text;
  }
}

/** Writes the JSON and Markdown reports; returns their paths. */
export async function writeReport(
  report: RunReport,
  dir = path.join(ROOT, 'docs', 'verification'),
) {
  await fs.mkdir(dir, { recursive: true });
  const stamp = report.startedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const base = path.join(dir, `wayland-${stamp}${report.mode === 'dry-run' ? '-dry-run' : ''}`);
  const json = `${base}.json`;
  const md = `${base}.md`;
  await fs.writeFile(json, await formatted(`${JSON.stringify(report, null, 2)}\n`, json));
  await fs.writeFile(md, await formatted(toMarkdown(report), md));
  return { json, md };
}

export function totals(scenarios: readonly ScenarioResult[]): Record<Status, number> {
  const t: Record<Status, number> = { pass: 0, fail: 0, error: 0, 'not-testable': 0, info: 0 };
  for (const s of scenarios) t[s.status] += 1;
  return t;
}
