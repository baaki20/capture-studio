/**
 * Recording manifest → initial `project.json` v1 (§4.3.5 "build the initial timeline", R1.31,
 * R1.32).
 *
 * The session manager writes a `RecordingManifest` while recording; finalize fills in the probed
 * durations and fitted clock ratios and calls `projectFromRecording`. The result has:
 * - one Screen video track;
 * - a Face video track and a Voice audio track for the camera and mic, linked as one face-voice
 *   component: wherever both media exist, their clips share a `linkId`, start and duration; a
 *   long enough remainder covered by only one of them (the voice after a camera disconnect) stays
 *   as an unlinked clip;
 * - a separate System audio track;
 * - one clip per active (unpaused) interval on every track, each at its synced position. The
 *   timeline is session time with the paused spans removed, so a timeline instant refers to the
 *   same session instant on every track.
 *
 * The canvas defaults to the recorded region (or the full stream), even-sized and capped at
 * 3840 × 2160 with the aspect preserved (§4.3.7); the region becomes the screen track's crop.
 * Per-media sync modes (hybrid calibration, §9.2) go into `Media.sync`; `recording.clockMode`
 * summarizes them (`hybrid` when they are mixed).
 */
import { z } from 'zod';
import { newId, ulid } from '../ids';
import { err, ok, type Result } from '../result';
import { frameDurationUs, type Us } from '../time';
import { mediaRefBounds } from './media-time';
import {
  FRAME_RATES,
  MediaSchema,
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION,
  ProjectV1Schema,
  ProjectV1StructureSchema,
  RecordingInfoSchema,
  type AudioTrack,
  type Clip,
  type Component,
  type Media,
  type MediaSync,
  type NRect,
  type OverlayLayout,
  type ProjectV1,
  type RecordingInfo,
  type Track,
  type VideoTrack,
} from './schema';

export const RECORDING_MANIFEST_VERSION = 1;

/** Largest default canvas (§4.3.7). */
export const MAX_DEFAULT_CANVAS = { width: 3840, height: 2160 } as const;

const CANVAS_MIN_SIDE = 64;

export const StreamSyncSchema = z.object({
  mode: z.enum(['shared', 'arrival-calibrated']),
  /** The calibrator's absolute offset (`sessionUs = timestampUs + offsetUs`), for logs. */
  offsetUs: z.int(),
  /** Cross-process clock handshake applied (external sources), or null. */
  clockHandshakeUs: z.int().nullable(),
  /** System audio: sink output latency included in `startOffsetUs`, for logs. */
  outputLatencyUs: z.int().optional(),
});

const RecordedRole = z.enum(['screen', 'camera', 'microphone', 'system-audio']);

/** One elementary stream file written by the recorder. */
export const RecordedStreamSchema = z.object({
  /** Stable media ID if the session manager assigned one; generated otherwise. */
  mediaId: MediaSchema.shape.id.optional(),
  role: RecordedRole,
  path: MediaSchema.shape.path,
  status: MediaSchema.shape.status,
  /** File-local duration (probed at finalize). */
  durationUs: MediaSchema.shape.durationUs,
  /** Reference-clock (session time since t0) time of the file's first sample. */
  startOffsetUs: MediaSchema.shape.startOffsetUs,
  /** From the drift fit; 1 when not applied. */
  clockRatio: MediaSchema.shape.clockRatio,
  endedEarly: z.boolean(),
  sync: StreamSyncSchema,
  video: MediaSchema.shape.video,
  audio: MediaSchema.shape.audio,
  encoder: MediaSchema.shape.encoder,
  stats: MediaSchema.shape.stats,
  device: MediaSchema.shape.device,
});

/** What the session manager records during a session (and finalize completes). */
export const RecordingManifestSchema = z.object({
  version: z.literal(RECORDING_MANIFEST_VERSION),
  projectId: ProjectV1StructureSchema.shape.id,
  name: ProjectV1StructureSchema.shape.name,
  createdAt: ProjectV1StructureSchema.shape.createdAt,
  appVersion: z.string(),
  recording: RecordingInfoSchema.omit({ clockMode: true }),
  frameRate: z.literal(FRAME_RATES),
  streams: z.array(RecordedStreamSchema),
});

export type StreamSync = z.infer<typeof StreamSyncSchema>;
export type RecordedRole = z.infer<typeof RecordedRole>;
export type RecordedStream = z.infer<typeof RecordedStreamSchema>;
export type RecordingManifest = z.infer<typeof RecordingManifestSchema>;

