/**
 * `project.json` schema (§4.4.1). Zod is the source of truth; the JSON Schema in
 * `docs/schemas/project-<version>.schema.json` is generated from it by `scripts/gen-schema.ts`.
 *
 * Format 2 (Phase 2, the teaching editor) only adds optional fields, marked "v2" below. An absent
 * field means the Phase 1 behaviour, so migrating a v1 file changes nothing but the version. The
 * version still goes up because a Phase 1 build would silently drop these fields on save; with
 * the bump it opens a v2 project read-only instead (R1.30).
 *
 * Format 3 (Phase 3, plan decision D8) adds cursor tracks (media of kind `cursor`, a
 * `cursor.jsonl` file, `cursor-track.ts`) and the timeline's cursor effects, marked "v3". They
 * are optional too, for the same reason.
 */
import { z } from 'zod';
import { checkProjectInvariants } from './invariants';

export const PROJECT_FORMAT = 'capture-studio.project';
export const PROJECT_FORMAT_VERSION = 3;
/** Folder-bundle extension (§1.6). Kept in one place so a rename is a one-line change. */
export const PROJECT_EXTENSION = '.cstudio';
export const PROJECT_FILE_NAME = 'project.json';

/** IDs are `<prefix>_<token>`. New IDs use ULID tokens (see `ids.ts`); readers accept any token. */
export function prefixedId(prefix: string) {
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

/** A fraction in 0–1. */
const Fraction = z.number().min(0).max(1);

/** v2: how a keyframed value moves from one keyframe to the next (`easing.ts`). */
export const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'] as const;
const EasingSchema = z.enum(EASINGS).describe('Curve from this keyframe to the next');

/** v2: a rectangle in fractions of the canvas, inside it. A zero side is allowed (arrows). */
export const FRectSchema = z.object({
  x: Fraction,
  y: Fraction,
  width: Fraction,
  height: Fraction,
});

/** v2: a drop shadow. Sizes are fractions of the canvas's short side. */
export const ShadowSchema = z.object({
  blur: z.number().min(0).max(0.1),
  offsetX: z.number().min(-0.1).max(0.1),
  offsetY: z.number().min(-0.1).max(0.1),
  color: HexColor,
});

/** v2: a border. The width is a fraction of the canvas's short side. */
export const BorderSchema = z.object({
  width: z.number().min(0).max(0.05),
  color: HexColor,
});

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
  captureLatencyUs: Us.optional().describe(
    'Camera capture latency subtracted from startOffsetUs (frames are stamped on delivery)',
  ),
});

/**
 * v3: a cursor track recorded with a screen media (`cursor-track.ts`). Kept in the project's own
 * `cursorTracks` list, not in `media`: 0.2.0 refuses media of a role or kind it does not know,
 * but drops unknown top-level keys, so it can still open a 0.3.0 project read-only (R3.24).
 */
export const CursorTrackSchema = z.object({
  id: prefixedId('med'),
  path: RelativePosixPath.describe('The cursor.jsonl file'),
  status: z.enum(['ok', 'missing', 'recovered', 'failed']),
  durationUs: NonNegativeUs,
  screenMediaId: prefixedId('med').describe('The screen video whose pixels the positions are in'),
  inVideo: z
    .boolean()
    .describe(
      'The screen video shows the system cursor. Then the editor can add rings and a highlight ' +
        'but cannot move, resize or hide the cursor',
    ),
  sampleRateHz: z.number().positive().describe('Nominal position rate'),
  samples: z.int().nonnegative(),
  clicks: z.int().nonnegative(),
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
  speed: z
    .number()
    .min(0.25)
    .max(4)
    .optional()
    .describe('v2: playback speed, 1 when absent; audio keeps its pitch. Needs durationUs'),
  durationUs: z
    .int()
    .positive()
    .optional()
    .describe(
      'v2: length on the timeline, for a clip with speed or freeze. With speed, the source ' +
        'length equals durationUs × speed to within 2 µs of rounding',
    ),
  freeze: z
    .boolean()
    .optional()
    .describe('v2: hold the picture at sourceStartUs for durationUs; silent'),
  gainDb: z.number().min(-60).max(12).optional().describe('v2: clip gain on top of the track gain'),
  fadeInUs: NonNegativeUs.optional().describe('v2: audio fade-in length'),
  fadeOutUs: NonNegativeUs.optional().describe('v2: audio fade-out length'),
  transitionIn: z
    .object({
      kind: z.enum(['fade-color', 'dissolve', 'slide']),
      durationUs: z.int().positive(),
      color: HexColor.optional().describe('fade-color only; black when absent'),
      direction: z.enum(['left', 'right', 'up', 'down']).optional().describe('slide only'),
    })
    .optional()
    .describe('v2: transition from the previous clip on the track (or from nothing)'),
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
  zoom: z.number().min(1).max(4).optional().describe('v2: zoom inside the shape, 1 when absent'),
  border: BorderSchema.optional().describe('v2'),
  shadow: ShadowSchema.optional().describe('v2'),
});

