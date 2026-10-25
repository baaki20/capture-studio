/**
 * Projects for editor tests, built the way the recorder builds them (`projectFromRecording`):
 * Screen, Face + Voice (linked) and System audio, with pauses as separate clips. IDs are
 * deterministic (`clp_T0001`, …), so tests can compare documents.
 */
import fc from 'fast-check';
import {
  projectFromRecording,
  type RecordedStream,
  type Span,
} from '../../src/shared/project/from-recording';
import type { NRect, ProjectV1 } from '../../src/shared/project/schema';
import { timelineDurationUs, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';

export function counterIds(prefix = 'T'): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(4, '0')}`;
}

export interface RecordedProjectOptions {
  durationUs?: number;
  pauses?: Span[];
  camera?: boolean;
  mic?: boolean;
  system?: boolean;
  region?: NRect | null;
  screenSize?: { width: number; height: number };
  cameraSize?: { width: number; height: number };
  offsets?: Partial<Record<RecordedStream['role'], number>>;
  frameRate?: 24 | 25 | 30 | 50 | 60;
}

function stream(
  role: RecordedStream['role'],
  durationUs: number,
  startOffsetUs: number,
  size: { width: number; height: number } | null,
): RecordedStream {
  return {
    role,
    path: `media/${role}.mp4`,
    status: 'ok',
    durationUs: Math.max(0, durationUs - startOffsetUs),
    startOffsetUs,
    clockRatio: role === 'microphone' ? 1.0000183 : role === 'system-audio' ? 0.999995 : 1,
    endedEarly: false,
    sync: {
      mode: size ? 'shared' : 'arrival-calibrated',
      offsetUs: 0,
      clockHandshakeUs: null,
    },
    ...(size
      ? {
          video: {
            codec: 'avc1.640028',
            width: size.width,
            height: size.height,
            frameRateNominal: 30,
            variableFrameRate: true,
          },
        }
      : {
          audio: {
            codec: 'opus',
            sampleRate: 48_000,
            channels: role === 'microphone' ? 1 : 2,
            discontinuities: 0,
          },
        }),
  };
}

/** Default: 60 s session, pause [20 s, 25 s), all four streams. */
export function recordedProject(options: RecordedProjectOptions = {}): ProjectV1 {
  const durationUs = options.durationUs ?? 60_000_000;
  const screenSize = options.screenSize ?? { width: 1920, height: 1080 };
  const offsets = {
    screen: 2_200,
    camera: 40_000,
    microphone: 12_800,
    'system-audio': 9_900,
    ...options.offsets,
  };
  const streams: RecordedStream[] = [stream('screen', durationUs, offsets.screen, screenSize)];
  if (options.camera ?? true) {
    streams.push(
      stream(
        'camera',
        durationUs,
        offsets.camera,
        options.cameraSize ?? { width: 1280, height: 720 },
      ),
    );
  }
  if (options.mic ?? true) streams.push(stream('microphone', durationUs, offsets.microphone, null));
  if (options.system ?? true) {
    streams.push(stream('system-audio', durationUs, offsets['system-audio'], null));
  }
  return unwrap(
    projectFromRecording(
      {
        version: 1,
        projectId: 'prj_01JBQ4ZJ4X6V3K8N2M7P5R9T0W',
        name: 'Lesson test',
        createdAt: '2026-10-24T09:00:00.000Z',
        appVersion: '0.1.0',
        frameRate: options.frameRate ?? 30,
        recording: {
          state: 'complete',
          sessionId: 'ses_01JBQ4ZJ4Y0000000000000000',
          startedAt: '2026-10-24T09:00:00.500Z',
          durationUs,
          pauses: options.pauses ?? [{ startUs: 20_000_000, endUs: 25_000_000 }],
          source: {
            kind: 'monitor',
            widthPx: screenSize.width,
            heightPx: screenSize.height,
            region: options.region ?? null,
          },
          platform: {
            os: 'linux',
            session: 'wayland',
            electron: '45.0.0',
            chromium: '156.0.0.0',
            ffmpeg: 'n9.0',
          },
        },
        streams,
      },
      { generateId: counterIds('R'), now: () => new Date('2026-10-24T09:05:00.000Z') },
    ),
  );
}

export function trackByName(doc: ProjectV1, name: string) {
  const track = doc.timeline.tracks.find((t) => t.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track;
}

/** Random recorded projects: 10–120 s, up to 3 pauses, optional camera/mic/system. */
export const arbRecordedProject: fc.Arbitrary<ProjectV1> = fc
  .record({
    durationS: fc.integer({ min: 10, max: 120 }),
    pauses: fc.array(
      fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 1, max: 8 })),
      {
        maxLength: 3,
      },
    ),
    camera: fc.boolean(),
    mic: fc.boolean(),
    system: fc.boolean(),
    cameraOffset: fc.integer({ min: 0, max: 900_000 }),
    micOffset: fc.integer({ min: 0, max: 900_000 }),
    frameRate: fc.constantFrom(24 as const, 30 as const, 60 as const),
  })
  .map((r) => {
    const durationUs = r.durationS * 1_000_000;
    return recordedProject({
      durationUs,
      pauses: r.pauses.map(([at, len]) => {
        const startUs = Math.round(at * durationUs);
        return { startUs, endUs: startUs + len * 1_000_000 };
      }),
      camera: r.camera,
      mic: r.mic,
      system: r.system,
      offsets: { camera: r.cameraOffset, microphone: r.micOffset },
      frameRate: r.frameRate,
    });
  });

// ---------------------------------------------------------------------------------------------
// Random operations, resolved against the current document

const OP_KINDS = [
  'split-selected',
  'split-playhead',
  'trim-start',
  'trim-end',
  'move',
  'delete',
  'ripple',
  'cut',
  'gain',
  'mute',
  'solo',
  'hide',
  'lock',
  'layout',
  'crop',
  'nudge',
  'unlink',
  'relink',
  'marks',
] as const;

export interface OpTemplate {
  kind: (typeof OP_KINDS)[number];
  a: number;
  b: number;
  c: number;
  flag: boolean;
}

/** A fraction in [0, 1): mostly unbiased (fast-check otherwise favours 0), sometimes an edge. */
const fraction: fc.Arbitrary<number> = fc.oneof(
  {
    arbitrary: fc.noBias(fc.integer({ min: 0, max: 999_999 })).map((n) => n / 1_000_000),
    weight: 5,
  },
  { arbitrary: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), weight: 1 },
);

export const arbOpTemplate: fc.Arbitrary<OpTemplate> = fc.record({
  kind: fc.constantFrom(...OP_KINDS),
  a: fraction,
  b: fraction,
  c: fraction,
  flag: fc.boolean(),
});

/** Turns a template into a concrete op for `doc` (clip and track picked by fraction). */
export function resolveOp(doc: ProjectV1, t: OpTemplate): TimelineOp {
  const clips = doc.timeline.tracks.flatMap((tr) => tr.clips);
  const tracks = doc.timeline.tracks;
  const duration = Math.max(1, timelineDurationUs(doc));
  const time = (f: number) => Math.round(f * duration * 1.1);
  const clip = clips[Math.floor(t.a * clips.length)];
  const clipId = clip?.id ?? 'clp_none';
  const track = tracks[Math.floor(t.a * tracks.length)];
  const trackId = track?.id ?? 'trk_none';
  switch (t.kind) {
    case 'split-selected':
      return { type: 'split', atUs: time(t.b), clipIds: [clipId], includeLinked: t.flag };
    case 'split-playhead':
      return { type: 'split', atUs: time(t.b) };
    case 'trim-start':
      return { type: 'trim', clipId, edge: 'start', toUs: time(t.b), includeLinked: t.flag };
    case 'trim-end':
      return { type: 'trim', clipId, edge: 'end', toUs: time(t.b), includeLinked: t.flag };
    case 'move':
      return { type: 'move', clipId, toStartUs: time(t.b), includeLinked: t.flag };
    case 'delete':
      return { type: 'delete', clipIds: [clipId], includeLinked: t.flag };
    case 'ripple':
      return { type: 'rippleDelete', clipIds: [clipId], includeLinked: t.flag };
    case 'cut': {
      const x = time(Math.min(t.b, t.c));
      const y = time(Math.max(t.b, t.c));
      return { type: 'cutRange', inUs: x, outUs: y === x ? x + 1 : y };
    }
    case 'gain':
      return { type: 'setGain', trackId, gainDb: -80 + t.b * 100 };
    case 'mute':
      return { type: 'setMuted', trackId, muted: t.flag };
    case 'solo':
      return { type: 'setSolo', trackId, solo: t.flag };
    case 'hide':
      return { type: 'setHidden', trackId, hidden: t.flag };
    case 'lock':
      // Locks are rarer than other edits, so unlock most of the time.
      return { type: 'setLocked', trackId, locked: t.flag && t.c < 0.3 };
    case 'layout':
      return {
        type: 'setLayout',
        trackId,
        layout: {
          centerX: t.b * 1.4 - 0.2,
          centerY: t.c,
          width: t.c * 0.7,
          shape: t.flag ? 'circle' : t.b < 0.5 ? 'rounded' : 'rectangle',
          cornerRadius: t.b,
          mirror: t.flag,
        },
      };
    case 'crop':
      return {
        type: 'setLayout',
        trackId,
        layout: {
          crop: t.flag
            ? null
            : {
                x: Math.round(t.b * 2000),
                y: Math.round(t.c * 1200),
                width: 1 + Math.round(t.c * 3000),
                height: 1 + Math.round(t.b * 2000),
              },
        },
      };
    case 'nudge': {
      const component = doc.components[Math.floor(t.a * doc.components.length)];
      return {
        type: 'nudge',
        target: { componentId: component?.id ?? 'cmp_none' },
        syncAdjustUs: Math.round((t.b - 0.5) * 5_000_000),
      };
    }
    case 'unlink':
      return { type: 'unlink', clipIds: [clipId] };
    case 'relink': {
      const other = clips[Math.floor(t.c * clips.length)];
      return { type: 'relink', clipIds: [clipId, other?.id ?? clipId] };
    }
    case 'marks': {
      const x = time(Math.min(t.b, t.c));
      const y = time(Math.max(t.b, t.c));
      return t.flag
        ? { type: 'setMarks', inUs: x, outUs: y }
        : { type: 'setMarks', inUs: null, outUs: null };
    }
  }
}
