/**
 * Export graph builder (§4.3.9): turns a project snapshot and export settings into an FFmpeg
 * command line and a filter script. It is pure and deterministic (golden-file tests), and it
 * reads all geometry and timing from `render-plan.ts` (`videoTrackPlans`, `audioSegments`), so
 * the export shows what the preview shows (R1.48).
 *
 * The graph, all at the export frame rate F:
 * 1. Inputs: one `-i` per referenced media file, then one more per out-of-order run of its clips
 *    (below), then one `-i` per mask PNG (a single picture, repeated in the graph; see below).
 * 2. Every video input is made constant-rate once (`fps=F:start_time=0`, so frame k is the file
 *    picture at k/F) and split when several pieces use it. Per visible video track, the plan's
 *    pieces become `trim → setpts → tpad → trim=end_frame → crop → scale → (hflip) → (BT.709
 *    conversion) → yuva420p` (clips) or transparent `color` sources (gaps), joined with `concat`.
 *    Pieces are counted in whole frames (`round(t × F)` at both ends), so every track has exactly
 *    the timeline's frame count and no piece can shift the ones after it; `tpad` covers a media
 *    file that ends a frame early.
 * 3. Masks: a rounded or circle overlay multiplies the track's alpha by the mask PNG
 *    (`alphaextract`, `blend=multiply`, `alphamerge`), so gaps stay transparent.
 * 4. Composition on a background of the canvas size: one `overlay … eof_action=pass` per track,
 *    bottom to top; then scaling to the export size if it differs, `format=yuv420p` and
 *    `setparams` with BT.709 tags.
 *
 * Departure from the letter of §4.3.9 (same output, about 2.5× faster): pieces are alpha YUV
 * (`yuva420p`), not `rgba`, and composition happens in YUV. Each source is converted to BT.709
 * once with `colorspace … fast=1` (matrix and range, as the RGB round trip did), using the
 * colour tags the export job probed. When the bottom stream is an opaque full-canvas rectangle
 * (the screen track when canvas = region), it is the base itself and its gaps are the
 * background colour, which saves a full-frame blend; otherwise the base is a background `color`
 * frame converted once and looped.
 *
 * Mask PNGs are read as one picture and repeated with the `loop` filter instead of the
 * `-loop 1` image demuxer of §4.3.9 step 1: with the demuxer looping, FFmpeg n9.0.2 hung in about
 * 1–2 % of runs (stress test of the masked-overlay graph); with the in-graph loop, 0 of 864.
 * 5. Audio per clip: `atrim → asetpts → (asetrate + aresample when |ratio − 1| ≥ 20 ppm) →
 *    stereo → volume → adelay`, then `amix normalize=0`, `alimiter`, `aresample`, `apad`. The
 *    output length is set with `-t D`.
 * 6. Encoding: libx264 (preset and CRF from the quality), or a verified hardware encoder with
 *    equivalent settings; AAC-LC 192 kbps 48 kHz stereo, `+faststart`.
 *
 * A track whose clips do not all share one geometry (possible once media of different sizes
 * share a track) is split into one stream per geometry, each with gaps where the others are.
 *
 * Out-of-order clips (departure from §4.3.9 step 1, "one `-i` per media"): pieces of one decoded
 * input are consumed in timeline order, so when a clip uses an earlier part of the file than a
 * clip before it (moved earlier), or two clips of one file play at once, `split` has to keep
 * every decoded frame of the waiting piece until its turn: a 640×360 two-minute file with its
 * halves swapped peaked at 850 MB. The pieces (and audio clips) of each media are therefore
 * grouped into runs that play in file order without overlapping in time; the first run uses the
 * media's own input as before, every further run gets its own input of the same file, opened at
 * the keyframe before X, a second before the run on the frame grid (`-noaccurate_seek -ss X`:
 * frames between that keyframe and X are kept, so a variable-rate picture held across X is
 * still there), with its timestamps put back (`setpts=PTS+X/TB`). It decodes only from there
 * and picks exactly the frames the single input would have; FFmpeg stops reading an input once
 * its pieces have ended. In-order projects keep one input per media.
 */