export interface FromRecordingOptions {
  /** ULID source for new IDs (inject for deterministic tests). */
  generateId?: () => string;
  /** Clock for `modifiedAt`. */
  now?: () => Date;
  background?: string;
  faceLayout?: Partial<OverlayLayout>;
  /**
   * Where only one of camera and mic covers part of an interval, that part becomes an unlinked
   * clip only if it is at least this long (default 500 ms). Shorter remainders are the devices'
   * start and stop latency differences; keeping them would litter the timeline with slivers.
   */
  minUnlinkedRemainderUs?: Us;
}

export interface FromRecordingError {
  code: 'invalid-project';
  issues: string[];
}

export interface Span {
  startUs: Us;
  endUs: Us;
}

/** Pauses sorted, clamped to `[0, durationUs]` and merged; empty ones removed. */
export function normalizePauses(pauses: readonly Span[], durationUs: Us): Span[] {
  const clamped = pauses
    .map((p) => ({
      startUs: Math.max(0, Math.min(p.startUs, durationUs)),
      endUs: Math.max(0, Math.min(p.endUs, durationUs)),
    }))
    .filter((p) => p.endUs > p.startUs)
    .sort((a, b) => a.startUs - b.startUs);
  const merged: Span[] = [];
  for (const p of clamped) {
    const last = merged[merged.length - 1];
    if (last && p.startUs <= last.endUs) last.endUs = Math.max(last.endUs, p.endUs);
    else merged.push({ ...p });
  }
  return merged;
}

/** `[0, durationUs]` minus the (normalized) pauses. */
export function activeIntervals(durationUs: Us, pauses: readonly Span[]): Span[] {
  const result: Span[] = [];
  let cursor = 0;
  for (const p of normalizePauses(pauses, durationUs)) {
    if (p.startUs > cursor) result.push({ startUs: cursor, endUs: p.startUs });
    cursor = p.endUs;
  }
  if (durationUs > cursor) result.push({ startUs: cursor, endUs: durationUs });
  return result;
}

/** Timeline time of a session instant: the session time minus the paused time before it. */
export function sessionToTimelineUs(pauses: readonly Span[], sessionUs: Us): Us {
  let paused = 0;
  for (const p of pauses) {
    if (p.startUs >= sessionUs) break;
    paused += Math.min(p.endUs, sessionUs) - p.startUs;
  }
  return sessionUs - paused;
}

function intersect(a: Span, b: Span): Span | null {
  const startUs = Math.max(a.startUs, b.startUs);
  const endUs = Math.min(a.endUs, b.endUs);
  return endUs > startUs ? { startUs, endUs } : null;
}

/** `a` minus `b` (zero, one or two pieces). */
function subtract(a: Span, b: Span): Span[] {
  const pieces: Span[] = [];
  if (b.startUs > a.startUs)
    pieces.push({ startUs: a.startUs, endUs: Math.min(b.startUs, a.endUs) });
  if (b.endUs < a.endUs) pieces.push({ startUs: Math.max(b.endUs, a.startUs), endUs: a.endUs });
  return pieces.filter((p) => p.endUs > p.startUs);
}

function toEven(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * Default canvas for a picture of `width × height`: even, within `MAX_DEFAULT_CANVAS` (the box is
 * turned for portrait pictures) with the aspect preserved, and at least 64 px a side.
 */
export function defaultCanvasSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const portrait = height > width;
  const maxW = portrait ? MAX_DEFAULT_CANVAS.height : MAX_DEFAULT_CANVAS.width;
  const maxH = portrait ? MAX_DEFAULT_CANVAS.width : MAX_DEFAULT_CANVAS.height;
  const scale = Math.min(1, maxW / width, maxH / height);
  const clampSide = (n: number) => Math.min(7680, Math.max(CANVAS_MIN_SIDE, toEven(n)));
  return { width: clampSide(width * scale), height: clampSide(height * scale) };
}

/**
 * The region in the screen media's pixels. Regions are picked in stream pixels; if the recorder
 * encoded the stream at a different size (the 1440p cap), the rect is scaled to match.
 */
export function screenCrop(
  region: NRect | null,
  source: { widthPx: number; heightPx: number },
  media: { width: number; height: number } | undefined,
): NRect | null {
  if (!region) return null;
  if (!media || (media.width === source.widthPx && media.height === source.heightPx)) {
    return { ...region };
  }
  const sx = media.width / source.widthPx;
  const sy = media.height / source.heightPx;
  const x = Math.min(Math.max(0, Math.round(region.x * sx)), media.width - 1);
  const y = Math.min(Math.max(0, Math.round(region.y * sy)), media.height - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(region.width * sx), media.width - x)),
    height: Math.max(1, Math.min(Math.round(region.height * sy), media.height - y)),
  };
}

