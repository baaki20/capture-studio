/**
 * Projects for editor tests, built the way the recorder builds them (`projectFromRecording`):
 * Screen, Face + Voice (linked) and System audio, with pauses as separate clips. IDs are
 * deterministic (`clp_T0001`, …), so tests can compare documents.
 */
import type { ObjectPatch } from '../../src/shared/project/object-patch';
import { importedMediaEntry, importedTracks } from '../../src/shared/project/media-import';
import { newObject } from '../../src/shared/project/objects';
import fc from 'fast-check';
import {
  projectFromRecording,
  type RecordedStream,
  type Span,
} from '../../src/shared/project/from-recording';
import type { NRect, Project } from '../../src/shared/project/schema';
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
export function recordedProject(options: RecordedProjectOptions = {}): Project {
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

export function trackByName(doc: Project, name: string) {
  const track = doc.timeline.tracks.find((t) => t.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track;
}

/** Random recorded projects: 10–120 s, up to 3 pauses, optional camera/mic/system. */
export const arbRecordedProject: fc.Arbitrary<Project> = fc
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
  'layout-style',
  'crop',
  'keyframe',
  'keyframe-remove',
  'keyframe-move',
  'face-mode',
  'beautify',
  'camera-key',
  'camera-key-remove',
  'camera-key-move',
  'camera-zoom',
  'object-add',
  'object-update',
  'object-remove',
  'object-move',
  'object-key',
  'object-track',
  'speed',
  'freeze',
  'transition',
  'marker-add',
  'marker-update',
  'marker-remove',
  'clip-audio',
  'volume-key',
  'volume-key-remove',
  'cleanup',
  'add-media',
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
export function resolveOp(doc: Project, t: OpTemplate): TimelineOp {
  const clips = doc.timeline.tracks.flatMap((tr) => tr.clips);
  const tracks = doc.timeline.tracks;
  const duration = Math.max(1, timelineDurationUs(doc));
  const time = (f: number) => Math.round(f * duration * 1.1);
  const clip = clips[Math.floor(t.a * clips.length)];
  const clipId = clip?.id ?? 'clp_none';
  const track = tracks[Math.floor(t.a * tracks.length)];
  const trackId = track?.id ?? 'trk_none';
  // Face edits mostly go to the overlay track (sometimes to another, which they must refuse).
  const face = tracks.find((tr) => tr.type === 'video' && tr.layout.kind === 'overlay');
  const faceId = t.c < 0.9 ? (face?.id ?? trackId) : trackId;
  const faceKeys = face?.type === 'video' ? (face.layoutKeyframes ?? []) : [];
  const keyTime = (f: number) => faceKeys[Math.floor(f * faceKeys.length)]?.tUs ?? time(f);
  const modes = ['overlay', 'full', 'side-by-side', 'hidden'] as const;
  const easings = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'] as const;
  const pick = <T>(list: readonly T[], f: number): T => list[Math.floor(f * list.length)] as T;
  const cameraKeys = doc.timeline.camera ?? [];
  const cameraTime = (f: number) => cameraKeys[Math.floor(f * cameraKeys.length)]?.tUs ?? time(f);
  const objects = (doc.timeline.objectTracks ?? []).flatMap((track) => track.items);
  const objectOf = (f: number) => objects[Math.floor(f * objects.length)]?.id ?? 'obj_none';
  const kinds = [
    'text',
    'arrow',
    'rectangle',
    'ellipse',
    'step',
    'highlight',
    'spotlight',
    'blur',
    'pixelate',
  ] as const;
  // Camera rects partly outside the canvas or too small (the operations clamp them).
  const cameraRect = (f: number, g: number) => ({
    x: f * 1.2 - 0.1,
    y: g,
    width: 0.1 + g * 0.95,
    height: 0.1 + f * 0.95,
  });
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
    case 'layout-style':
      return {
        type: 'setLayout',
        trackId: faceId,
        layout: {
          zoom: 0.5 + t.b * 4,
          // Within the schema's ranges (the operation clamps the rest of the way).
          border: t.flag ? null : { width: t.c * 0.05, color: '#FFFFFF' },
          shadow:
            t.b < 0.3
              ? null
              : { blur: t.b * 0.1, offsetX: t.c * 0.1 - 0.05, offsetY: 0.02, color: '#00000099' },
        },
      };
    case 'keyframe':
      return {
        type: 'setLayoutKeyframe',
        trackId: faceId,
        tUs: t.flag ? keyTime(t.b) : time(t.b),
        mode: pick(modes, t.b),
        easing: pick(easings, (t.b * 7) % 1),
        ...(t.c < 0.5 ? { layout: { centerX: t.c, width: 0.1 + t.c * 0.3 } } : {}),
      };
    case 'keyframe-remove':
      return { type: 'removeLayoutKeyframe', trackId: faceId, tUs: keyTime(t.b) };
    case 'keyframe-move':
      return {
        type: 'moveLayoutKeyframe',
        trackId: faceId,
        fromUs: keyTime(t.b),
        toUs: time(t.c),
      };
    case 'face-mode': {
      const x = time(Math.min(t.b, t.c));
      const y = time(Math.max(t.b, t.c));
      return {
        type: 'setFaceMode',
        trackId: faceId,
        startUs: x,
        endUs: y === x ? x + 1 : y,
        mode: pick(modes, t.b),
        easeUs: t.flag ? 0 : Math.round(t.c * 2_500_000),
      };
    }
    case 'beautify':
      return t.c < 0.2
        ? { type: 'setBeautify', beautify: null }
        : {
            type: 'setBeautify',
            beautify: {
              background: t.flag
                ? { type: 'color', color: '#203040' }
                : { type: 'gradient', from: '#4F46E5', to: '#DB2777', angleDeg: t.b * 360 },
              padding: t.b * 0.3,
              cornerRadius: t.c * 0.2,
              ...(t.b < 0.5
                ? { shadow: { blur: t.c * 0.1, offsetX: 0, offsetY: 0.01, color: '#00000066' } }
                : {}),
            },
          };
    case 'camera-key':
      return {
        type: 'setCameraKeyframe',
        tUs: t.flag ? cameraTime(t.a) : time(t.a),
        ...(t.c < 0.7 ? { rect: cameraRect(t.b, t.c) } : {}),
        ...(t.b < 0.5 ? { easing: pick(easings, t.c) } : {}),
      };
    case 'camera-key-remove':
      return { type: 'removeCameraKeyframe', tUs: cameraTime(t.b) };
    case 'camera-key-move':
      return { type: 'moveCameraKeyframe', fromUs: cameraTime(t.b), toUs: time(t.c) };
    case 'camera-zoom': {
      const x = time(Math.min(t.b, t.c));
      const y = time(Math.max(t.b, t.c));
      return {
        type: 'setCameraZoom',
        startUs: x,
        endUs: y === x ? x + 1 : y,
        rect: cameraRect(t.a, t.b),
        easeUs: t.flag ? 0 : Math.round(t.c * 2_500_000),
      };
    }
    case 'object-add': {
      const inUs = time(t.b);
      return {
        type: 'addObject',
        item: newObject(
          pick(kinds, t.a),
          `obj_F${String(Math.round(t.a * 1e9))}${String(Math.round(t.c * 1e6))}`,
          inUs,
          inUs + Math.round(t.c * 4_000_000),
          { x: t.c * 0.8, y: t.b * 0.8, width: 0.05 + t.a * 0.2, height: 0.05 + t.b * 0.2 },
        ),
      };
    }
    case 'object-update': {
      const patches: ObjectPatch[] = [
        { inUs: time(t.b) },
        { outUs: time(t.c) },
        { box: { x: t.b, y: t.c, width: 0.1, height: 0.1 } },
        { opacity: t.flag ? null : t.c },
        { fadeInUs: t.flag ? null : Math.round(t.c * 1e6) },
        { text: 'Hello', style: { size: t.c * 0.6, background: t.flag ? null : '#000000' } },
        // Within the stroke schema's range (the op schema checks it).
        { stroke: { color: '#FF0000', width: t.c * 0.05 } },
        { radius: t.c * 0.06 },
        { value: Math.round(t.c * 1200) },
        { dim: t.c },
      ];
      return { type: 'updateObject', objectId: objectOf(t.a), patch: pick(patches, t.b) };
    }
    case 'object-remove':
      return { type: 'removeObjects', objectIds: [objectOf(t.a)] };
    case 'object-move':
      return { type: 'moveObject', objectId: objectOf(t.a), toInUs: time(t.b) };
    case 'object-key':
      return {
        type: 'setObjectKeyframe',
        objectId: objectOf(t.a),
        tUs: time(t.b),
        ...(t.flag ? { box: { x: t.c * 0.5, y: 0.2, width: 0.2, height: 0.2 } } : {}),
      };
    case 'object-track': {
      const track = doc.timeline.objectTracks?.[0];
      return {
        type: 'setObjectTrack',
        trackId: track?.id ?? 'trk_none',
        // Mostly unlocked, so edits keep reaching the objects.
        locked: t.flag && t.c < 0.3,
        hidden: t.b < 0.3,
      };
    }
    case 'speed': {
      const x = time(Math.min(t.b, t.c));
      const y = time(Math.max(t.b, t.c));
      const speeds = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
      return { type: 'setSpeed', inUs: x, outUs: y === x ? x + 1 : y, speed: pick(speeds, t.a) };
    }
    case 'freeze':
      return { type: 'freezeFrame', atUs: time(t.b), durationUs: Math.round(t.c * 3_000_000) };
    case 'transition': {
      const kinds = ['fade-color', 'dissolve', 'slide'] as const;
      return {
        type: 'setTransition',
        clipId,
        transition: t.flag
          ? null
          : {
              kind: pick(kinds, t.b),
              durationUs: 1 + Math.round(t.c * 2_000_000),
              ...(t.b < 0.3 ? { color: '#FFFFFF' } : {}),
              ...(t.b > 0.7 ? { direction: 'left' as const } : {}),
            },
      };
    }
    case 'marker-add':
      return {
        type: 'addMarker',
        marker: {
          id: `mrk_F${String(Math.round(t.a * 1e9))}`,
          tUs: time(t.b),
          label: t.flag ? 'Intro' : '',
          chapter: t.c < 0.5,
        },
      };
    case 'marker-update': {
      const markers = doc.timeline.markers ?? [];
      const id = markers[Math.floor(t.a * markers.length)]?.id ?? 'mrk_none';
      return { type: 'updateMarker', markerId: id, tUs: time(t.b), chapter: t.flag };
    }
    case 'marker-remove': {
      const markers = doc.timeline.markers ?? [];
      return {
        type: 'removeMarker',
        markerId: markers[Math.floor(t.a * markers.length)]?.id ?? 'mrk_none',
      };
    }
    case 'clip-audio':
      return {
        type: 'setClipAudio',
        clipIds: [clipId],
        gainDb: t.flag ? null : -30 + t.b * 50,
        fadeInUs: Math.round(t.c * 4_000_000),
        ...(t.b < 0.5 ? { fadeOutUs: t.flag ? null : Math.round(t.b * 3_000_000) } : {}),
      };
    case 'volume-key': {
      const audio = tracks.filter((tr) => tr.type === 'audio');
      const target = audio[Math.floor(t.a * audio.length)]?.id ?? trackId;
      return {
        type: 'setVolumeKeyframe',
        trackId: t.c < 0.9 ? target : trackId,
        tUs: time(t.b),
        ...(t.flag ? { gainDb: -70 + t.c * 90 } : {}),
        ...(t.b < 0.5 ? { easing: pick(easings, t.c) } : {}),
      };
    }
    case 'volume-key-remove': {
      const audio = tracks.find((tr) => tr.type === 'audio' && tr.volumeKeyframes?.length);
      const keys = audio?.type === 'audio' ? (audio.volumeKeyframes ?? []) : [];
      return {
        type: 'removeVolumeKeyframe',
        trackId: audio?.id ?? trackId,
        tUs: keys[Math.floor(t.b * keys.length)]?.tUs ?? time(t.b),
      };
    }
    case 'cleanup': {
      const audio = tracks.filter((tr) => tr.type === 'audio');
      const target = audio[Math.floor(t.a * audio.length)]?.id ?? trackId;
      const other = audio[Math.floor(t.c * audio.length)]?.id ?? trackId;
      const noises = ['off', 'light', 'strong'] as const;
      return {
        type: 'setCleanup',
        trackId: target,
        cleanup: {
          noise: pick(noises, t.b),
          normalize: t.flag,
          ...(t.c < 0.5
            ? {
                duck:
                  t.b < 0.3
                    ? null
                    : { byTrackId: other, amountDb: -60 + t.b * 70, attackMs: 50, releaseMs: 9000 },
              }
            : {}),
        },
      };
    }
    case 'add-media': {
      const id = `med_F${String(Math.round(t.a * 1e9))}`;
      const still = t.flag;
      return {
        type: 'addMedia',
        media: [
          importedMediaEntry(id, 'media/import.mp4', {
            kind: 'video',
            durationUs: still ? 33_334 : 1 + Math.round(t.c * 5_000_000),
            video: { codec: 'h264', width: 640, height: 360, frameRateNominal: 30 },
          }),
        ],
        tracks: importedTracks('import', [
          {
            mediaId: id,
            kind: 'video',
            still,
            durationUs: still ? 33_334 : 1 + Math.round(t.c * 5_000_000),
          },
        ]),
        atUs: time(t.b),
      };
    }
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