import path from 'node:path';
import { exportSize, QUALITY_SETTINGS, type ExportQuality } from '../../../shared/export/presets';
import type { ExportOptions } from '../../../shared/ipc/contract';
import {
  audioSegments,
  maskRadius,
  videoTrackPlans,
  type AudioSegment,
  type LayerMask,
  type PixelRect,
  type SegmentLayer,
} from '../../../shared/project/render-plan';
import type { Media, NRect, ProjectV1 } from '../../../shared/project/schema';
import { timelineDurationUs } from '../../../shared/project/timeline-ops';
import { err, ok, type Result } from '../../../shared/result';

export { exportSize, QUALITY_SETTINGS, type ExportQuality } from '../../../shared/export/presets';

/** H.264 encoders the exporter knows how to drive. */
export const EXPORT_VIDEO_ENCODERS = ['libx264', 'h264_vaapi', 'h264_nvenc', 'h264_qsv'] as const;
export type ExportVideoEncoder = (typeof EXPORT_VIDEO_ENCODERS)[number];

export function isExportVideoEncoder(name: string): name is ExportVideoEncoder {
  return (EXPORT_VIDEO_ENCODERS as readonly string[]).includes(name);
}

/** Clock ratios closer to 1 than this are treated as exactly 1 (no resampling). */
export const RATIO_TOLERANCE = 20e-6;

/** VA-API render node used when the probe verified `h264_vaapi`. */
export const VAAPI_DEVICE = '/dev/dri/renderD128';

export const EXPORT_SAMPLE_RATE = 48_000;
export const EXPORT_AUDIO_BITRATE = '192k';

export interface ExportSettings {
  /** Output size, even. */
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  encoder: ExportVideoEncoder;
}

/**
 * Resolves dialog options to concrete settings. `hardwareEncoder` is the probe-verified hardware
 * encoder (or null); it is used only with `encoder: 'auto'` and only if the exporter can drive it.
 */
export function resolveExportSettings(
  doc: ProjectV1,
  options: ExportOptions,
  hardwareEncoder: string | null,
): ExportSettings {
  const size = exportSize(doc.timeline.canvas, options.resolution);
  const hardware =
    options.encoder === 'auto' && hardwareEncoder && isExportVideoEncoder(hardwareEncoder)
      ? hardwareEncoder
      : null;
  return {
    ...size,
    fps: options.fps === 'project' ? doc.timeline.frameRate : options.fps,
    quality: options.quality,
    encoder: hardware ?? 'libx264',
  };
}

export interface ExportInput {
  /** Index of the `-i`. */
  index: number;
  kind: 'media' | 'mask';
  path: string;
  /** Media id, for `kind: 'media'`. */
  mediaId: string | null;
  /** For a further run of out-of-order clips: where reading starts (a keyframe before it). */
  seek: { startUs: number } | null;
}

/** File-time overlap tolerated within a run (a few frames buffered at most). */
const RUN_OVERLAP_US = 100_000;
/** A further run's input starts this much before its first clip (decoder warm-up). */
const RUN_LEAD_US = 1_000_000;

/** One use of a media file: when it plays on the timeline and which part of the file it reads. */
interface MediaUse {
  startUs: number;
  endUs: number;
  fileStartUs: number;
  fileEndUs: number;
}

/**
 * Groups the uses of one media file into runs that a single decoder serves without buffering:
 * within a run, uses do not overlap on the timeline and read the file forwards. First fit, in
 * timeline order (ties in the given order), so the result is deterministic. Returns the run
 * index of each use.
 */
export function mediaRuns(uses: readonly MediaUse[]): number[] {
  const order = uses
    .map((_, i) => i)
    .sort((a, b) => (uses[a]?.startUs ?? 0) - (uses[b]?.startUs ?? 0) || a - b);
  const runs: { endUs: number; fileEndUs: number }[] = [];
  const runOf = new Array<number>(uses.length).fill(0);
  for (const i of order) {
    const use = uses[i];
    if (!use) continue;
    let run = runs.findIndex(
      (r) => use.startUs >= r.endUs && use.fileStartUs >= r.fileEndUs - RUN_OVERLAP_US,
    );
    if (run < 0) {
      run = runs.length;
      runs.push({ endUs: use.endUs, fileEndUs: use.fileEndUs });
    } else {
      const r = runs[run];
      if (r) {
        r.endUs = use.endUs;
        r.fileEndUs = Math.max(r.fileEndUs, use.fileEndUs);
      }
    }
    runOf[i] = run;
  }
  return runOf;
}