/** A circle in the bottom-right corner, 20 % of the canvas width, with a 3 % margin. */
export function defaultFaceLayout(canvas: { width: number; height: number }): OverlayLayout {
  const width = 0.2;
  const sizePx = canvas.width * width;
  const marginPx = 0.03 * Math.min(canvas.width, canvas.height);
  const round4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;
  return {
    kind: 'overlay',
    centerX: round4((canvas.width - marginPx - sizePx / 2) / canvas.width),
    centerY: round4((canvas.height - marginPx - sizePx / 2) / canvas.height),
    width,
    shape: 'circle',
    cornerRadius: 0.12,
    mirror: false,
    crop: null,
  };
}

/**
 * `shared-capture` when every stream shares the capture domain, `arrival-calibrated` when none
 * does, `hybrid` when the modes are mixed (the §9.2 default: shared video, calibrated audio).
 */
export function recordingClockMode(
  streams: readonly Pick<RecordedStream, 'sync'>[],
): RecordingInfo['clockMode'] {
  const shared = streams.filter((s) => s.sync.mode === 'shared').length;
  if (streams.length > 0 && shared === streams.length) return 'shared-capture';
  return shared === 0 ? 'arrival-calibrated' : 'hybrid';
}

/** The `Media.sync` record for a stream's calibration (null handshake fields are left out). */
export function mediaSync(sync: StreamSync): MediaSync {
  return {
    mode: sync.mode,
    offsetUs: sync.offsetUs,
    ...(sync.clockHandshakeUs === null ? {} : { clockHandshakeUs: sync.clockHandshakeUs }),
    ...(sync.outputLatencyUs === undefined ? {} : { outputLatencyUs: sync.outputLatencyUs }),
  };
}

const KIND_BY_ROLE: Record<RecordedRole, 'video' | 'audio'> = {
  screen: 'video',
  camera: 'video',
  microphone: 'audio',
  'system-audio': 'audio',
};

function toMedia(stream: RecordedStream, id: string): Media {
  const media: Media = {
    id,
    role: stream.role,
    kind: KIND_BY_ROLE[stream.role],
    path: stream.path,
    status: stream.status,
    durationUs: stream.durationUs,
    startOffsetUs: stream.startOffsetUs,
    syncAdjustUs: 0,
    clockRatio: stream.clockRatio,
  };
  if (stream.endedEarly) media.endedEarly = true;
  if (stream.video) media.video = stream.video;
  if (stream.audio) media.audio = stream.audio;
  if (stream.encoder) media.encoder = stream.encoder;
  media.sync = mediaSync(stream.sync);
  if (stream.stats) media.stats = stream.stats;
  if (stream.device) media.device = stream.device;
  return media;
}