/** v2: where the face goes. `side-by-side` puts the screen left and the face right. */
export const FACE_MODES = ['overlay', 'full', 'side-by-side', 'hidden'] as const;

/** v2: the face layout at one time; between keyframes the geometry eases (`scene.ts`). */
export const LayoutKeyframeSchema = z.object({
  tUs: NonNegativeUs.describe('Timeline time'),
  mode: z.enum(FACE_MODES),
  layout: OverlayLayoutSchema.describe('Overlay geometry and style (all modes use the style)'),
  easing: EasingSchema,
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
  layoutKeyframes: z
    .array(LayoutKeyframeSchema)
    .optional()
    .describe('v2, overlay tracks only: sorted by tUs; absent = `layout` in overlay mode'),
});

export const AudioTrackSchema = z.object({
  ...TrackBase,
  type: z.literal('audio'),
  gainDb: z.number().min(-60).max(12),
  muted: z.boolean(),
  solo: z.boolean(),
  volumeKeyframes: z
    .array(
      z.object({ tUs: NonNegativeUs, gainDb: z.number().min(-60).max(12), easing: EasingSchema }),
    )
    .optional()
    .describe('v2: sorted by tUs; added to gainDb'),
  cleanup: z
    .object({
      noise: z.enum(['off', 'light', 'strong']),
      normalize: z.boolean().describe('Loudness normalization to −16 LUFS on export'),
      duck: z
        .object({
          byTrackId: prefixedId('trk').describe('The voice track this track ducks under'),
          amountDb: z.number().min(-40).max(0),
          attackMs: z.int().min(1).max(2000),
          releaseMs: z.int().min(1).max(5000),
        })
        .optional(),
    })
    .optional()
    .describe('v2'),
});

export const TrackSchema = z.discriminatedUnion('type', [VideoTrackSchema, AudioTrackSchema]);

// ---------------------------------------------------------------------------------------------
// v2 objects: text, callouts and privacy regions drawn above the video tracks.

/** v2: fonts bundled with the app, so preview and export draw identical glyphs. */
export const OBJECT_FONTS = ['sans', 'serif', 'mono', 'handwriting'] as const;

export const StrokeSchema = z.object({
  color: HexColor,
  width: z.number().min(0).max(0.05).describe('Fraction of the canvas short side'),
});

const ObjectBase = {
  id: prefixedId('obj'),
  inUs: NonNegativeUs,
  outUs: NonNegativeUs,
  box: FRectSchema,
  opacity: Fraction.optional().describe('1 when absent'),
  fadeInUs: NonNegativeUs.optional(),
  fadeOutUs: NonNegativeUs.optional(),
  keyframes: z
    .array(z.object({ tUs: NonNegativeUs, box: FRectSchema, easing: EasingSchema }))
    .optional()
    .describe('Moves the box; timeline times inside [inUs, outUs], sorted'),
};

export const TextObjectSchema = z.object({
  ...ObjectBase,
  kind: z.literal('text'),
  text: z.string().max(2000),
  preset: z.string().optional().describe('Style preset it came from, e.g. "title"'),
  style: z.object({
    font: z.enum(OBJECT_FONTS),
    size: z.number().min(0.01).max(0.5).describe('Fraction of the canvas height'),
    color: HexColor,
    bold: z.boolean(),
    italic: z.boolean(),
    align: z.enum(['left', 'center', 'right']),
    background: HexColor.optional(),
    outline: StrokeSchema.optional(),
  }),
});

export const ShapeObjectSchema = z.object({
  ...ObjectBase,
  kind: z.enum(['rectangle', 'ellipse']),
  stroke: StrokeSchema,
  fill: HexColor.optional(),
});

