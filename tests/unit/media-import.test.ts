/**
 * Adding media (R2.21, R2.22): an imported file's tracks (picture and sound linked, a still as a
 * freeze frame), where `addMedia` puts video and audio tracks, new IDs for everything, refusals,
 * one undo step; and which videos get preview proxies.
 */
import { describe, expect, it } from 'vitest';
import {
  importedMediaEntry,
  importedTracks,
  needsProxy,
  STILL_US,
} from '../../src/shared/project/media-import';
import { layersAt } from '../../src/shared/project/render-plan';
import type { Project } from '../../src/shared/project/schema';
import { applyOp, clipEndUs, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { counterIds, recordedProject } from '../fixtures/editor-project';

const S = 1_000_000;
const project = (): Project =>
  recordedProject({
    durationUs: 20 * S,
    pauses: [],
    system: false,
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });

const video = { codec: 'h264', width: 640, height: 360, frameRateNominal: 30 };
const audio = { codec: 'aac', sampleRate: 48_000, channels: 2 };

function clipImport(): TimelineOp {
  const media = [
    importedMediaEntry('med_IMPV', 'media/clip.mp4', { kind: 'video', durationUs: 4 * S, video }),
    importedMediaEntry('med_IMPA', 'media/clip.mp4', { kind: 'audio', durationUs: 4 * S, audio }),
  ];
  const tracks = importedTracks('clip', [
    { mediaId: 'med_IMPV', kind: 'video', still: false, durationUs: 4 * S },
    { mediaId: 'med_IMPA', kind: 'audio', still: false, durationUs: 4 * S },
  ]);
  return { type: 'addMedia', media, tracks, atUs: 3 * S };
}

describe('addMedia', () => {
  it('adds an imported clip above the screen and its sound last, linked, at the playhead', () => {
    const doc = unwrap(applyOp(project(), clipImport(), { generateId: counterIds('N') }));
    expect(doc.timeline.tracks.map((t) => t.name)).toEqual([
      'Screen',
      'clip',
      'Face',
      'Voice',
      'clip',
    ]);
    const [v, a] = [doc.timeline.tracks[1]!, doc.timeline.tracks[4]!];
    expect(v.clips[0]).toMatchObject({ timelineStartUs: 3 * S, mediaId: 'med_IMPV' });
    expect(clipEndUs(a.clips[0]!)).toBe(7 * S);
    expect(v.clips[0]!.linkId).toBe(a.clips[0]!.linkId);
    expect(v.clips[0]!.linkId).toMatch(/^lnk_N/);
    expect(v.id).toMatch(/^trk_N/);
    // The imported picture shows above the screen at 4 s.
    expect(layersAt(doc, 4 * S).map((l) => l.mediaId)).toContain('med_IMPV');
  });

  it('places a still picture as a freeze frame and refuses unknown or repeated media', () => {
    const still = {
      type: 'addMedia' as const,
      media: [
        importedMediaEntry('med_IMG', 'media/logo.mp4', {
          kind: 'video',
          durationUs: 33_334,
          video,
        }),
      ],
      tracks: importedTracks('logo', [
        { mediaId: 'med_IMG', kind: 'video', still: true, durationUs: 33_334 },
      ]),
      atUs: 0,
    };
    const doc = unwrap(applyOp(project(), still, { generateId: counterIds('N') }));
    const clip = doc.timeline.tracks[1]!.clips[0]!;
    expect(clip).toMatchObject({ freeze: true, durationUs: STILL_US, sourceStartUs: 0 });
    expect(applyOp(doc, still)).toMatchObject({ error: { code: 'invalid-value' } });
    expect(applyOp(project(), { ...still, media: [] })).toMatchObject({
      error: { code: 'unknown-media' },
    });
  });

  it('keeps separate imports apart and proxies only videos over 1080p', () => {
    const a = importedTracks(
      'a',
      [
        { mediaId: 'med_A', kind: 'video', still: false, durationUs: S },
        { mediaId: 'med_B', kind: 'audio', still: false, durationUs: S },
      ],
      '0',
    );
    const b = importedTracks(
      'b',
      [
        { mediaId: 'med_C', kind: 'video', still: false, durationUs: S },
        { mediaId: 'med_D', kind: 'audio', still: false, durationUs: S },
      ],
      '1',
    );
    expect(a[0]!.clips[0]!.linkId).not.toBe(b[0]!.clips[0]!.linkId);
    expect(needsProxy({ width: 1920, height: 1080 })).toBe(false);
    expect(needsProxy({ width: 3840, height: 2160 })).toBe(true);
  });
});