export function projectFromRecording(
  manifest: RecordingManifest,
  options: FromRecordingOptions = {},
): Result<ProjectV1, FromRecordingError> {
  const generate = options.generateId ?? ulid;
  const id = (kind: Parameters<typeof newId>[0]) => newId(kind, generate);
  const rec = manifest.recording;
  const pauses = normalizePauses(rec.pauses, rec.durationUs);
  const active = activeIntervals(rec.durationUs, pauses);
  const minClipUs = frameDurationUs(manifest.frameRate);

  // Media, in stream order; one per role (the first wins if a role repeats).
  const media: Media[] = [];
  const byRole = new Map<RecordedRole, Media>();
  for (const stream of manifest.streams) {
    if (byRole.has(stream.role)) continue;
    const m = toMedia(stream, stream.mediaId ?? id('media'));
    media.push(m);
    byRole.set(stream.role, m);
  }
  const screen = byRole.get('screen');
  const camera = byRole.get('camera');
  const mic = byRole.get('microphone');
  const system = byRole.get('system-audio');

  const clip = (m: Media, span: Span, linkId: string | null): Clip => ({
    id: id('clip'),
    mediaId: m.id,
    timelineStartUs: sessionToTimelineUs(pauses, span.startUs),
    sourceStartUs: span.startUs,
    sourceEndUs: span.endUs,
    linkId,
  });
  const long = (s: Span | null): s is Span => s !== null && s.endUs - s.startUs >= minClipUs;
  const minRemainderUs = Math.max(minClipUs, options.minUnlinkedRemainderUs ?? 500_000);
  const remainder = (s: Span) => s.endUs - s.startUs >= minRemainderUs;

  /** One clip per active interval within the media's reference bounds. */
  const clipsFor = (m: Media): Clip[] => {
    const bounds = mediaRefBounds(m);
    return active
      .map((a) => intersect(a, bounds))
      .filter(long)
      .map((s) => clip(m, s, null));
  };

  // Face + Voice: linked where both exist; the rest of the longer one stays unlinked.
  const faceClips: Clip[] = [];
  const voiceClips: Clip[] = [];
  if (camera && mic) {
    const cb = mediaRefBounds(camera);
    const mb = mediaRefBounds(mic);
    for (const a of active) {
      const c = intersect(a, cb);
      const v = intersect(a, mb);
      const common = c && v ? intersect(c, v) : null;
      if (long(common)) {
        const linkId = id('link');
        faceClips.push(clip(camera, common, linkId));
        voiceClips.push(clip(mic, common, linkId));
        if (c)
          for (const s of subtract(c, common).filter(remainder))
            faceClips.push(clip(camera, s, null));
        if (v)
          for (const s of subtract(v, common).filter(remainder))
            voiceClips.push(clip(mic, s, null));
      } else {
        if (long(c)) faceClips.push(clip(camera, c, null));
        if (long(v)) voiceClips.push(clip(mic, v, null));
      }
    }
  } else if (camera) {
    faceClips.push(...clipsFor(camera));
  } else if (mic) {
    voiceClips.push(...clipsFor(mic));
  }
  const byStart = (a: Clip, b: Clip) => a.timelineStartUs - b.timelineStartUs;
  faceClips.sort(byStart);
  voiceClips.sort(byStart);

  // Components.
  const components: Component[] = [];
  const screenComponent = screen
    ? { id: id('component'), type: 'screen' as const, mediaIds: [screen.id] }
    : null;
  if (screenComponent) components.push(screenComponent);
  const faceVoiceIds = [camera?.id, mic?.id].filter((x): x is string => x !== undefined);
  const faceComponent =
    faceVoiceIds.length > 0
      ? { id: id('component'), type: 'face-voice' as const, mediaIds: faceVoiceIds }
      : null;
  if (faceComponent) components.push(faceComponent);
  const systemComponent = system
    ? { id: id('component'), type: 'system-audio' as const, mediaIds: [system.id] }
    : null;
  if (systemComponent) components.push(systemComponent);

  // Canvas from the region (or full stream) in screen-media pixels.
  const crop = screenCrop(rec.source.region, rec.source, screen?.video);
  const picture = crop ?? {
    width: screen?.video?.width ?? rec.source.widthPx,
    height: screen?.video?.height ?? rec.source.heightPx,
  };
  const canvasSize = defaultCanvasSize(picture.width, picture.height);

  // Tracks, bottom-to-top for video.
  const tracks: Track[] = [];
  if (screen && screenComponent) {
    const t: VideoTrack = {
      id: id('track'),
      type: 'video',
      name: 'Screen',
      componentId: screenComponent.id,
      locked: false,
      hidden: false,
      layout: { kind: 'screen', crop, fit: 'contain' },
      clips: clipsFor(screen),
    };
    tracks.push(t);
  }
  if (camera && faceComponent) {
    tracks.push({
      id: id('track'),
      type: 'video',
      name: 'Face',
      componentId: faceComponent.id,
      locked: false,
      hidden: false,
      layout: { ...defaultFaceLayout(canvasSize), ...options.faceLayout, kind: 'overlay' },
      clips: faceClips,
    });
  }
  const audioTrack = (name: string, componentId: string, clips: Clip[]): AudioTrack => ({
    id: id('track'),
    type: 'audio',
    name,
    componentId,
    locked: false,
    gainDb: 0,
    muted: false,
    solo: false,
    clips,
  });
  if (mic && faceComponent) tracks.push(audioTrack('Voice', faceComponent.id, voiceClips));
  if (system && systemComponent) {
    tracks.push(audioTrack('System audio', systemComponent.id, clipsFor(system)));
  }

  const project: ProjectV1 = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    id: manifest.projectId,
    name: manifest.name,
    createdAt: manifest.createdAt,
    modifiedAt: (options.now ?? (() => new Date()))().toISOString(),
    createdBy: { app: 'capture-studio', version: manifest.appVersion },
    recording: {
      ...rec,
      clockMode: recordingClockMode(manifest.streams),
      pauses,
    },
    media,
    components,
    timeline: {
      canvas: {
        ...canvasSize,
        background: { type: 'color', color: options.background ?? '#000000' },
      },
      frameRate: manifest.frameRate,
      marks: { inUs: null, outUs: null },
      tracks,
    },
    extensions: {},
  };

  const parsed = ProjectV1Schema.safeParse(project);
  if (!parsed.success) {
    return err({
      code: 'invalid-project',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return ok(parsed.data);
}
