/**
 * The Phase 1 IPC contract (§4.3.11): channel names, zod payloads and which windows may use each
 * channel. Main validates every incoming payload against these schemas (`main/ipc/router.ts`);
 * preloads use the inferred types only.
 *
 * - Invoke channels: renderer → main, request/response.
 * - Events: main → renderer.
 * - Engine channels: main ⇄ capture engine. Main sends commands as `{requestId, payload}` on the
 *   command's channel and the engine answers on `engine.reply`; the engine reports on
 *   `engine.stats`, `engine.trackEnded` and `engine.ready`. MessagePorts arrive on `engine.ports`.
 */
import { z } from 'zod';
import { CapabilityReportSchema, FfmpegEncoderReportSchema } from '../capabilities/types';
import { NRectSchema, ProjectV1Schema } from '../project/schema';
import { SettingsV1Schema } from '../settings/schema';
import { CLI_ACTIONS } from './actions';

export const WINDOW_KINDS = ['shell', 'controls', 'picker', 'editor', 'engine'] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

/** Media streams written by the recorder, one file each (§1.5). */
export const STREAM_KINDS = ['screen', 'camera', 'mic', 'system'] as const;
export const StreamKindSchema = z.enum(STREAM_KINDS);
export type StreamKind = z.infer<typeof StreamKindSchema>;

// ---------------------------------------------------------------------------------------------
// Shared payload pieces

const NoPayload = z.undefined();
const Id = z.string().min(1).max(64);

const S = SettingsV1Schema.shape;
const R = S.recorder.shape;

/**
 * What a renderer may change in settings. Folder paths and the name counter are left out: they
 * change only through dialogs and flows that main runs itself.
 */
export const SettingsPatchSchema = z.strictObject({
  namePattern: S.namePattern.optional(),
  recorder: z
    .strictObject({
      captureMode: R.captureMode.optional(),
      cameraId: R.cameraId.optional(),
      micId: R.micId.optional(),
      systemAudio: R.systemAudio.optional(),
      micProcessing: R.micProcessing.partial().strict().optional(),
      fps: R.fps.optional(),
      quality: R.quality.optional(),
      countdownSec: R.countdownSec.optional(),
      minimizeControlsOnStart: R.minimizeControlsOnStart.optional(),
      afterRecording: R.afterRecording.optional(),
      confirmAbort: z.boolean().optional(),
      lastRegion: R.lastRegion.optional(),
    })
    .optional(),
  export: S.export.partial().strict().optional(),
  disk: S.disk.partial().strict().optional(),
  theme: S.theme.optional(),
  language: S.language.optional(),
});
export type SettingsPatchPayload = z.infer<typeof SettingsPatchSchema>;

/** The recorder choices of the New Recording panel (R1.5). */
export const RecorderConfigSchema = z.strictObject({
  captureMode: R.captureMode,
  cameraId: R.cameraId,
  micId: R.micId,
  systemAudio: R.systemAudio,
  micProcessing: R.micProcessing,
  fps: R.fps,
  quality: R.quality,
  countdownSec: R.countdownSec,
});
export type RecorderConfig = z.infer<typeof RecorderConfigSchema>;

export const RecordResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('started'), sessionId: Id }),
  /** The portal, region picker or countdown was cancelled (no project exists). */
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('failed'), message: z.string() }),
]);

export const RECORDING_STATES = [
  'idle',
  'configuring',
  'acquiring',
  'picking-region',
  'countdown',
  'recording',
  'paused',
  'finalizing',
  'completed',
  'aborted',
  'failed',
] as const;

export const RecStateEventSchema = z.object({
  state: z.enum(RECORDING_STATES),
  sessionId: Id.nullable(),
  /** Elapsed recording time without pauses (R1.12). */
  elapsedUs: z.number().nonnegative(),
  countdownRemainingSec: z.int().nonnegative().nullable(),
  failureReason: z.string().nullable(),
});