export interface MaskSpec {
  /** Where the job must write the PNG before running FFmpeg. */
  path: string;
  inputIndex: number;
  width: number;
  height: number;
  mask: LayerMask;
}

export interface ExportGraph {
  /** Arguments after the runner's global options; the filter script path is already in them. */
  args: string[];
  filterScriptText: string;
  inputs: ExportInput[];
  masks: MaskSpec[];
  expectedDurationUs: number;
  settings: ExportSettings;
}

export interface ExportGraphError {
  code: 'empty' | 'offline' | 'unknown-media';
  message: string;
}

export interface BuildExportGraphOptions {
  doc: ProjectV1;
  /** The project folder; media paths in the document are relative to it. */
  projectRoot: string;
  settings: ExportSettings;
  outputPath: string;
  /** Where the job writes the filter script. */
  filterScriptPath: string;
  /** Where the job writes mask PNGs (`mask-<n>.png`). */
  maskDir: string;
  /** Probed colour properties of video media; missing entries are taken as BT.709. */
  mediaColor?: ReadonlyMap<string, MediaColor>;
}

/** A video file's colour tags as ffprobe reports them (`color_space`, `color_range`). */
export interface MediaColor {
  matrix: string | null;
  range: string | null;
}

/** `colorspace` input names for ffprobe matrix names (matrix-only conversion, `fast=1`). */
const COLORSPACE_INPUT: Record<string, string> = {
  smpte170m: 'bt601-6-525',
  bt470bg: 'bt601-6-625',
  smpte240m: 'smpte240m',
  bt2020nc: 'bt2020',
  bt2020c: 'bt2020',
};

/**
 * The filter that converts a source to BT.709 limited range, or null when it already is (or
 * is untagged, which is treated as BT.709). WebCodecs recordings are tagged BT.601 (smpte170m).
 */
export function toBt709(color: MediaColor | undefined): string | null {
  const input = color?.matrix ? COLORSPACE_INPUT[color.matrix] : undefined;
  const fullRange = color?.range === 'pc';
  if (!input && !fullRange) return null;
  return `colorspace=all=bt709:iall=${input ?? 'bt709'}:irange=${fullRange ? 'pc' : 'tv'}:range=tv:fast=1`;
}

/** The `color` source draws BT.601 limited-range values; this converts them to BT.709. */
const COLOR_SOURCE_TO_BT709 = 'colorspace=all=bt709:iall=bt601-6-525:irange=tv:range=tv:fast=1';

// ---------------------------------------------------------------------------------------------
// Number formatting (fixed, so the script text is deterministic)

/** Integer µs → seconds with 6 decimals. */
function sec(us: number): string {
  return (us / 1_000_000).toFixed(6);
}

/** Seconds (any float) → 6 decimals. */
function secF(seconds: number): string {
  return seconds.toFixed(6);
}

/** Frame index of a timeline time: frame boundaries at `round(t × F)`. */
function frameAt(us: number, fps: number): number {
  return Math.round((us * fps) / 1_000_000);
}

/**
 * Duration for a `color` source that must yield exactly `frames` frames at `fps`: the source
 * emits frames while `pts < d`, so `d` is `frames / fps` rounded down to 6 decimals.
 */
function framesDuration(frames: number, fps: number): string {
  return (Math.floor((frames / fps) * 1_000_000) / 1_000_000).toFixed(6);
}

function ffColor(hex: string): string {
  return `0x${hex.slice(1, 7).toUpperCase()}`;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}

// ---------------------------------------------------------------------------------------------
// Graph assembly

interface Geometry {
  sourceRect: NRect;
  destRect: PixelRect;
  mask: LayerMask;
  mirror: boolean;
}

