import { describe, expect, it } from 'vitest';
import { checkProjectInvariants } from '../../src/shared/project/invariants';
import {
  RecordingManifestSchema,
  activeIntervals,
  defaultCanvasSize,
  normalizePauses,
  projectFromRecording,
  screenCrop,
  sessionToTimelineUs,
  type RecordedStream,
  type RecordingManifest,
} from '../../src/shared/project/from-recording';
import {
  ProjectV1Schema,
  type Clip,
  type ProjectV1,
  type Track,
} from '../../src/shared/project/schema';
import { unwrap } from '../../src/shared/result';

function counterIds(): () => string {
  let n = 0;
  return () => `T${String(++n).padStart(4, '0')}`;
}

const OPTIONS = { generateId: counterIds, now: () => new Date('2026-10-24T14:20:00.000Z') };

function build(manifest: RecordingManifest): ProjectV1 {
  return unwrap(projectFromRecording(manifest, { ...OPTIONS, generateId: counterIds() }));
}

function stream(
  role: RecordedStream['role'],
  overrides: Partial<RecordedStream> = {},
): RecordedStream {
  const video = role === 'screen' || role === 'camera';
  return {
    role,
    path: `media/${role}.mp4`,
    status: 'ok',
    durationUs: 754_000_000,
    startOffsetUs: 0,
    clockRatio: 1,
    endedEarly: false,
    sync: {
      mode: video ? 'shared' : 'arrival-calibrated',
      offsetUs: 1_000,
      clockHandshakeUs: role === 'system-audio' ? 800 : null,
    },
    ...(video
      ? {
          video: {
            codec: 'avc1.640028',
            width: role === 'screen' ? 1920 : 1280,
            height: role === 'screen' ? 1080 : 720,
            frameRateNominal: 30,
            variableFrameRate: true,
          },
          encoder: { name: 'H.264 (software)', hardware: false },
        }
      : {
          audio: {
            codec: 'opus',
            sampleRate: 48_000,
            channels: role === 'microphone' ? 1 : 2,
            syncCheckpointsPath: `media/${role}.sync.json`,
            discontinuities: 0,
          },
        }),
    ...overrides,
  };
}

/** 754 s session with one pause [120 s, 135.5 s) (the spec §4.4.2 example). */
function manifest(streams: RecordedStream[] = defaultStreams()): RecordingManifest {
  return {
    version: 1,
    projectId: 'prj_01JBQ4ZJ4X6V3K8N2M7P5R9T0W',
    name: 'Lesson 2026-10-24 14-05',
    createdAt: '2026-10-24T14:05:12.345Z',
    appVersion: '0.1.0',
    recording: {
      state: 'complete',
      sessionId: 'ses_01JBQ4ZJ4Y0000000000000000',
      startedAt: '2026-10-24T14:05:15.002Z',
      durationUs: 754_000_000,
      pauses: [{ startUs: 120_000_000, endUs: 135_500_000 }],
      source: {
        kind: 'monitor',
        widthPx: 1920,
        heightPx: 1080,
        region: { x: 100, y: 50, width: 1280, height: 720 },
      },
      platform: {
        os: 'linux',
        session: 'wayland',
        desktop: 'GNOME',
        electron: '45.0.0',
        chromium: '156.0.8078.48',
        ffmpeg: 'n9.0.2',
      },
    },
    frameRate: 30,
    streams,
  };
}

function defaultStreams(): RecordedStream[] {
  return [
    stream('screen', { startOffsetUs: 8_000, durationUs: 754_000_000 - 8_000 }),
    stream('camera', { startOffsetUs: 41_200, durationUs: 753_900_000 }),
    stream('microphone', { startOffsetUs: 12_800, durationUs: 753_950_000, clockRatio: 1.0000183 }),
    stream('system-audio', { startOffsetUs: 9_900, durationUs: 753_980_000, clockRatio: 0.999995 }),
  ];
}

function track(project: ProjectV1, name: string): Track {
  const t = project.timeline.tracks.find((x) => x.name === name);
  if (!t) throw new Error(`no track ${name}`);
  return t;
}