export const RecStatsEventSchema = z.object({
  elapsedUs: z.number().nonnegative(),
  /** Linear peak level 0–1, or null when the source is off. */
  levels: z.object({ mic: z.number().min(0).nullable(), system: z.number().min(0).nullable() }),
  /** Dropped fraction 0–1 per video stream (R1.12 colours). */
  dropped: z.object({ screen: z.number().min(0), camera: z.number().min(0).nullable() }),
  bytesWritten: z.int().nonnegative(),
});

export const RecNoticeEventSchema = z.object({
  id: Id,
  level: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  stream: StreamKindSchema.nullable(),
});

/**
 * Live input levels for the meters (R1.6, R1.12: at least 10 Hz). Each message carries the
 * sources it has news for; a missing key keeps the previous value. Linear peak 0–1.
 */
export const RecLevelsEventSchema = z.object({
  mic: z.number().min(0).optional(),
  system: z.number().min(0).optional(),
});

/** A recording was finalized into a project (completion notice, step 11). */
export const RecCompletedEventSchema = z.object({
  projectId: Id,
  name: z.string(),
  afterRecording: R.afterRecording,
});

export const PickerSubmitSchema = z.strictObject({
  sourceWidth: z.int().positive(),
  sourceHeight: z.int().positive(),
  rect: NRectSchema,
});

/** What the region picker shows (§4.3.7): the frozen frame and the matching last region. */
export const PickerLoadResultSchema = z.object({
  sourceWidth: z.int().positive(),
  sourceHeight: z.int().positive(),
  /** The frozen frame as a `data:image/png` URL, in stream pixels. */
  imageUrl: z.string().startsWith('data:image/'),
  /** The persisted last region, only when its source size matches (R1.9). */
  lastRegion: NRectSchema.nullable(),
});

export const COMPONENT_BADGES = ['screen', 'face', 'voice', 'system'] as const;

export const LibraryEntrySchema = z.object({
  id: Id,
  name: z.string(),
  createdAt: z.string(),
  durationUs: z.number().nonnegative(),
  components: z.array(z.enum(COMPONENT_BADGES)),
  /** A `cs-media://` URL, or null while it is generated. */
  thumbUrl: z.string().nullable(),
  state: z.enum(['recording', 'finalizing', 'complete', 'recovered', 'failed']),
});

/** Why a media is offline (R1.29): its file is gone, or present but unreadable or damaged. */
export const OfflineMediaSchema = z.object({
  reason: z.enum(['missing', 'unreadable']),
  /** What is wrong with an unreadable file ("the file is truncated…"), or null. */
  detail: z.string().nullable(),
});
export type OfflineMedia = z.infer<typeof OfflineMediaSchema>;

export const ProjectOpenResultSchema = z.object({
  doc: ProjectV1Schema,
  revision: z.int().nonnegative(),
  /** `cs-media://` URL per media id. */
  mediaUrls: z.record(z.string(), z.string()),
  readOnly: z.boolean(),
  /** Offline media by id, with the reason (added after step 18; optional). */
  offline: z.record(z.string(), OfflineMediaSchema).optional(),
});

/** Settings → which folder to choose with main's dialog (renderers never send paths). */
export const SettingsFolderSchema = z.enum(['projectsDir', 'exportsDir']);

/** Shown once when settings had to be restored from a backup or reset (R1.50). */
export const SettingsLoadNoticeSchema = z.object({
  kind: z.enum(['recovered-from-backup', 'reset-to-defaults']),
  message: z.string(),
});

export const ProjectSaveSchema = z.strictObject({
  id: Id,
  revision: z.int().nonnegative(),
  doc: ProjectV1Schema,
});

export const MediaAssetRequestSchema = z.strictObject({ projectId: Id, mediaId: Id });
export const MediaAssetResultSchema = z.object({
  status: z.enum(['ready', 'pending', 'unavailable']),
  url: z.string().nullable(),
});

