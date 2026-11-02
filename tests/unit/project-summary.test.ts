import { describe, expect, it } from 'vitest';
import { describeChange } from '../../src/shared/project/change-summary';
import { summarizeProject } from '../../src/shared/project/summary';
import { applyOpsWithPatches, timelineDurationUs } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;

describe('summarizeProject', () => {
  it('lists tracks, clips and components with seconds and timecode', () => {
    const doc = recordedProject();
    const summary = summarizeProject(doc);
    expect(summary).toMatchObject({
      id: doc.id,
      name: 'Lesson test',
      frameRate: 30,
      canvas: { width: 1920, height: 1080 },
      marks: { in: null, out: null },
    });
    expect(summary.duration.seconds).toBe(timelineDurationUs(doc) / S);
    expect(summary.tracks.map((t) => [t.name, t.type])).toEqual([
      ['Screen', 'video'],
      ['Face', 'video'],
      ['Voice', 'audio'],
      ['System audio', 'audio'],
    ]);
    // The 5 s pause splits every track into two clips; camera and mic pieces are linked.
    const face = summary.tracks.find((t) => t.name === 'Face');
    const voice = summary.tracks.find((t) => t.name === 'Voice');
    expect(face?.clips).toHaveLength(2);
    expect(face?.clips[0]?.linkId).not.toBeNull();
    expect(face?.clips[0]?.linkId).toBe(voice?.clips[0]?.linkId);
    expect(voice).toMatchObject({ gainDb: 0, muted: false, solo: false, audible: true });
    expect(face).toMatchObject({ sourceSize: { width: 1280, height: 720 } });
    expect(face?.clips[1]?.start.timecode).toMatch(/^\d\d:\d\d:\d\d:\d\d$/);
    expect(summary.components.map((c) => c.type).sort()).toEqual([
      'face-voice',
      'screen',
      'system-audio',
    ]);
  });

  it('round-trips clip times exactly through seconds', () => {
    const summary = summarizeProject(recordedProject());
    const doc = recordedProject();
    for (const [i, track] of doc.timeline.tracks.entries()) {
      for (const [j, clip] of track.clips.entries()) {
        const seconds = summary.tracks[i]?.clips[j]?.start.seconds ?? NaN;
        expect(Math.round(seconds * S)).toBe(clip.timelineStartUs);
      }
    }
  });
});

describe('describeChange', () => {
  it('reports duration, clips, track properties, marks and sync', () => {
    const doc = recordedProject();
    const voice = trackByName(doc, 'Voice');
    const face = trackByName(doc, 'Face');
    const faceVoice = doc.components.find((c) => c.type === 'face-voice');
    const after = unwrap(
      applyOpsWithPatches(
        doc,
        [
          { type: 'cutRange', inUs: 0, outUs: 3 * S },
          { type: 'setGain', trackId: voice.id, gainDb: -6 },
          { type: 'setLayout', trackId: face.id, layout: { width: 0.12 } },
          { type: 'setMarks', inUs: S, outUs: null },
          { type: 'nudge', target: { componentId: faceVoice!.id }, syncAdjustUs: 40_000 },
        ],
        { generateId: counterIds('D') },
      ),
    ).doc;
    const change = describeChange(doc, after);
    expect(change.changed).toBe(true);
    expect(change.duration.deltaSeconds).toBe(-3);
    expect(change.lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Duration .* \(−3 s\)$/),
        'Track "Voice": gainDb 0 → -6',
        'Track "Face": layout.width 0.2 → 0.12',
        'Mark In: none → 00:00:01:00',
        expect.stringMatching(/^Sync camera .*: 0 ms → 40 ms$/),
      ]),
    );
    expect(change.clips.changed.length).toBeGreaterThan(0);
  });

  it('reports clamped values, not requested ones', () => {
    const doc = recordedProject();
    const voice = trackByName(doc, 'Voice');
    const after = unwrap(
      applyOpsWithPatches(doc, [{ type: 'setGain', trackId: voice.id, gainDb: 40 }]),
    ).doc;
    expect(describeChange(doc, after).lines).toEqual(['Track "Voice": gainDb 0 → 12']);
  });

  it('says nothing changed for the same document', () => {
    const doc = recordedProject();
    expect(describeChange(doc, doc)).toMatchObject({ changed: false, lines: [] });
  });
});