function geometryKey(g: Geometry): string {
  const s = g.sourceRect;
  const d = g.destRect;
  return [s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height, g.mask.shape]
    .concat([g.mask.radiusPx, g.mirror ? 1 : 0])
    .join(',');
}

function needsMask(g: Geometry): boolean {
  return (
    g.mask.shape !== 'rectangle' && maskRadius(g.mask, g.destRect.width, g.destRect.height) > 0
  );
}

/** Piece of a per-geometry stream, in frames. */
type FramePiece =
  { kind: 'gap'; frames: number } | { kind: 'clip'; frames: number; layer: SegmentLayer };

interface TrackStream {
  geometry: Geometry;
  pieces: FramePiece[];
}

/** Splits a track plan into one stream per distinct geometry (normally exactly one). */
function trackStreams(
  pieces: ReturnType<typeof videoTrackPlans>[number]['pieces'],
  fps: number,
): TrackStream[] {
  const keys: string[] = [];
  const geometries = new Map<string, Geometry>();
  for (const piece of pieces) {
    if (piece.kind !== 'clip') continue;
    const key = geometryKey(piece.layer);
    if (!geometries.has(key)) {
      keys.push(key);
      geometries.set(key, piece.layer);
    }
  }
  return keys.map((key) => {
    const out: FramePiece[] = [];
    const pushGap = (frames: number): void => {
      if (frames <= 0) return;
      const last = out[out.length - 1];
      if (last?.kind === 'gap') last.frames += frames;
      else out.push({ kind: 'gap', frames });
    };
    for (const piece of pieces) {
      const frames = frameAt(piece.endUs, fps) - frameAt(piece.startUs, fps);
      if (frames <= 0) continue;
      if (piece.kind === 'clip' && geometryKey(piece.layer) === key) {
        out.push({ kind: 'clip', frames, layer: piece.layer });
      } else {
        pushGap(frames);
      }
    }
    const geometry = geometries.get(key);
    if (!geometry) throw new Error('unreachable: geometry without key');
    return { geometry, pieces: out };
  });
}

class Labels {
  private n = 0;
  next(prefix: string): string {
    return `${prefix}${String(this.n++)}`;
  }
}

function audioChain(segment: AudioSegment, media: Media): string[] {
  const filters = [
    `atrim=start=${secF(segment.fileStartSeconds)}:end=${secF(segment.fileEndSeconds)}`,
    'asetpts=PTS-STARTPTS',
  ];
  if (Math.abs(segment.clockRatio - 1) >= RATIO_TOLERANCE) {
    const inputRate = media.audio?.sampleRate ?? EXPORT_SAMPLE_RATE;
    filters.push(
      `asetrate=${trimNumber(inputRate / segment.clockRatio)}`,
      `aresample=${String(EXPORT_SAMPLE_RATE)}`,
    );
  }
  // Mono plays on both channels at full level, as Web Audio up-mixes it in the preview.
  filters.push(
    (media.audio?.channels ?? 2) === 1
      ? 'pan=stereo|c0=c0|c1=c0'
      : 'aformat=channel_layouts=stereo',
  );
  filters.push(`volume=${trimNumber(segment.gainDb)}dB`);
  const delaySamples = Math.round((segment.timelineStartUs * EXPORT_SAMPLE_RATE) / 1_000_000);
  filters.push(`adelay=delays=${String(delaySamples)}S:all=1`);
  return filters;
}

function videoEncoderArgs(settings: ExportSettings): string[] {
  const q = QUALITY_SETTINGS[settings.quality];
  switch (settings.encoder) {
    case 'libx264':
      return [
        '-c:v',
        'libx264',
        '-preset',
        q.preset,
        '-crf',
        String(q.crf),
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
      ];
    case 'h264_vaapi':
      return ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', String(q.crf), '-profile:v', 'high'];
    case 'h264_nvenc': {
      const preset = { draft: 'p2', standard: 'p5', high: 'p7' }[settings.quality];
      return [
        '-c:v',
        'h264_nvenc',
        '-preset',
        preset,
        '-rc',
        'vbr',
        '-cq',
        String(q.crf),
        '-b:v',
        '0',
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
      ];
    }
    case 'h264_qsv':
      return [
        '-c:v',
        'h264_qsv',
        '-preset',
        q.preset,
        '-global_quality',
        String(q.crf),
        '-profile:v',
        'high',
        '-pix_fmt',
        'nv12',
      ];
  }
}