export const ArrowObjectSchema = z.object({
  ...ObjectBase,
  kind: z.literal('arrow'),
  tail: z
    .enum(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
    .describe('Corner of the box the arrow starts at; the head is at the opposite corner'),
  stroke: StrokeSchema,
  head: z.enum(['triangle', 'open', 'none']),
});

export const StepObjectSchema = z.object({
  ...ObjectBase,
  kind: z.literal('step'),
  value: z.int().min(1).max(999),
  format: z.enum(['1', 'A', 'a', 'I', 'i']),
  fill: HexColor,
  textColor: HexColor,
});

export const HighlightObjectSchema = z.object({
  ...ObjectBase,
  kind: z.literal('highlight'),
  color: HexColor,
});

export const SpotlightObjectSchema = z.object({
  ...ObjectBase,
  kind: z.literal('spotlight'),
  shape: z.enum(['rectangle', 'ellipse']),
  dim: Fraction.describe('Opacity of the darkening outside the box'),
});

export const BlurObjectSchema = z.object({
  ...ObjectBase,
  kind: z.literal('blur'),
  radius: z.number().min(0.001).max(0.05).describe('Fraction of the canvas short side'),
});

export const PixelateObjectSchema = z.object({
  ...ObjectBase,
  kind: z.literal('pixelate'),
  blockSize: z.number().min(0.002).max(0.1).describe('Fraction of the canvas short side'),
});

export const TimelineObjectSchema = z.union([
  TextObjectSchema,
  ShapeObjectSchema,
  ArrowObjectSchema,
  StepObjectSchema,
  HighlightObjectSchema,
  SpotlightObjectSchema,
  BlurObjectSchema,
  PixelateObjectSchema,
]);

export const ObjectTrackSchema = z.object({
  id: prefixedId('trk'),
  name: z.string(),
  locked: z.boolean(),
  hidden: z.boolean(),
  items: z.array(TimelineObjectSchema).describe('Drawn in array order; times may overlap'),
});

/** v2: zoom and pan. `rect` is the part of the canvas that fills the frame. */
export const CameraKeyframeSchema = z.object({
  tUs: NonNegativeUs,
  rect: FRectSchema,
  easing: EasingSchema,
});

/** v2: background, padding, rounded corners and shadow around the screen layer. */
export const BeautifySchema = z.object({
  background: z.discriminatedUnion('type', [
    z.object({ type: z.literal('color'), color: HexColor }),
    z.object({
      type: z.literal('gradient'),
      from: HexColor,
      to: HexColor,
      angleDeg: z.number().min(0).max(360),
    }),
    z.object({
      type: z.literal('image'),
      mediaId: prefixedId('med').describe('An imported picture, drawn to cover the canvas'),
      color: HexColor.describe('Shown while the picture loads or if it is missing'),
    }),
  ]),
  padding: z.number().min(0).max(0.3).describe('Fraction of the canvas short side'),
  cornerRadius: z.number().min(0).max(0.2).describe('Fraction of the canvas short side'),
  shadow: ShadowSchema.optional(),
});

/**
 * v3: cursor effects (R3.10–R3.12), drawn from the cursor tracks. Sizes are fractions of the
 * canvas's short side. Smoothing, size and hide need a track whose video does not show the
 * cursor (`inVideo: false`); rings and the highlight work on any track.
 */
export const CursorEffectsSchema = z.object({
  smoothing: Fraction.describe('0 = the recorded path; 1 = the smoothest'),
  size: z.number().min(0.5).max(3).describe('Drawn cursor scale; 1 = the system size'),
  hide: z.boolean().describe('Hide the drawn cursor (rings and highlight still show)'),
  clickRings: z.object({
    enabled: z.boolean(),
    color: HexColor,
    size: z.number().min(0.01).max(0.2).describe('Final ring radius'),
    durationUs: z.int().min(100_000).max(2_000_000),
  }),
  highlight: z.object({
    enabled: z.boolean(),
    color: HexColor.describe('A translucent colour (#RRGGBBAA) works best'),
    radius: z.number().min(0.01).max(0.2),
  }),
});

export const MarkerSchema = z.object({
  id: prefixedId('mrk'),
  tUs: NonNegativeUs,
  label: z.string().max(200),
  chapter: z.boolean().describe('Exported as an MP4 chapter'),
});

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
  objectTracks: z
    .array(ObjectTrackSchema)
    .optional()
    .describe('v2: drawn above every video track, bottom to top'),
  camera: z
    .array(CameraKeyframeSchema)
    .optional()
    .describe('v2: sorted by tUs; zooms everything except face overlays'),
  beautify: BeautifySchema.optional().describe('v2: replaces the plain canvas background'),
  markers: z.array(MarkerSchema).optional().describe('v2: sorted by tUs'),
  cursorEffects: CursorEffectsSchema.optional().describe('v3: absent = no effects'),
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
  cursorTracks: z
    .array(CursorTrackSchema)
    .default([])
    .describe('v3: cursor tracks recorded with screen media (never clips)'),
  components: z.array(ComponentSchema),
  timeline: TimelineSchema,
  exportPrefs: ExportPrefsSchema.optional(),
  extensions: z.record(z.string(), z.unknown()).describe('Preserved verbatim on save'),
};

/** Structure only, without the cross-field invariants. */
export const ProjectStructureSchema = z.object(projectShape);

/** The full v1 schema: structure plus the invariants of §4.4.1. */
export const ProjectSchema = ProjectStructureSchema.superRefine((project, ctx) => {
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
export type Easing = (typeof EASINGS)[number];
export type FRect = z.infer<typeof FRectSchema>;
export type Shadow = z.infer<typeof ShadowSchema>;
export type Border = z.infer<typeof BorderSchema>;
export type FaceMode = (typeof FACE_MODES)[number];
export type LayoutKeyframe = z.infer<typeof LayoutKeyframeSchema>;
export type TimelineObject = z.infer<typeof TimelineObjectSchema>;
export type ObjectTrack = z.infer<typeof ObjectTrackSchema>;
export type CameraKeyframe = z.infer<typeof CameraKeyframeSchema>;
export type Beautify = z.infer<typeof BeautifySchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type CursorTrackEntry = z.infer<typeof CursorTrackSchema>;
export type CursorEffects = z.infer<typeof CursorEffectsSchema>;
export type Project = z.infer<typeof ProjectStructureSchema>;