export const ExportOptionsSchema = z.strictObject({
  resolution: z.enum(['canvas', '1080p', '720p']),
  fps: z.union([z.literal(30), z.literal(60), z.literal('project')]),
  quality: z.enum(['draft', 'standard', 'high']),
  encoder: z.enum(['auto', 'software']),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

/**
 * `export.start` (step 19). The output path is never sent by the renderer: main uses the file
 * chosen with `export.chooseOutput`, or the default `<exportsDir>/<project name>.mp4`. `doc` is
 * the editor's current document, the snapshot the export uses (R1.49); without it main reads
 * the saved project. `overwrite` confirms replacing an existing file (R1.47).
 */
export const ExportStartSchema = z.strictObject({
  projectId: Id,
  options: ExportOptionsSchema,
  doc: ProjectV1Schema.optional(),
  overwrite: z.boolean().optional(),
});

export const ExportStartResultSchema = z.object({
  /** Null unless `status` is `started`. */
  jobId: Id.nullable(),
  /** `exists`: the target exists and `overwrite` was not set; `blocked`: see `message`. */
  status: z.enum(['started', 'exists', 'blocked']),
  /** The output file. */
  path: z.string(),
  message: z.string().nullable(),
});

/** Where an export of a project will be written. */
export const ExportTargetSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
});

export const RecoveryCandidateSchema = z.object({
  id: Id,
  name: z.string(),
  startedAt: z.string().nullable(),
  state: z.string(),
  sizeBytes: z.int().nonnegative(),
});

export const ShortcutCommandSchema = z.object({
  action: z.enum(CLI_ACTIONS),
  label: z.string(),
  command: z.string(),
});

/** Everything Settings → Diagnostics shows (R1.1, R1.4, R1.51). */
export const DiagnosticsReportSchema = z.object({
  capabilities: CapabilityReportSchema,
  versions: z.object({
    app: z.string(),
    electron: z.string(),
    chrome: z.string(),
    node: z.string(),
    ffmpeg: z.string().nullable(),
  }),
  paths: z.object({
    ffmpeg: z.string().nullable(),
    ffprobe: z.string().nullable(),
    logFile: z.string(),
    userData: z.string(),
    projectsDir: z.string(),
  }),
  ffmpegError: z.string().nullable(),
  encoders: FfmpegEncoderReportSchema.nullable(),
  secrets: z.object({
    backend: z.string(),
    persistent: z.boolean(),
    reason: z.string().nullable(),
  }),
  shortcuts: z.array(ShortcutCommandSchema),
  /** False where global shortcuts are known not to work (§9.8): the button is hidden. */
  canRegisterGlobalShortcuts: z.boolean(),
});
export type DiagnosticsReport = z.infer<typeof DiagnosticsReportSchema>;

// ---------------------------------------------------------------------------------------------
// Invoke channels

interface InvokeSpec<Req extends z.ZodType, Res extends z.ZodType> {
  request: Req;
  response: Res;
  windows: readonly WindowKind[];
}

function invoke<Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
  windows: readonly WindowKind[],
): InvokeSpec<Req, Res> {
  return { request, response, windows };
}

const UI: readonly WindowKind[] = ['shell', 'controls', 'picker', 'editor'];
const SHELL: readonly WindowKind[] = ['shell'];
const RECORDER: readonly WindowKind[] = ['shell', 'controls'];
const EDITOR: readonly WindowKind[] = ['editor'];
const LIBRARY: readonly WindowKind[] = ['shell', 'editor'];

