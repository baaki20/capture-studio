/**
 * Sync analyzer (§4.5 step 20, R1.24) on the command line. Finds the flash/beep events of
 * tests/sync/pattern in each stream of a recorded project (see `analysis.ts`), maps them onto the
 * session clock with the project's own media mapping, and reports each stream's offset from the
 * screen, how that offset changes over the recording (residual drift, and per window), and the
 * camera ↔ mic offset (from the flashes, or from hand claps in `--clap`).
 *
 * Run: npx tsx tests/sync/analyze.ts "<project>.cstudio" [--clap <from>-<to>] [--window <s>]
 *        [--export <file.mp4>] [--json]
 */
import { analyzeExport, analyzeProject, type OffsetSummary } from './analysis';

function parseArgs(argv: readonly string[]) {
  const options: {
    root: string | null;
    clap?: [number, number];
    windowS?: number;
    exportFile?: string;
    json: boolean;
  } = { root: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--json') options.json = true;
    else if (arg === '--clap') {
      const [a, b] = (argv[++i] ?? '').split('-').map(Number);
      if (a === undefined || b === undefined || !(b > a)) throw new Error('--clap <from>-<to>');
      options.clap = [a, b];
    } else if (arg === '--window') options.windowS = Number(argv[++i]);
    else if (arg === '--export') options.exportFile = argv[++i];
    else options.root = arg;
  }
  return options;
}

const f = (v: number | null | undefined, width = 7) =>
  (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(1)).padStart(width);

function row(role: string, s: OffsetSummary | null, pairs: number): string {
  if (!s) return `${role.padEnd(13)} ${String(pairs).padStart(5)}  (not enough matched events)`;
  return `${role.padEnd(13)} ${String(s.pairs).padStart(5)} ${f(s.medianMs)}${f(s.p10Ms)}${f(s.p90Ms)}${f(s.firstMs)}${f(s.lastMs)}${f(s.trendPpm)}`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.exportFile && !options.root) {
    const result = analyzeExport(options.exportFile);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else
      console.log(
        `export: ${String(result.flashes)} flashes, ${String(result.beeps)} beeps\n` +
          row('audio mix', result.summary, result.pairs.length),
      );
    return;
  }
  if (!options.root) {
    throw new Error('usage: tsx tests/sync/analyze.ts <project>.cstudio [--clap a-b] [--json]');
  }
  const report = analyzeProject(options.root, {
    ...(options.clap ? { clapWindow: options.clap } : {}),
    ...(options.windowS ? { windowS: options.windowS } : {}),
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const s of report.streams) {
    const ratio = s.clockRatioPpm === 0 ? '' : ` (clockRatio ${s.clockRatioPpm.toFixed(1)} ppm)`;
    console.log(`${s.role.padEnd(13)} ${String(s.events.length).padStart(4)} events${ratio}`);
  }
  if (report.flashes < 5) throw new Error('fewer than 5 flashes found on the screen track');
  console.log(
    `\noffset from screen (ms; positive = later than the flash); ${String(report.flashes)} flashes over ${report.spanS.toFixed(0)} s`,
  );
  console.log('stream         pairs  median    p10    p90   first⅓  last⅓  trend ppm');
  for (const [role, o] of Object.entries(report.offsets)) {
    console.log(row(role, o.summary, o.pairs.length));
  }
  console.log(
    `\ncamera ↔ mic: ${f(report.cameraMic.medianMs, 0)} ms (${report.cameraMic.method}, ${String(report.cameraMic.pairs)} pairs)`,
  );
  if (report.clap) {
    console.log(
      `claps: ${String(report.clap.claps)} heard, ${String(report.clap.pairs.length)} seen`,
    );
  }
  for (const [role, windows] of Object.entries(report.windows)) {
    if (windows.length < 3) continue;
    console.log(
      `\n${role} per ${String(windows[0] ? windows[0].endS - windows[0].startS : 0)} s: ` +
        windows.map((w) => f(w.medianMs, 0)).join(' '),
    );
  }
}

main();
