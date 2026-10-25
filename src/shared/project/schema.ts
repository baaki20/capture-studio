/**
 * `project.json` schema v1 (§4.4.1). Zod is the source of truth; the JSON Schema in
 * `docs/schemas/project-1.schema.json` is generated from it by `scripts/gen-schema.ts`.
 */
import { z } from 'zod';
import { checkProjectInvariants } from './invariants';

export const PROJECT_FORMAT = 'capture-studio.project';
export const PROJECT_FORMAT_VERSION = 1;
/** Folder-bundle extension (§1.6). Kept in one place so a rename is a one-line change. */
export const PROJECT_EXTENSION = '.cstudio';
export const PROJECT_FILE_NAME = 'project.json';

/** IDs are `<prefix>_<token>`. New IDs use ULID tokens (see `ids.ts`); readers accept any token. */
function prefixedId(prefix: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9A-Za-z]+$`), `must be an ID starting with "${prefix}_"`);
}

/** Integer microseconds. */
const Us = z.int().describe('Integer microseconds');
const NonNegativeUs = z.int().nonnegative().describe('Integer microseconds, ≥ 0');

const IsoUtc = z.iso.datetime().describe('ISO 8601 timestamp in UTC (Z suffix)');

/**
 * A path relative to the project root with POSIX separators: no leading slash, drive letter,
 * backslash, empty segment, `.` or `..` segment, or NUL. Media must live inside the bundle.
 */
const RelativePosixPath = z.string().regex(
  // eslint-disable-next-line no-control-regex
  /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\u0000]+$/,
  'must be a relative POSIX path inside the project folder',
);

const HexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/, 'must be #RRGGBB or #RRGGBBAA');

/** Integer rectangle in source pixels. */
export const NRectSchema = z.object({
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
});

export const RecordingInfoSchema = z.object({
  state: z.enum(['recording', 'finalizing', 'complete', 'recovered', 'failed']),
  failureReason: z.string().optional(),
  sessionId: prefixedId('ses'),
  startedAt: IsoUtc.describe('Wall clock at t0; informational only'),
  durationUs: NonNegativeUs.describe('Session-clock length, pauses included'),
  clockMode: z
    .enum(['shared-capture', 'arrival-calibrated', 'hybrid'])
    .describe('hybrid: some media share the capture domain, others are arrival-calibrated (§9.2)'),
  pauses: z.array(z.object({ startUs: Us, endUs: Us })).describe('Session-clock intervals'),
  source: z.object({
    kind: z.enum(['monitor', 'window']),
    label: z.string().optional(),
    widthPx: z.int().positive(),
    heightPx: z.int().positive(),
    region: NRectSchema.nullable(),
  }),
  platform: z.object({
    os: z.enum(['linux', 'win32', 'darwin']),
    session: z.enum(['wayland', 'x11']).optional(),
    desktop: z.string().optional(),
    electron: z.string(),
    chromium: z.string(),
    ffmpeg: z.string(),
  }),
});

/** How a recorded media's timestamps were mapped to the session clock (§1.5, §9.2). */
export const MediaSyncSchema = z.object({
  mode: z.enum(['shared', 'arrival-calibrated']),
  offsetUs: Us.optional().describe('Calibrator offset: sessionUs = timestampUs + offsetUs'),
  clockHandshakeUs: Us.optional().describe('Cross-process clock handshake applied (system audio)'),
  outputLatencyUs: Us.optional().describe(
    'Sink output latency added to system audio (the monitor runs ahead of the speakers)',
  ),
});

export const MediaSchema = z.object({
  id: prefixedId('med'),
  role: z.enum(['screen', 'camera', 'microphone', 'system-audio', 'imported']),
  kind: z.enum(['video', 'audio']),
  path: RelativePosixPath,
  status: z.enum(['ok', 'missing', 'recovered', 'failed']),
  durationUs: NonNegativeUs.describe('File-local duration'),
  startOffsetUs: Us.describe("Reference-clock time of the file's first sample"),
  syncAdjustUs: Us.describe('User sync nudge (default 0)'),
  clockRatio: z.number().positive().describe('Reference µs per file µs (default 1)'),
  endedEarly: z.boolean().optional(),
  video: z
    .object({
      codec: z.string(),
      width: z.int().positive(),
      height: z.int().positive(),
      frameRateNominal: z.number().positive(),
      variableFrameRate: z.boolean(),
    })
    .optional(),
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.int().positive(),
      channels: z.int().positive(),
      syncCheckpointsPath: RelativePosixPath.optional(),
      discontinuities: z.int().nonnegative(),
    })
    .optional(),
  encoder: z.object({ name: z.string(), hardware: z.boolean() }).optional(),
  sync: MediaSyncSchema.optional(),
  stats: z
    .object({
      framesEncoded: z.int().nonnegative().optional(),
      framesDropped: z.int().nonnegative().optional(),
    })
    .optional(),
  device: z
    .object({ label: z.string() })
    .optional()
    .describe('Informational; never used to re-open a device'),
});

export const ComponentSchema = z.object({
  id: prefixedId('cmp'),
  type: z.enum(['screen', 'face-voice', 'system-audio']),
  mediaIds: z.array(prefixedId('med')).describe('face-voice: [camera?, microphone?]'),
});

export const ClipSchema = z.object({
  id: prefixedId('clp'),
  mediaId: prefixedId('med'),
  timelineStartUs: NonNegativeUs,
  sourceStartUs: Us.describe("In the media's reference clock (session clock for recordings)"),
  sourceEndUs: Us.describe("In the media's reference clock (session clock for recordings)"),
  linkId: prefixedId('lnk').nullable().describe('Clips sharing a linkId edit together'),
});

export const ScreenLayoutSchema = z.object({
  kind: z.literal('screen'),
  crop: NRectSchema.nullable(),
  fit: z.literal('contain'),
});

export const OverlayLayoutSchema = z.object({
  kind: z.literal('overlay'),
  centerX: z.number().min(0).max(1).describe('Fraction of the canvas width'),
  centerY: z.number().min(0).max(1).describe('Fraction of the canvas height'),
  width: z.number().min(0.05).max(0.5).describe('Fraction of the canvas width'),
  shape: z.enum(['rectangle', 'rounded', 'circle']),
  cornerRadius: z.number().min(0).max(0.5).describe('Fraction of the short side (rounded only)'),
  mirror: z.boolean(),
  crop: NRectSchema.nullable().describe(
    'null = full frame (rectangle/rounded) or centred square (circle)',
  ),
});

const TrackBase = {
  id: prefixedId('trk'),
  name: z.string(),
  componentId: prefixedId('cmp').nullable(),
  locked: z.boolean(),
  clips: z.array(ClipSchema),
};

export const VideoTrackSchema = z.object({
  ...TrackBase,
  type: z.literal('video'),
  hidden: z.boolean(),
  layout: z.discriminatedUnion('kind', [ScreenLayoutSchema, OverlayLayoutSchema]),
});

export const AudioTrackSchema = z.object({
  ...TrackBase,
  type: z.literal('audio'),
  gainDb: z.number().min(-60).max(12),
  muted: z.boolean(),
  solo: z.boolean(),
});

export const TrackSchema = z.discriminatedUnion('type', [VideoTrackSchema, AudioTrackSchema]);

export const FRAME_RATES = [24, 25, 30, 50, 60] as const;

/** Even canvas side in 64–7680 px (invariant 5). */
const CanvasSide = z.int().min(64).max(7680).multipleOf(2);

export const TimelineSchema = z.object({
  canvas: z.object({
    width: CanvasSide,
    height: CanvasSide,
    background: z.object({ type: z.literal('color'), color: HexColor }),
  }),
  frameRate: z.literal(FRAME_RATES),
  marks: z.object({ inUs: Us.nullable(), outUs: Us.nullable() }),
  tracks: z.array(TrackSchema).describe('Bottom-to-top render order for video'),
});

export const ExportPrefsSchema = z.object({
  preset: z.enum(['draft', 'standard', 'high']),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  fps: z.number().positive().optional(),
  lastDir: z.string().optional(),
});

const projectShape = {
  format: z.literal(PROJECT_FORMAT),
  formatVersion: z.literal(PROJECT_FORMAT_VERSION).describe('Major; minor changes are additive'),
  id: prefixedId('prj'),
  name: z.string().min(1),
  createdAt: IsoUtc,
  modifiedAt: IsoUtc,
  createdBy: z.object({ app: z.literal('capture-studio'), version: z.string() }),
  recording: RecordingInfoSchema.nullable().describe('null for projects not created by recording'),
  media: z.array(MediaSchema),
  components: z.array(ComponentSchema),
  timeline: TimelineSchema,
  exportPrefs: ExportPrefsSchema.optional(),
  extensions: z.record(z.string(), z.unknown()).describe('Preserved verbatim on save'),
};

/** Structure only, without the cross-field invariants. */
export const ProjectV1StructureSchema = z.object(projectShape);

/** The full v1 schema: structure plus the invariants of §4.4.1. */
export const ProjectV1Schema = ProjectV1StructureSchema.superRefine((project, ctx) => {
  for (const violation of checkProjectInvariants(project)) {
    ctx.addIssue({
      code: 'custom',
      message: `${violation.code}: ${violation.message}`,
      path: violation.path,
      params: { invariant: violation.code },
    });
  }
});

export type NRect = z.infer<typeof NRectSchema>;
export type RecordingInfo = z.infer<typeof RecordingInfoSchema>;
export type Media = z.infer<typeof MediaSchema>;
export type MediaSync = z.infer<typeof MediaSyncSchema>;
export type Component = z.infer<typeof ComponentSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type ScreenLayout = z.infer<typeof ScreenLayoutSchema>;
export type OverlayLayout = z.infer<typeof OverlayLayoutSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type FrameRate = (typeof FRAME_RATES)[number];
export type ExportPrefs = z.infer<typeof ExportPrefsSchema>;
export type ProjectV1 = z.infer<typeof ProjectV1StructureSchema>;