export const INVOKE_CHANNELS = {
  'caps.get': invoke(NoPayload, CapabilityReportSchema, UI),
  'caps.refresh': invoke(NoPayload, CapabilityReportSchema, SHELL),

  'settings.get': invoke(NoPayload, SettingsV1Schema, UI),
  'settings.patch': invoke(SettingsPatchSchema, SettingsV1Schema, ['shell', 'controls', 'editor']),
  /** Folder dialog in main for the projects or exports folder; null when cancelled. */
  'settings.chooseFolder': invoke(
    z.strictObject({ which: SettingsFolderSchema }),
    SettingsV1Schema.nullable(),
    SHELL,
  ),
  /** The settings-recovery notice, answered once per launch (then null; R1.50). */
  'settings.takeLoadNotice': invoke(NoPayload, SettingsLoadNoticeSchema.nullable(), SHELL),

  'rec.configure': invoke(RecorderConfigSchema, z.undefined(), SHELL),
  'rec.record': invoke(NoPayload, RecordResultSchema, SHELL),
  'rec.pause': invoke(NoPayload, z.undefined(), RECORDER),
  'rec.resume': invoke(NoPayload, z.undefined(), RECORDER),
  'rec.stop': invoke(NoPayload, z.undefined(), RECORDER),
  'rec.restart': invoke(NoPayload, z.undefined(), RECORDER),
  'rec.abort': invoke(NoPayload, z.undefined(), RECORDER),
  /** The current recorder state (windows opened mid-session start from it). */
  'rec.status': invoke(NoPayload, RecStateEventSchema, RECORDER),
  /** Setup panel: live system-audio meter while the panel is open (R1.5). */
  'rec.monitorSystem': invoke(z.strictObject({ enabled: z.boolean() }), z.undefined(), SHELL),

  'picker.load': invoke(NoPayload, PickerLoadResultSchema, ['picker']),

  'picker.submit': invoke(PickerSubmitSchema, z.undefined(), ['picker']),
  'picker.cancel': invoke(NoPayload, z.undefined(), ['picker']),

  'library.list': invoke(NoPayload, z.array(LibraryEntrySchema), SHELL),
  'library.rename': invoke(
    z.strictObject({ id: Id, name: z.string().min(1).max(200) }),
    LibraryEntrySchema,
    SHELL,
  ),
  'library.trash': invoke(z.strictObject({ id: Id }), z.object({ trashed: z.boolean() }), SHELL),
  'library.reveal': invoke(z.strictObject({ id: Id }), z.undefined(), LIBRARY),
  /** Folder dialog in main; validates and adds an existing `.cstudio` project (null = cancelled). */
  'library.import': invoke(NoPayload, LibraryEntrySchema.nullable(), SHELL),
  /** Opens the projects folder in the file manager. */
  'library.openFolder': invoke(NoPayload, z.undefined(), SHELL),

  'project.open': invoke(z.strictObject({ id: Id }), ProjectOpenResultSchema, ['shell', 'editor']),
  /** Opens the project in an editor window (one per project; focuses an open one). */
  'editor.open': invoke(z.strictObject({ id: Id }), z.undefined(), SHELL),
  'project.save': invoke(ProjectSaveSchema, z.object({ revision: z.int().nonnegative() }), EDITOR),
  'project.relink': invoke(
    z.strictObject({ id: Id, mediaId: Id }),
    z.object({ relinked: z.boolean() }),
    EDITOR,
  ),

  'media.peaks': invoke(MediaAssetRequestSchema, MediaAssetResultSchema, EDITOR),
  'media.thumbs': invoke(MediaAssetRequestSchema, MediaAssetResultSchema, EDITOR),

  'export.probeEncoders': invoke(NoPayload, FfmpegEncoderReportSchema, EDITOR),
  'export.start': invoke(ExportStartSchema, ExportStartResultSchema, EDITOR),
  'export.cancel': invoke(z.strictObject({ jobId: Id }), z.undefined(), EDITOR),
  /** The current target (chosen or default) for a project's export. */
  'export.target': invoke(z.strictObject({ projectId: Id }), ExportTargetSchema, EDITOR),
  /** Native save dialog in main; the choice becomes the project's target. Null = cancelled. */
  'export.chooseOutput': invoke(
    z.strictObject({ projectId: Id }),
    ExportTargetSchema.nullable(),
    EDITOR,
  ),
  /** After `export.done`: show the file in the file manager, or open it. */
  'export.reveal': invoke(z.strictObject({ jobId: Id }), z.undefined(), EDITOR),
  'export.open': invoke(z.strictObject({ jobId: Id }), z.undefined(), EDITOR),

  'recovery.list': invoke(NoPayload, z.array(RecoveryCandidateSchema), SHELL),
  'recovery.recover': invoke(z.strictObject({ id: Id }), z.object({ projectId: Id }), SHELL),
  'recovery.discard': invoke(
    z.strictObject({ id: Id, action: z.enum(['trash', 'leave']) }),
    z.undefined(),
    SHELL,
  ),

  'diag.get': invoke(NoPayload, DiagnosticsReportSchema, SHELL),
  'diag.copyReport': invoke(NoPayload, z.object({ text: z.string() }), SHELL),
} as const;