/**
 * Builds the command line and filter script. Fails when the timeline is empty, or when a clip
 * that would be exported refers to offline media (R1.29) or to a media id the project lacks.
 */
export function buildExportGraph(
  options: BuildExportGraphOptions,
): Result<ExportGraph, ExportGraphError> {
  const { doc, settings } = options;
  const F = settings.fps;
  const durationUs = timelineDurationUs(doc);
  if (durationUs <= 0) return err({ code: 'empty', message: 'The timeline is empty.' });
  const totalFrames = frameAt(durationUs, F);
  const mediaById = new Map(doc.media.map((m) => [m.id, m]));

  const plans = videoTrackPlans(doc);
  const audio = audioSegments(doc);

  // Offline and unknown media (R1.29).
  const offline = new Set<string>();
  for (const plan of plans) {
    for (const piece of plan.pieces) {
      if (piece.kind === 'clip' && piece.layer.offline) offline.add(piece.layer.mediaId);
    }
  }
  for (const segment of audio) {
    if (!mediaById.has(segment.mediaId)) {
      return err({ code: 'unknown-media', message: `Unknown media ${segment.mediaId}.` });
    }
    if (segment.offline) offline.add(segment.mediaId);
  }
  if (offline.size > 0) {
    const names = [...offline].map((id) => mediaById.get(id)?.path ?? id).join(', ');
    return err({
      code: 'offline',
      message: `Media is missing or unreadable: ${names}. Relink it or remove its clips before exporting.`,
    });
  }

  const streams = plans.map((plan) => ({ plan, streams: trackStreams(plan.pieces, F) }));
  const allStreams = streams.flatMap((s) => s.streams);

  // Uses of each media, in the order the graph consumes them, then grouped into runs that one
  // decoder serves without buffering (see the header). A source is one run of one media's video
  // or audio: `<mediaId>#v<run>` / `<mediaId>#a<run>`.
  const videoUses = new Map<string, { piece: FramePiece; use: MediaUse }[]>();
  for (const stream of allStreams) {
    let frame = 0;
    for (const piece of stream.pieces) {
      const from = frame;
      frame += piece.frames;
      if (piece.kind !== 'clip') continue;
      const list = videoUses.get(piece.layer.mediaId) ?? [];
      list.push({
        piece,
        use: {
          startUs: (from * 1_000_000) / F,
          endUs: (frame * 1_000_000) / F,
          fileStartUs: piece.layer.fileStartUs,
          fileEndUs: piece.layer.fileEndUs,
        },
      });
      videoUses.set(piece.layer.mediaId, list);
    }
  }
  const audioUses = new Map<string, { segment: AudioSegment; use: MediaUse }[]>();
  for (const segment of audio) {
    const list = audioUses.get(segment.mediaId) ?? [];
    list.push({
      segment,
      use: {
        startUs: segment.timelineStartUs,
        endUs: segment.timelineEndUs,
        fileStartUs: segment.fileStartUs,
        fileEndUs: segment.fileEndUs,
      },
    });
    audioUses.set(segment.mediaId, list);
  }

  interface Source {
    key: string;
    mediaId: string;
    kind: 'v' | 'a';
    run: number;
    uses: MediaUse[];
  }
  /** Sources in order of first use; per kind, the source of each piece or segment. */
  const sources = new Map<string, Source>();
  const sourceOf = new Map<FramePiece | AudioSegment, string>();
  const addRuns = (
    kind: 'v' | 'a',
    mediaId: string,
    list: { item: FramePiece | AudioSegment; use: MediaUse }[],
  ): void => {
    const runs = mediaRuns(list.map((u) => u.use));
    list.forEach(({ item, use }, i) => {
      const run = runs[i] ?? 0;
      const key = `${mediaId}#${kind}${String(run)}`;
      const source = sources.get(key) ?? { key, mediaId, kind, run, uses: [] };
      source.uses.push(use);
      sources.set(key, source);
      sourceOf.set(item, key);
    });
  };
  for (const [mediaId, list] of videoUses) {
    addRuns(
      'v',
      mediaId,
      list.map(({ piece, use }) => ({ item: piece, use })),
    );
  }
  for (const [mediaId, list] of audioUses) {
    addRuns(
      'a',
      mediaId,
      list.map(({ segment, use }) => ({ item: segment, use })),
    );
  }

  // Inputs: media in document order, each once; then further runs (document order, video
  // before audio, run order), each opened at a keyframe before its first clip.
  const inputs: ExportInput[] = [];
  const inputIndex = new Map<string, number>();
  for (const media of doc.media) {
    if (!videoUses.has(media.id) && !audioUses.has(media.id)) continue;
    const index = inputs.length;
    inputIndex.set(media.id, index);
    inputs.push({
      index,
      kind: 'media',
      path: path.join(options.projectRoot, media.path),
      mediaId: media.id,
      seek: null,
    });
  }
  /**
   * Where a further run's input starts, in µs: on the frame grid for video, on a whole second for
   * audio (a whole number of samples at any rate), so putting the timestamps back is exact.
   */
  const seekStartUs = (source: Source): number => {
    const first = Math.max(0, Math.min(...source.uses.map((u) => u.fileStartUs)) - RUN_LEAD_US);
    return source.kind === 'v'
      ? (Math.floor((first * F) / 1_000_000) * 1_000_000) / F
      : Math.floor(first / 1_000_000) * 1_000_000;
  };
  const sourceInput = new Map<string, number>();
  const extraSources = [...sources.values()]
    .filter((source) => source.run > 0)
    .sort((x, y) => {
      const docOrder = (id: string) => doc.media.findIndex((m) => m.id === id);
      return (
        docOrder(x.mediaId) - docOrder(y.mediaId) ||
        (x.kind === y.kind ? 0 : x.kind === 'v' ? -1 : 1) ||
        x.run - y.run
      );
    });
  for (const source of sources.values()) {
    if (source.run === 0) sourceInput.set(source.key, inputIndex.get(source.mediaId) ?? 0);
  }
  for (const source of extraSources) {
    const media = mediaById.get(source.mediaId);
    if (!media) throw new Error(`unreachable: unknown media ${source.mediaId}`);
    const index = inputs.length;
    sourceInput.set(source.key, index);
    inputs.push({
      index,
      kind: 'media',
      path: path.join(options.projectRoot, media.path),
      mediaId: media.id,
      seek: { startUs: seekStartUs(source) },
    });
  }

  const mediaInputs = inputs.length;
  const lines: string[] = [];
  const labels = new Labels();

  // Video sources: constant rate, split per use. A further run puts its timestamps back to the
  // file's (its input was opened at `X`) and starts the frame grid there.
  const videoSources = new Map<string, string[]>();
  for (const source of sources.values()) {
    if (source.kind !== 'v') continue;
    const index = sourceInput.get(source.key) ?? 0;
    const uses = source.uses.length;
    const outs = Array.from({ length: uses }, () => labels.next('v'));
    const split = uses > 1 ? `,split=${String(uses)}` : '';
    const seek = inputs[index]?.seek;
    const head = seek
      ? `setpts=PTS+${sec(seek.startUs)}/TB,fps=${String(F)}:start_time=${sec(seek.startUs)}`
      : `fps=${String(F)}:start_time=0`;
    lines.push(`[${String(index)}:v:0]${head}${split}${outs.map((l) => `[${l}]`).join('')};`);
    videoSources.set(source.key, outs);
  }
  const takeVideo = (piece: FramePiece): string => {
    const key = sourceOf.get(piece) ?? '';
    const label = videoSources.get(key)?.shift();
    if (!label) throw new Error(`unreachable: no source label for ${key}`);
    return label;
  };

  // Tracks. The bottom stream is the base when it is an opaque rectangle covering the whole
  // canvas (the usual screen track): its gaps show the background colour and nothing has to
  // be blended under it. Otherwise a background-colour base is created and every stream is
  // overlaid on it.
  const { canvas } = doc.timeline;
  const canvasSize = `${String(canvas.width)}x${String(canvas.height)}`;
  const background = ffColor(canvas.background.color);
  const first = allStreams[0];
  const baseStream =
    first &&
    !needsMask(first.geometry) &&
    first.geometry.destRect.x === 0 &&
    first.geometry.destRect.y === 0 &&
    first.geometry.destRect.width === canvas.width &&
    first.geometry.destRect.height === canvas.height
      ? first
      : null;

  const masks: MaskSpec[] = [];
  const layerOutputs: { label: string; x: number; y: number }[] = [];
  let base: string | null = null;
  for (const stream of allStreams) {
    const isBase = stream === baseStream;
    const { destRect } = stream.geometry;
    const size = `${String(destRect.width)}x${String(destRect.height)}`;
    const pieceLabels: string[] = [];
    for (const piece of stream.pieces) {
      const out = labels.next('p');
      pieceLabels.push(out);
      if (piece.kind === 'gap') {
        const d = framesDuration(piece.frames, F);
        lines.push(
          isBase
            ? `color=c=${background}:s=${size}:r=${String(F)}:d=${d},format=yuv420p,${COLOR_SOURCE_TO_BT709},setsar=1[${out}];`
            : `color=c=black@0:s=${size}:r=${String(F)}:d=${d},setsar=1,format=yuva420p[${out}];`,
        );
        continue;
      }
      const { layer } = piece;
      const src = layer.sourceRect;
      const filters = [
        `trim=start=${sec(layer.fileStartUs)}:end=${sec(layer.fileEndUs)}`,
        'setpts=PTS-STARTPTS',
        'tpad=stop_mode=clone:stop=-1',
        `trim=end_frame=${String(piece.frames)}`,
        `crop=${String(src.width)}:${String(src.height)}:${String(src.x)}:${String(src.y)}`,
        `scale=${String(destRect.width)}:${String(destRect.height)}`,
        'setsar=1',
      ];
      if (layer.mirror) filters.push('hflip');
      const convert = toBt709(options.mediaColor?.get(layer.mediaId));
      if (convert) filters.push(convert);
      filters.push(isBase ? 'format=yuv420p' : 'format=yuva420p');
      lines.push(`[${takeVideo(piece)}]${filters.join(',')}[${out}];`);
    }
    let track = labels.next('t');
    if (pieceLabels.length === 1) {
      // A single piece needs no concat; rename by passing through `null`.
      lines.push(`[${pieceLabels[0] ?? ''}]null[${track}];`);
    } else {
      lines.push(
        `${pieceLabels.map((l) => `[${l}]`).join('')}concat=n=${String(pieceLabels.length)}:v=1:a=0[${track}];`,
      );
    }
    if (needsMask(stream.geometry)) {
      const maskIndex = masks.length;
      // Mask inputs follow the media inputs.
      const spec: MaskSpec = {
        path: path.join(options.maskDir, `mask-${String(maskIndex)}.png`),
        inputIndex: mediaInputs + maskIndex,
        width: destRect.width,
        height: destRect.height,
        mask: stream.geometry.mask,
      };
      masks.push(spec);
      const [a, b, alpha, maskLabel, product, merged] = ['ta', 'tb', 'al', 'mk', 'am', 'tm'].map(
        (prefix) => labels.next(prefix),
      ) as [string, string, string, string, string, string];
      lines.push(`[${track}]split=2[${a}][${b}];`);
      lines.push(`[${b}]alphaextract[${alpha}];`);
      lines.push(
        `[${String(spec.inputIndex)}:v:0]format=gray,loop=loop=-1:size=1,setpts=N/${String(F)}/TB[${maskLabel}];`,
      );
      lines.push(`[${alpha}][${maskLabel}]blend=all_mode=multiply:shortest=1[${product}];`);
      lines.push(`[${a}][${product}]alphamerge[${merged}];`);
      track = merged;
    }
    if (isBase) base = track;
    else layerOutputs.push({ label: track, x: destRect.x, y: destRect.y });
  }

  for (const spec of masks) {
    inputs.push({
      index: spec.inputIndex,
      kind: 'mask',
      path: spec.path,
      mediaId: null,
      seek: null,
    });
  }

  // Composition (BT.709 YUV throughout; every source was converted above).
  if (base === null) {
    // One background frame, converted once and repeated.
    base = labels.next('b');
    lines.push(
      `color=c=${background}:s=${canvasSize}:r=${String(F)}:d=${framesDuration(1, F)},format=yuv420p,${COLOR_SOURCE_TO_BT709},setsar=1,loop=loop=-1:size=1,trim=end_frame=${String(totalFrames)}[${base}];`,
    );
  }
  for (const layer of layerOutputs) {
    const next = labels.next('b');
    lines.push(
      `[${base}][${layer.label}]overlay=x=${String(layer.x)}:y=${String(layer.y)}:eof_action=pass:format=yuv420[${next}];`,
    );
    base = next;
  }
  const tail: string[] = [];
  if (settings.width !== canvas.width || settings.height !== canvas.height) {
    tail.push(`scale=${String(settings.width)}:${String(settings.height)}:flags=bicubic`);
  }
  tail.push(
    'format=yuv420p',
    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
  );
  if (settings.encoder === 'h264_vaapi') tail.push('format=nv12', 'hwupload');
  lines.push(`[${base}]${tail.join(',')}[vout];`);

  // Audio.
  const audioSources = new Map<string, string[]>();
  for (const source of sources.values()) {
    if (source.kind !== 'a') continue;
    const index = sourceInput.get(source.key) ?? 0;
    const uses = source.uses.length;
    const seek = inputs[index]?.seek;
    // Labels are numbered even when unused, which keeps the golden graphs stable.
    const outs = Array.from({ length: uses }, () => labels.next('s'));
    const filters: string[] = [];
    if (seek) filters.push(`asetpts=PTS+${sec(seek.startUs)}/TB`);
    if (uses > 1) filters.push(`asplit=${String(uses)}`);
    if (filters.length === 0) {
      audioSources.set(source.key, [`${String(index)}:a:0`]);
      continue;
    }
    lines.push(`[${String(index)}:a:0]${filters.join(',')}${outs.map((l) => `[${l}]`).join('')};`);
    audioSources.set(source.key, outs);
  }
  const clipLabels: string[] = [];
  for (const segment of audio) {
    const media = mediaById.get(segment.mediaId);
    const src = audioSources.get(sourceOf.get(segment) ?? '')?.shift();
    if (!media || !src) throw new Error(`unreachable: no audio source for ${segment.mediaId}`);
    const out = labels.next('a');
    clipLabels.push(out);
    lines.push(`[${src}]${audioChain(segment, media).join(',')}[${out}];`);
  }
  const audioTail = `alimiter=limit=0.98:level=0:latency=1,aresample=${String(EXPORT_SAMPLE_RATE)},apad[aout]`;
  if (clipLabels.length === 0) {
    lines.push(`anullsrc=r=${String(EXPORT_SAMPLE_RATE)}:cl=stereo[aout]`);
  } else {
    lines.push(
      `${clipLabels.map((l) => `[${l}]`).join('')}amix=inputs=${String(clipLabels.length)}:normalize=0:dropout_transition=0,${audioTail}`,
    );
  }

  // Command line.
  const args: string[] = ['-y', '-loglevel', 'warning'];
  if (settings.encoder === 'h264_vaapi') args.push('-vaapi_device', VAAPI_DEVICE);
  for (const input of inputs) {
    if (input.seek) args.push('-noaccurate_seek', '-ss', sec(input.seek.startUs));
    args.push('-i', input.path);
  }
  args.push(
    '-/filter_complex',
    options.filterScriptPath,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...videoEncoderArgs(settings),
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-color_range',
    'tv',
    '-c:a',
    'aac',
    '-b:a',
    EXPORT_AUDIO_BITRATE,
    '-ar',
    String(EXPORT_SAMPLE_RATE),
    '-ac',
    '2',
    '-t',
    sec(durationUs),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    options.outputPath,
  );

  return ok({
    args,
    filterScriptText: `${lines.join('\n')}\n`,
    inputs,
    masks,
    expectedDurationUs: durationUs,
    settings,
  });
}
