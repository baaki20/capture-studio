/**
 * R1.20 on this machine without a human: finalizing a synthetic 10-minute recording (shaped like
 * the recorder's output) must take at most 10 s. See `lib/finalize-bench.ts` for what is timed.
 * The fixture lives under the run folder, on the same disk as real projects.
 */
import path from 'node:path';
import { BIN_DIR } from '../lib/app';
import { check, info } from '../lib/checks';
import { benchFinalize } from '../lib/finalize-bench';
import type { Scenario } from '../lib/scenario';

export const finalize: Scenario = {
  id: 'R1.20',
  title: 'Finalize a 10-minute recording within 10 s',
  requirements: ['R1.20'],
  humanActions: [],
  async run(ctx, out) {
    const minutes = ctx.quick ? 1 : 10;
    ctx.log(`R1.20: building a ${String(minutes)}-minute recording and finalizing it…`);
    const result = await benchFinalize({
      ffmpeg: path.join(BIN_DIR, 'ffmpeg'),
      ffprobe: path.join(BIN_DIR, 'ffprobe'),
      minutes,
      workDir: path.join(ctx.runDir, 'finalize-bench'),
    });
    out.checks.push(
      check(
        'R1.20',
        `finalize a ${String(minutes)}-minute recording`,
        // The project is ready (and the editor opens) after remux + drift; peaks and thumbnails
        // follow in the background (R1.44).
        result.finalizeMs + result.driftMs <= 10_000,
        `${((result.finalizeMs + result.driftMs) / 1000).toFixed(1)} s`,
        '≤ 10 s',
        `remux ${(result.finalizeMs / 1000).toFixed(1)} s + drift ${String(result.driftMs)} ms + peaks/thumbnails ${(result.cachesMs / 1000).toFixed(1)} s; ${(result.bytes / 1e6).toFixed(0)} MB`,
      ),
    );
    for (const [job, jobMs] of Object.entries(result.jobs)) {
      out.checks.push(info('R1.20', job, `${(jobMs / 1000).toFixed(1)} s`));
    }
    for (const s of result.streams) {
      out.checks.push(
        check('R1.20', `${s.kind} finalized`, s.ok, s.ok ? 'ok' : (s.error ?? 'failed')),
      );
    }
    if (ctx.quick) out.notes.push('Quick run: 1 minute instead of 10.');
  },
};