export type InvokeChannel = keyof typeof INVOKE_CHANNELS;
/** What a renderer passes. */
export type InvokeRequest<C extends InvokeChannel> = z.input<
  (typeof INVOKE_CHANNELS)[C]['request']
>;
/** What a main handler receives after validation. */
export type InvokePayload<C extends InvokeChannel> = z.output<
  (typeof INVOKE_CHANNELS)[C]['request']
>;
export type InvokeResponse<C extends InvokeChannel> = z.output<
  (typeof INVOKE_CHANNELS)[C]['response']
>;

export function isInvokeChannel(value: string): value is InvokeChannel {
  return Object.hasOwn(INVOKE_CHANNELS, value);
}

// ---------------------------------------------------------------------------------------------
// Events (main → renderer)

export const EVENT_CHANNELS = {
  'rec.state': { payload: RecStateEventSchema, windows: ['shell', 'controls'] },
  'rec.stats': { payload: RecStatsEventSchema, windows: ['shell', 'controls'] },
  'rec.notice': { payload: RecNoticeEventSchema, windows: ['shell', 'controls'] },
  'rec.levels': { payload: RecLevelsEventSchema, windows: ['shell', 'controls'] },
  'rec.completed': { payload: RecCompletedEventSchema, windows: ['shell'] },
  'export.progress': {
    payload: z.object({
      jobId: Id,
      fraction: z.number().min(0).max(1).nullable(),
      etaSec: z.number().nonnegative().nullable(),
    }),
    windows: ['editor'],
  },
  'export.done': {
    payload: z.object({
      jobId: Id,
      outputName: z.string(),
      /** Added in step 19 (optional for compatibility). */
      outputPath: z.string().optional(),
      encoder: z.string().optional(),
      /** Set when the hardware encoder failed and libx264 was used instead (§4.3.9). */
      notice: z.string().nullable().optional(),
    }),
    windows: ['editor'],
  },
  'export.error': {
    payload: z.object({ jobId: Id, message: z.string(), cancelled: z.boolean() }),
    windows: ['editor'],
  },
  'library.changed': { payload: z.undefined(), windows: ['shell'] },
  /** A project's background peaks and thumbnails are done (R1.44). */
  'media.cachesReady': { payload: z.object({ projectId: Id }), windows: ['shell', 'editor'] },
  'caps.changed': { payload: CapabilityReportSchema, windows: UI },
} as const satisfies Record<string, { payload: z.ZodType; windows: readonly WindowKind[] }>;

export type EventChannel = keyof typeof EVENT_CHANNELS;
export type EventPayload<C extends EventChannel> = z.output<(typeof EVENT_CHANNELS)[C]['payload']>;

// ---------------------------------------------------------------------------------------------
// Capture engine channels

export const EngineAcquireSchema = z.strictObject({
  screen: z.strictObject({
    /** `desktopCapturer` source id from main (§9.1). */
    sourceId: z.string().min(1),
    /** Always passed; Chromium otherwise caps at 1920×1080 (§9.1). */
    maxWidth: z.int().positive(),
    maxHeight: z.int().positive(),
    fps: z.literal([30, 60]),
  }),
  camera: z.strictObject({ deviceId: z.string().min(1) }).nullable(),
  mic: z
    .strictObject({
      deviceId: z.string().min(1),
      echoCancellation: z.boolean(),
      noiseSuppression: z.boolean(),
      autoGainControl: z.boolean(),
    })
    .nullable(),
});

