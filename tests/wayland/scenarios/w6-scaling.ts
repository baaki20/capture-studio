/**
 * W6: fractional scaling and two monitors with different scales; a region on the second
 * monitor must be pixel-exact in the export. The pattern draws 1-px lines every 16 device
 * pixels on that monitor; the export (canvas resolution) must show them exactly where the
 * recorded region says, column by column and row by row. With a single output this is
 * reported as not testable.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BIN_DIR } from '../lib/app';
import { check, errorCheck, info, inspectProject, notTestable, projectChecks } from '../lib/checks';
import { Pattern } from '../lib/pattern';
import {
  configure,
  exportProject,
  recordFor,
  startRecording,
  stopAndFinalize,
  type Scenario,
} from '../lib/scenario';

interface Display {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  primary: boolean;
}

/** Fraction of expected grid lines that stand out of their neighbours in a luma profile. */
export function gridHits(profile: readonly number[], expected: (i: number) => boolean): number {
  let lines = 0;
  let hits = 0;
  for (let i = 1; i < profile.length - 1; i++) {
    if (!expected(i)) continue;
    lines++;
    const v = profile[i] ?? 0;
    if (v > Math.max(profile[i - 1] ?? 0, profile[i + 1] ?? 0) + 20) hits++;
  }
  return lines ? hits / lines : 0;
}

export const w6: Scenario = {
  id: 'W6',
  title: 'Fractional scaling, two monitors, region on monitor 2',
  requirements: ['R1.9', 'R1.53'],
  humanActions: ['set monitor 2 to 125 % (if not already)', '1 portal click: pick monitor 2'],
  async run(ctx, out) {
    const app = await ctx.launch();
    let pattern: Pattern | null = null;
    try {
      let displays = await app.call<Display[]>('displays');
      out.checks.push(
        info(
          'W6',
          'outputs',
          displays
            .map(
              // Generic names: monitor makes and models must not reach the report.
              (d, i) =>
                `display ${String(i + 1)}${d.primary ? ' (primary)' : ''} ${String(d.bounds.width)}×${String(d.bounds.height)} @${String(d.scaleFactor)}`,
            )
            .join('; '),
        ),
      );
      if (displays.length < 2) {
        out.checks.push(
          notTestable(
            'R1.9',
            'region on a second monitor with a different scale',
            'only one output is connected',
          ),
        );
        return;
      }
      if (new Set(displays.map((d) => d.scaleFactor)).size < 2) {
        ctx.human.instruct('W6 — scaling', [
          'Open Settings → Displays, turn on Fractional Scaling, and set the second monitor to 125 % (the first stays at 100 %).',
          'Apply, then come back here.',
        ]);
        await ctx.human.enter();
        displays = await app.call<Display[]>('displays');
      }
      const index = displays.findIndex((d) => !d.primary);
      const target = displays[index];
      if (!target) throw new Error('no secondary display');
      out.checks.push(
        check(
          'W6',
          'monitors have different scales',
          new Set(displays.map((d) => d.scaleFactor)).size > 1,
          displays.map((d) => String(d.scaleFactor)).join(' / '),
        ),
      );
      await configure(ctx, app, {
        captureMode: 'region',
        cameraId: null,
        micId: null,
        systemAudio: false,
      });
      pattern = await Pattern.start({ mode: ctx.mode, display: index, grid: true });
      // A native Wayland window cannot pick its monitor (`--display` only works on X11), so the
      // grid may open on the other screen; the human moves it before sharing.
      if (ctx.mode === 'real') {
        ctx.human.instruct('W6 — put the grid on the second monitor', [
          `The grid (thin lines on black) must fill the ${target.label || 'second'} monitor (${String(target.bounds.width)}×${String(target.bounds.height)} @${String(target.scaleFactor)}).`,
          'If it opened on the other screen, click it and press Super+Shift+→ (or ←) to move it there.',
          'Then click this terminal and press Enter.',
        ]);
        await ctx.human.enter();
      }
      const { root } = await startRecording(ctx, app, {
        region: { from: [0.3, 0.3], to: [0.7, 0.7] },
        portalSteps: [
          `In the "Share Screen" dialog choose the SECOND monitor (${target.label || 'the one showing the grid'}).`,
          'Click "Share". The harness draws the region and presses Enter.',
        ],
      });
      out.projects.push(root);
      await recordFor('W6 recording the grid', 5_000);
      await pattern.close();
      pattern = null;
      const stopped = await stopAndFinalize(app);
      const project = await inspectProject(stopped.root);
      out.checks.push(...projectChecks(project, 'R1.9'));
      const region = project.doc?.recording?.source.region;
      const canvas = project.doc?.timeline.canvas;
      if (!region || !canvas) {
        out.checks.push(errorCheck('R1.9', 'region recorded', 'no region in project.json'));
        return;
      }
      out.checks.push(
        info(
          'R1.9',
          'region (source px)',
          `${String(region.width)}×${String(region.height)} at ${String(region.x)},${String(region.y)}`,
        ),
      );
      out.checks.push(
        check(
          'R1.9',
          'canvas equals the region (no rescale)',
          canvas.width === region.width && canvas.height === region.height,
          `${String(canvas.width)}×${String(canvas.height)}`,
        ),
      );
      const exported = await exportProject(ctx, stopped.root, 'high');
      const frame = execFileSync(
        path.join(BIN_DIR, 'ffmpeg'),
        [
          '-v',
          'error',
          '-ss',
          '2',
          '-i',
          exported.output,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          '-',
        ],
        { maxBuffer: 1 << 28 },
      );
      const { width, height } = canvas;
      const cols = new Array<number>(width).fill(0);
      const rows = new Array<number>(height).fill(0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = frame[y * width + x] ?? 0;
          cols[x] = (cols[x] ?? 0) + v / height;
          rows[y] = (rows[y] ?? 0) + v / width;
        }
      }
      const colHits = gridHits(cols, (x) => (region.x + x) % 16 === 0);
      const rowHits = gridHits(rows, (y) => (region.y + y) % 16 === 0);
      out.checks.push(
        check(
          'R1.9',
          'vertical grid lines at the exact columns',
          colHits >= 0.9,
          `${(colHits * 100).toFixed(0)} %`,
          '≥ 90 %',
        ),
      );
      out.checks.push(
        check(
          'R1.9',
          'horizontal grid lines at the exact rows',
          rowHits >= 0.9,
          `${(rowHits * 100).toFixed(0)} %`,
          '≥ 90 %',
        ),
      );
    } finally {
      await pattern?.close();
      await app.quit();
    }
  },
};