/** Session instant shown at timeline time `t` by a clip containing it. */
function sessionAt(clips: Clip[], t: number): number | null {
  const c = clips.find(
    (x) => x.timelineStartUs <= t && t < x.timelineStartUs + (x.sourceEndUs - x.sourceStartUs),
  );
  return c ? c.sourceStartUs + (t - c.timelineStartUs) : null;
}

describe('projectFromRecording', () => {
  it('builds a valid project with screen, linked face + voice, and system audio', () => {
    const project = build(manifest());
    expect(ProjectV1Schema.safeParse(project).success).toBe(true);
    expect(checkProjectInvariants(project)).toEqual([]);
    expect(project.timeline.tracks.map((t) => `${t.type}:${t.name}`)).toEqual([
      'video:Screen',
      'video:Face',
      'audio:Voice',
      'audio:System audio',
    ]);
    expect(project.components.map((c) => c.type)).toEqual(['screen', 'face-voice', 'system-audio']);
    const face = project.components[1]!;
    expect(face.mediaIds).toEqual([project.media[1]!.id, project.media[2]!.id]);
    expect(track(project, 'Face').componentId).toBe(face.id);
    expect(track(project, 'Voice').componentId).toBe(face.id);
    expect(project.media.map((m) => [m.role, m.kind])).toEqual([
      ['screen', 'video'],
      ['camera', 'video'],
      ['microphone', 'audio'],
      ['system-audio', 'audio'],
    ]);
    expect(project.media[2]!.clockRatio).toBe(1.0000183);
    expect(project.modifiedAt).toBe('2026-10-24T14:20:00.000Z');
    expect(project.recording?.durationUs).toBe(754_000_000);
  });

  it('leaves out the paused span: one clip per active interval, at its synced position', () => {
    const project = build(manifest());
    const screen = track(project, 'Screen').clips;
    expect(screen.map((c) => [c.timelineStartUs, c.sourceStartUs, c.sourceEndUs])).toEqual([
      [8_000, 8_000, 120_000_000],
      [120_000_000, 135_500_000, 754_000_000],
    ]);
    // Every track shows the same session instant at the same timeline time.
    for (const t of [500_000, 60_000_000, 119_999_999, 120_000_000, 400_000_000, 738_000_000]) {
      const expected = sessionAt(screen, t);
      for (const name of ['Face', 'Voice', 'System audio']) {
        const s = sessionAt(track(project, name).clips, t);
        if (s !== null) expect(s).toBe(expected);
      }
    }
    // No clip covers paused session time.
    for (const tr of project.timeline.tracks) {
      for (const c of tr.clips) {
        expect(c.sourceEndUs <= 120_000_000 || c.sourceStartUs >= 135_500_000).toBe(true);
      }
    }
  });

  it('links camera and mic clips per interval with identical start and duration', () => {
    const project = build(manifest());
    const face = track(project, 'Face').clips;
    const voice = track(project, 'Voice').clips;
    expect(face).toHaveLength(2);
    expect(voice).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(face[i]!.linkId).not.toBeNull();
      expect(face[i]!.linkId).toBe(voice[i]!.linkId);
      expect(face[i]!.timelineStartUs).toBe(voice[i]!.timelineStartUs);
      expect(face[i]!.sourceEndUs - face[i]!.sourceStartUs).toBe(
        voice[i]!.sourceEndUs - voice[i]!.sourceStartUs,
      );
    }
    expect(face[0]!.linkId).not.toBe(face[1]!.linkId);
    // The common span starts at the later of the two (camera, 41.2 ms) and ends at the earlier;
    // the mic's 28 ms lead and 35 ms tail are device latency, not kept as slivers.
    expect(face[0]!.sourceStartUs).toBe(41_200);
    expect(voice[1]!.sourceEndUs).toBe(753_941_200);
    const slivers = projectFromRecording(manifest(), {
      ...OPTIONS,
      generateId: counterIds(),
      minUnlinkedRemainderUs: 0,
    });
    // With no minimum, the 35 ms tail (over one frame) becomes an unlinked clip.
    expect(slivers.ok && track(slivers.value, 'Voice').clips.length).toBe(3);
    expect(track(project, 'System audio').clips.every((c) => c.linkId === null)).toBe(true);
  });

  it('keeps the voice after the camera ends early, unlinked', () => {
    const streams = defaultStreams();
    streams[1] = stream('camera', {
      startOffsetUs: 41_200,
      durationUs: 300_000_000,
      endedEarly: true,
    });
    const project = build(manifest(streams));
    expect(checkProjectInvariants(project)).toEqual([]);
    const voice = track(project, 'Voice').clips;
    const face = track(project, 'Face').clips;
    expect(project.media[1]!.endedEarly).toBe(true);
    expect(face).toHaveLength(2);
    expect(face.every((c) => c.linkId !== null)).toBe(true);
    expect(face[1]!.sourceEndUs).toBe(300_041_200);
    expect(voice.map((c) => [c.sourceStartUs, c.sourceEndUs, c.linkId === null])).toEqual([
      [41_200, 120_000_000, false],
      [135_500_000, 300_041_200, false],
      [300_041_200, 753_976_597, true],
    ]);
  });

  it('handles mic-only and camera-only face-voice components without links', () => {
    const micOnly = build(manifest([stream('screen'), stream('microphone')]));
    expect(micOnly.timeline.tracks.map((t) => t.name)).toEqual(['Screen', 'Voice']);
    expect(micOnly.components[1]).toMatchObject({ type: 'face-voice' });
    expect(track(micOnly, 'Voice').clips.every((c) => c.linkId === null)).toBe(true);
    const camOnly = build(manifest([stream('screen'), stream('camera')]));
    expect(camOnly.timeline.tracks.map((t) => t.name)).toEqual(['Screen', 'Face']);
    expect(checkProjectInvariants(camOnly)).toEqual([]);
  });

  it('sizes the canvas from the region and uses it as the screen crop', () => {
    const project = build(manifest());
    expect(project.timeline.canvas).toEqual({
      width: 1280,
      height: 720,
      background: { type: 'color', color: '#000000' },
    });
    const screen = track(project, 'Screen');
    expect(screen.type === 'video' && screen.layout).toEqual({
      kind: 'screen',
      crop: { x: 100, y: 50, width: 1280, height: 720 },
      fit: 'contain',
    });
    const face = track(project, 'Face');
    if (face.type !== 'video' || face.layout.kind !== 'overlay') throw new Error('face layout');
    expect(face.layout.shape).toBe('circle');
    expect(face.layout.width).toBe(0.2);
    // Fully inside the canvas: right edge = centerX·W + 0.1·W ≤ W.
    expect(face.layout.centerX * 1280 + 0.1 * 1280).toBeLessThanOrEqual(1280);
    expect(face.layout.centerY * 720 + 0.1 * 1280).toBeLessThanOrEqual(720);
  });

  it('uses the full stream without a region, and scales the crop to the recorded size', () => {
    const full = manifest();
    full.recording.source.region = null;
    expect(build(full).timeline.canvas).toMatchObject({ width: 1920, height: 1080 });
    const screenLayout = track(build(full), 'Screen');
    expect(
      screenLayout.type === 'video' &&
        screenLayout.layout.kind === 'screen' &&
        screenLayout.layout.crop,
    ).toBe(null);

    // A 4K source recorded at 1440p (the §8 cap): the region is scaled into media pixels.
    const big = manifest();
    big.recording.source = {
      kind: 'monitor',
      widthPx: 3840,
      heightPx: 2160,
      region: { x: 300, y: 150, width: 3000, height: 1800 },
    };
    big.streams[0] = stream('screen', {
      video: {
        codec: 'avc1.640032',
        width: 2560,
        height: 1440,
        frameRateNominal: 30,
        variableFrameRate: true,
      },
    });
    const p = build(big);
    const s = track(p, 'Screen');
    expect(s.type === 'video' && s.layout.kind === 'screen' && s.layout.crop).toEqual({
      x: 200,
      y: 100,
      width: 2000,
      height: 1200,
    });
    expect(p.timeline.canvas).toMatchObject({ width: 2000, height: 1200 });
  });

  it('records sync modes per media, summarized in recording.clockMode', () => {
    const project = build(manifest());
    expect(project.recording?.clockMode).toBe('hybrid');
    expect(project.extensions).toEqual({});
    expect(project.media[0]!.sync).toEqual({ mode: 'shared', offsetUs: 1_000 });
    expect(project.media[2]!.sync?.mode).toBe('arrival-calibrated');
    expect(project.media[3]!.sync).toEqual({
      mode: 'arrival-calibrated',
      offsetUs: 1_000,
      clockHandshakeUs: 800,
    });
    const videoOnly = build(manifest([stream('screen'), stream('camera')]));
    expect(videoOnly.recording?.clockMode).toBe('shared-capture');
    const audioOnly = build(manifest([stream('microphone'), stream('system-audio')]));
    expect(audioOnly.recording?.clockMode).toBe('arrival-calibrated');
  });

  it('keeps media IDs the session manager assigned', () => {
    const streams = defaultStreams();
    streams[0] = { ...streams[0]!, mediaId: 'med_SCREEN1' };
    const project = build(manifest(streams));
    expect(project.media[0]!.id).toBe('med_SCREEN1');
    expect(track(project, 'Screen').clips[0]!.mediaId).toBe('med_SCREEN1');
  });

  it('creates no clips for an empty or failed stream', () => {
    const streams = defaultStreams();
    streams[3] = stream('system-audio', { status: 'failed', durationUs: 0 });
    const project = build(manifest(streams));
    expect(track(project, 'System audio').clips).toEqual([]);
    expect(checkProjectInvariants(project)).toEqual([]);
  });

  it('reports a project that fails validation', () => {
    const result = projectFromRecording(manifest(), {
      ...OPTIONS,
      generateId: counterIds(),
      faceLayout: { width: 0.9 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.issues.join('\n')).toMatch(/layout\.width/);
    }
  });

  it('validates the manifest with its schema', () => {
    expect(RecordingManifestSchema.safeParse(manifest()).success).toBe(true);
    const bad = { ...manifest(), streams: [{ ...stream('screen'), role: 'imported' }] };
    expect(RecordingManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('timeline helpers', () => {
  it('normalizes pauses: sorted, clamped, merged', () => {
    expect(
      normalizePauses(
        [
          { startUs: 50, endUs: 60 },
          { startUs: 10, endUs: 20 },
          { startUs: 15, endUs: 30 },
          { startUs: 40, endUs: 40 },
          { startUs: 90, endUs: 200 },
        ],
        100,
      ),
    ).toEqual([
      { startUs: 10, endUs: 30 },
      { startUs: 50, endUs: 60 },
      { startUs: 90, endUs: 100 },
    ]);
  });

  it('computes active intervals and timeline time', () => {
    const pauses = [
      { startUs: 10, endUs: 30 },
      { startUs: 50, endUs: 60 },
    ];
    expect(activeIntervals(100, pauses)).toEqual([
      { startUs: 0, endUs: 10 },
      { startUs: 30, endUs: 50 },
      { startUs: 60, endUs: 100 },
    ]);
    expect(activeIntervals(100, [{ startUs: 0, endUs: 100 }])).toEqual([]);
    expect(sessionToTimelineUs(pauses, 5)).toBe(5);
    expect(sessionToTimelineUs(pauses, 30)).toBe(10);
    expect(sessionToTimelineUs(pauses, 70)).toBe(40);
  });

  it('defaults the canvas to an even size capped at 3840 × 2160', () => {
    expect(defaultCanvasSize(1281, 721)).toEqual({ width: 1280, height: 720 });
    expect(defaultCanvasSize(7680, 4320)).toEqual({ width: 3840, height: 2160 });
    expect(defaultCanvasSize(2160, 7680)).toEqual({ width: 1080, height: 3840 });
    expect(defaultCanvasSize(40, 40)).toEqual({ width: 64, height: 64 });
  });

  it('passes the region through when the media matches the source', () => {
    const region = { x: 1, y: 2, width: 64, height: 64 };
    expect(
      screenCrop(region, { widthPx: 100, heightPx: 100 }, { width: 100, height: 100 }),
    ).toEqual(region);
    expect(screenCrop(null, { widthPx: 100, heightPx: 100 }, undefined)).toBeNull();
  });
});