const TrackInfoSchema = z.object({
  label: z.string(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  /** Video: the delivered rate measured at acquisition (§9.3), not the requested one. */
  frameRate: z.number().positive().optional(),
  sampleRate: z.int().positive().optional(),
  channels: z.int().positive().optional(),
});

/** A requested camera or mic that could not be opened; the recording goes on without it. */
export const EngineAcquireWarningSchema = z.object({
  kind: StreamKindSchema,
  message: z.string(),
});

export const EngineAcquireResultSchema = z.object({
  status: z.enum(['ready', 'cancelled']),
  /** Real sizes, read from the first frame (§9.1). */
  screen: TrackInfoSchema.nullable(),
  camera: TrackInfoSchema.nullable(),
  mic: TrackInfoSchema.nullable(),
  /** Added in step 9: requested devices that are missing or failed to open (R1.6 notice). */
  warnings: z.array(EngineAcquireWarningSchema).optional(),
});

export const EngineStartSchema = z.strictObject({
  sessionId: Id,
  quality: z.enum(['standard', 'high']),
  fps: z.literal([30, 60]),
  region: NRectSchema.nullable(),
});

/** `[sessionUs, cumulativeSamples]` drift checkpoint (§1.5, `media/<x>.sync.json`). */
const CheckpointSchema = z.tuple([z.number(), z.int().nonnegative()]);

const EncoderInfoSchema = z.object({ name: z.string(), hardware: z.boolean() });

export const EngineStreamStatsSchema = z.looseObject({
  kind: StreamKindSchema,
  /** Video: frames; audio: `AudioData` chunks. */
  framesIn: z.int().nonnegative(),
  framesEncoded: z.int().nonnegative(),
  /** Backpressure drops and encoder failures (paused frames are not drops). */
  framesDropped: z.int().nonnegative(),
  /** Muxed bytes sent to the media utility. */
  bytes: z.int().nonnegative(),
  discontinuities: z.int().nonnegative(),
  queueDepth: z.int().nonnegative(),
  // Added in step 9 (all optional, so the payload stays backward compatible).
  streamId: Id.optional(),
  /** Frames (or chunks) that fell inside a pause and were not stored. */
  framesPaused: z.int().nonnegative().optional(),
  /** Video: the delivered rate (§9.3), null until two frames arrived. */
  deliveredFps: z.number().positive().nullable().optional(),
  /** Video: dropped fraction against the delivered rate, and its R1.12 colour. */
  droppedRatio: z.number().min(0).optional(),
  dropLevel: z.enum(['ok', 'amber', 'red']).optional(),
  /** Audio: samples per channel written (silence included). */
  samplesWritten: z.int().nonnegative().optional(),
  /** Audio: linear peak 0–1 since the previous stats message. */
  level: z.number().min(0).optional(),
  /** Audio: drift checkpoints produced since the previous `engine.stats` (append to sync.json). */
  checkpoints: z.array(CheckpointSchema).optional(),
  state: z.enum(['starting', 'recording', 'finished', 'failed']).optional(),
});
export type EngineStreamStats = z.infer<typeof EngineStreamStatsSchema>;

/** One stream as started (step 9 adds the optional fields). */
export const EngineStartStreamSchema = z.looseObject({
  kind: StreamKindSchema,
  encoder: EncoderInfoSchema,
  streamId: Id.optional(),
  codec: z.string().optional(),
  /** Video: encoded size (≤ 2560 × 1440, §8) and the source size it came from. */
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  sourceWidth: z.int().positive().optional(),
  sourceHeight: z.int().positive().optional(),
  sampleRate: z.int().positive().optional(),
  channels: z.int().positive().optional(),
});

/**
 * Engine ↔ media utility clock handshake (§9.5), measured at `engine.start` over the clock port.
 * `offsetUs` is utility clock − engine clock (see `estimateClockOffset`). To map a utility-clock
 * time (pw-record system audio) to the engine's session clock, add `externalClockOffsetUs`
 * (`= −offsetUs`); pass it as `externalClockOffsetUs` to the sync calibrator. To map an engine
 * session time (a pause) to the utility clock, add `offsetUs`.
 */
export const EngineClockSchema = z.object({
  offsetUs: z.number(),
  externalClockOffsetUs: z.number(),
  rttUs: z.number().nonnegative(),
  samples: z.int().nonnegative(),
});
export type EngineClock = z.infer<typeof EngineClockSchema>;

export const EngineStartResultSchema = z.object({
  /** Session clock t0 in µs (`performance.timeOrigin + performance.now()`). */
  t0Us: z.number(),
  streams: z.array(EngineStartStreamSchema),
  /** Added in step 9: null when no clock port was sent or the utility did not answer. */
  clock: EngineClockSchema.nullable().optional(),
  /** `clock.offsetUs` (utility − engine), flattened for the session manager; absent without a clock. */
  utilityClockOffsetUs: z.number().optional(),
});

const TrackOffsetStatsSchema = z.object({
  samples: z.int().nonnegative(),
  medianUs: z.number(),
  lowUs: z.number(),
  spreadUs: z.number(),
  minUs: z.number(),
  maxUs: z.number(),
  stable: z.boolean(),
});

/** The sync calibrator's decision for one engine track (hybrid mode, §9.2). */
export const EngineStreamSyncSchema = z.object({
  mode: z.enum(['shared', 'arrival-calibrated']),
  /** `sessionUs = mediaTimestampUs + offsetUs` (absolute session clock). */
  offsetUs: z.int(),
  clockHandshakeUs: z.int().nullable(),
  reason: z.string(),
  stats: TrackOffsetStatsSchema,
});

/**
 * Everything the session manager needs for one stream's `RecordedStream` (step 9). Fields that
 * can be unknown are omitted rather than null.
 */
export const EngineStreamResultSchema = EngineStreamStatsSchema.extend({
  streamId: Id,
  /** `empty`: nothing was encoded; `failed`: encoder or muxer error (finalized early if possible). */
  status: z.enum(['ok', 'ended-early', 'failed', 'empty']),
  /** The track ended before stop (device unplugged, stop-sharing); R1.16. */
  endedEarly: z.boolean(),
  /** Session clock (absolute µs) when the stream stopped taking input. */
  endedAtUs: z.number().optional(),
  error: z.string().optional(),
  encoder: EncoderInfoSchema.optional(),
  codec: z.string().optional(),
  /** First stored sample's media timestamp (µs, the track's own clock). */
  firstTimestampUs: z.number().optional(),
  /** `RecordedStream.startOffsetUs`: µs since t0 of the file's first sample. */
  startOffsetUs: z.int().optional(),
  /** The calibrator's full decision (for `logs/recording.json`). */
  sync: EngineStreamSyncSchema.optional(),
  /** `RecordedStream.sync` (the subset of `sync` the manifest stores). */
  calibration: z
    .object({
      mode: z.enum(['shared', 'arrival-calibrated']),
      offsetUs: z.int(),
      clockHandshakeUs: z.int().nullable(),
    })
    .optional(),
  /** Audio: the checkpoints' sample rate (`sync.json` `nominalRate`). */
  nominalRate: z.int().positive().optional(),
  video: z
    .object({
      /** Encoded size (≤ 2560 × 1440, §8). */
      width: z.int().positive(),
      height: z.int().positive(),
      sourceWidth: z.int().positive(),
      sourceHeight: z.int().positive(),
      /** The requested rate (`Media.video.frameRateNominal`); the file itself is VFR. */
      frameRate: z.number().positive(),
      deliveredFps: z.number().positive().nullable(),
    })
    .optional(),
  audio: z
    .object({
      sampleRate: z.int().positive(),
      channels: z.int().positive(),
      samplesWritten: z.int().nonnegative(),
      /** Silence written for pauses and gaps. */
      silenceSamples: z.int().nonnegative(),
    })
    .optional(),
  /** Audio: every drift checkpoint of the stream (the full `sync.json` content). */
  checkpoints: z.array(CheckpointSchema),
  /**
   * Mic: a second checkpoint series from the chunks' capture timestamps (mapped to session time
   * with the final offset) instead of their arrival, for offline comparison only
   * (`media/mic.sync-capture.json`; not used by the drift fit).
   */
  captureCheckpoints: z.array(CheckpointSchema).optional(),
  /** The media utility's writer counters from its `closed` reply. */
  writer: z
    .looseObject({ bytesWritten: z.int().nonnegative(), size: z.int().nonnegative() })
    .optional(),
});
export type EngineStreamResult = z.infer<typeof EngineStreamResultSchema>;

export const EngineStopResultSchema = z.object({
  streams: z.array(EngineStreamResultSchema),
  /** Added in step 9. */
  t0Us: z.number().optional(),
  stoppedAtUs: z.number().optional(),
  /** Pauses in absolute session µs (subtract t0 for the manifest). */
  pauses: z.array(z.object({ startUs: z.number(), endUs: z.number() })).optional(),
  calibration: z
    .object({
      policy: z.enum(['hybrid', 'shared-preferred', 'arrival-only']),
      /** Engine tracks only; the session manager folds in system audio. */
      clockMode: z.enum(['shared-capture', 'arrival-calibrated']),
      sharedOffsetUs: z.int().nullable(),
    })
    .optional(),
});

const AtSchema = z.strictObject({ atUs: z.number().optional() });

/** PNG bytes (a `Uint8Array`, or Node's `Buffer` subclass after IPC). */
const PngBytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'expected bytes');

/**
 * The current frame of the acquired screen, for the region picker (§4.3.7, R1.9). Sizes are
 * stream pixels.
 */
export const EngineSnapshotResultSchema = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
  png: PngBytes,
});

export const ENGINE_COMMANDS = {
  'engine.acquire': { request: EngineAcquireSchema, response: EngineAcquireResultSchema },
  'engine.start': { request: EngineStartSchema, response: EngineStartResultSchema },
  'engine.pause': { request: AtSchema, response: z.object({ atUs: z.number() }) },
  'engine.resume': { request: AtSchema, response: z.object({ atUs: z.number() }) },
  'engine.stop': {
    request: z.strictObject({ reason: z.enum(['stop', 'restart', 'abort']) }),
    response: EngineStopResultSchema,
  },
  /** Added in step 11: the screen's current frame for the region picker. */
  'engine.snapshot': { request: z.strictObject({}), response: EngineSnapshotResultSchema },
} as const;

export type EngineCommandChannel = keyof typeof ENGINE_COMMANDS;
export type EngineCommandPayload<C extends EngineCommandChannel> = z.output<
  (typeof ENGINE_COMMANDS)[C]['request']
>;
export type EngineCommandResponse<C extends EngineCommandChannel> = z.output<
  (typeof ENGINE_COMMANDS)[C]['response']
>;

/** What main sends on an engine command channel. */
export interface EngineCommandEnvelope<C extends EngineCommandChannel = EngineCommandChannel> {
  requestId: number;
  payload: EngineCommandPayload<C>;
}

export const EngineReplySchema = z.discriminatedUnion('ok', [
  z.object({ requestId: z.int().nonnegative(), ok: z.literal(true), value: z.unknown() }),
  z.object({
    requestId: z.int().nonnegative(),
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string().optional() }),
  }),
]);
export type EngineReply = z.infer<typeof EngineReplySchema>;

/** Engine → main messages (`ipcRenderer.send`). */
export const ENGINE_EVENTS = {
  'engine.ready': z.undefined(),
  'engine.reply': EngineReplySchema,
  'engine.stats': z.object({ atUs: z.number(), streams: z.array(EngineStreamStatsSchema) }),
  'engine.trackEnded': z.object({
    kind: StreamKindSchema,
    reason: z.enum(['ended', 'error']),
    atUs: z.number(),
    message: z.string().optional(),
  }),
  /** Added in step 11: mic peak (linear 0–1) at about 15 Hz while recording (R1.12 meters). */
  'engine.levels': z.object({ atUs: z.number(), mic: z.number().min(0) }),
} as const;

export type EngineEventChannel = keyof typeof ENGINE_EVENTS;
export type EngineEventPayload<C extends EngineEventChannel> = z.output<(typeof ENGINE_EVENTS)[C]>;

/**
 * `engine.ports` (main → engine, with `MessagePort`s). Ports are transferred in the order of
 * `streams`, followed by the clock port when `clockPort` is true. In the engine's main world they
 * arrive as a same-window `message` event whose `data.type` is `ENGINE_PORTS_MESSAGE`, with the
 * ports in `event.ports` (contextBridge cannot carry ports).
 */
export const EnginePortsSchema = z.object({
  sessionId: Id,
  streams: z.array(z.object({ streamId: Id, kind: StreamKindSchema })),
  clockPort: z.boolean(),
});
export type EnginePorts = z.infer<typeof EnginePortsSchema>;

export { ENGINE_PORTS_MESSAGE, type EnginePortsWindowMessage } from './engine-window';
