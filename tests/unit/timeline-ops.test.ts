import { describe, expect, it } from 'vitest';
import { checkProjectInvariants } from '../../src/shared/project/invariants';
import { mediaEditBounds, mediaRefBounds } from '../../src/shared/project/media-time';
import { ProjectV1Schema, type ProjectV1, type Track } from '../../src/shared/project/schema';
import {
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  NUDGE_MAX_US,
  applyOp,
  applyOpWithPatches,
  clipAt,
  clipEndUs,
  clipsAt,
  cutRange,
  deleteClips,
  findClip,
  linkedClips,
  mapTimeThroughCut,
  move,
  nudge,
  refTimeAt,
  relink,
  rippleDelete,
  setGain,
  setHidden,
  setLayout,
  setLocked,
  setMarks,
  setMuted,
  setSolo,
  snapPoints,
  snapTo,
  split,
  timelineDurationUs,
  trim,
  unlink,
  type OpResult,
} from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { exampleProject } from '../fixtures/example-project';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;
const FRAME = 33_333;

function ids() {
  return { generateId: counterIds('X') };
}

function valid(result: OpResult): ProjectV1 {
  const doc = unwrap(result);
  expect(checkProjectInvariants(doc)).toEqual([]);
  expect(ProjectV1Schema.safeParse(doc).success).toBe(true);
  return doc;
}

function errorCode(result: OpResult): string {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.error.code;
}

function spans(track: Track) {
  return track.clips.map((c) => [c.timelineStartUs, clipEndUs(c)]);
}

/** Default recording: Screen, Face, Voice, System; 60 s session with a pause [20 s, 25 s). */
function project() {
  return recordedProject();
}

function firstClip(doc: ProjectV1, track: string) {
  const clip = trackByName(doc, track).clips[0];
  if (!clip) throw new Error(`no clip on ${track}`);
  return clip;
}

describe('fixture', () => {
  it('has linked face and voice clips and one clip per active interval', () => {
    const doc = project();
    expect(trackByName(doc, 'Screen').clips).toHaveLength(2);
    expect(trackByName(doc, 'Face').clips).toHaveLength(2);
    expect(trackByName(doc, 'Voice').clips).toHaveLength(2);
    expect(linkedClips(doc, firstClip(doc, 'Face').id)).toHaveLength(2);
  });
});

describe('queries', () => {
  it('finds clips under the playhead and reference times', () => {
    const doc = project();
    expect(clipsAt(doc, 10 * S).map((l) => l.track.name)).toEqual([
      'Screen',
      'Face',
      'Voice',
      'System audio',
    ]);
    const screen = trackByName(doc, 'Screen');
    // After the pause, timeline 21 s shows session 26 s.
    expect(refTimeAt(screen, 21 * S)).toBe(26 * S);
    expect(refTimeAt(screen, 1_000)).toBeNull();
    expect(clipAt(screen, 20 * S)?.sourceStartUs).toBe(25 * S);
  });

  it('computes the timeline duration as the latest clip end', () => {
    const doc = project();
    const ends = doc.timeline.tracks.flatMap((t) => t.clips.map(clipEndUs));
    expect(timelineDurationUs(doc)).toBe(Math.max(...ends));
  });

  it('offers snap points and snaps within a threshold', () => {
    const doc = unwrap(setMarks(project(), { inUs: 3 * S, outUs: 4 * S }));
    const face = firstClip(doc, 'Face');
    const dragged = linkedClips(doc, face.id).map((l) => l.clip.id);
    const points = snapPoints(doc, { playheadUs: 7 * S, excludeClipIds: dragged });
    expect(points).toContain(7 * S);
    expect(points).toContain(3 * S);
    expect(points).not.toContain(face.timelineStartUs);
    expect(snapTo(7 * S + 500, points, 1_000)).toEqual({ us: 7 * S, snapped: true });
    expect(snapTo(7 * S + 5_000, points, 1_000)).toEqual({ us: 7 * S + 5_000, snapped: false });
  });
});

describe('split (R1.35)', () => {
  it('splits a selected clip and its linked partner at the playhead', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(split(doc, { atUs: 10 * S, clipIds: [face.id] }, ids()));
    const faceClips = trackByName(next, 'Face').clips;
    const voiceClips = trackByName(next, 'Voice').clips;
    expect(faceClips).toHaveLength(3);
    expect(voiceClips).toHaveLength(3);
    expect(faceClips[0]?.sourceEndUs).toBe(10 * S);
    expect(faceClips[1]?.timelineStartUs).toBe(10 * S);
    expect(faceClips[1]?.sourceStartUs).toBe(10 * S);
    // Left pieces keep their link, right pieces share a new one.
    expect(faceClips[0]?.linkId).toBe(face.linkId);
    expect(faceClips[1]?.linkId).not.toBe(face.linkId);
    expect(faceClips[1]?.linkId).toBe(voiceClips[1]?.linkId);
    // Other tracks are untouched.
    expect(trackByName(next, 'Screen').clips).toHaveLength(2);
    // The input is not modified.
    expect(trackByName(doc, 'Face').clips).toHaveLength(2);
  });

  it('splits every clip under the playhead on unlocked tracks when nothing is selected', () => {
    const doc = unwrap(
      setLocked(project(), { trackId: trackByName(project(), 'System audio').id, locked: true }),
    );
    const next = valid(split(doc, { atUs: 10 * S }, ids()));
    expect(trackByName(next, 'Screen').clips).toHaveLength(3);
    expect(trackByName(next, 'Face').clips).toHaveLength(3);
    expect(trackByName(next, 'Voice').clips).toHaveLength(3);
    expect(trackByName(next, 'System audio').clips).toHaveLength(2);
  });

  it('splits only the selected clip with includeLinked false and unlinks it', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(
      split(doc, { atUs: 10 * S, clipIds: [face.id], includeLinked: false }, ids()),
    );
    expect(trackByName(next, 'Face').clips).toHaveLength(3);
    expect(trackByName(next, 'Voice').clips).toHaveLength(2);
    expect(trackByName(next, 'Voice').clips[0]?.linkId).toBeNull();
  });

  it('refuses to make a piece shorter than one frame', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    expect(errorCode(split(doc, { atUs: face.timelineStartUs + 1_000, clipIds: [face.id] }))).toBe(
      'nothing-to-do',
    );
    expect(errorCode(split(doc, { atUs: 500 * S }))).toBe('nothing-to-do');
  });

  it('refuses a selected clip on a locked track', () => {
    const doc = project();
    const locked = unwrap(setLocked(doc, { trackId: trackByName(doc, 'Voice').id, locked: true }));
    expect(errorCode(split(locked, { atUs: 10 * S, clipIds: [firstClip(doc, 'Face').id] }))).toBe(
      'track-locked',
    );
  });
});

describe('trim (R1.36)', () => {
  it('trims the end of a clip and its linked partner', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(trim(doc, { clipId: face.id, edge: 'end', toUs: 15 * S }));
    expect(clipEndUs(firstClip(next, 'Face'))).toBe(15 * S);
    expect(clipEndUs(firstClip(next, 'Voice'))).toBe(15 * S);
  });

  it('trims the start: timeline start and source start move together', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(trim(doc, { clipId: face.id, edge: 'start', toUs: 2 * S }));
    const trimmed = firstClip(next, 'Face');
    expect(trimmed.timelineStartUs).toBe(2 * S);
    expect(trimmed.sourceStartUs).toBe(2 * S);
    expect(firstClip(next, 'Voice').timelineStartUs).toBe(2 * S);
  });

  it('cannot extend beyond the media bounds', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(trim(doc, { clipId: face.id, edge: 'start', toUs: 0 }));
    const camera = next.media.find((m) => m.role === 'camera');
    expect(firstClip(next, 'Face').sourceStartUs).toBe(mediaRefBounds(camera!).startUs);
  });

  it('cannot overlap the neighbour', () => {
    const doc = project();
    const screen = firstClip(doc, 'Screen');
    // The first screen clip ends where the second begins (the pause was removed); trimming the
    // second clip's start earlier is blocked by the first.
    const second = trackByName(doc, 'Screen').clips[1]!;
    const next = trim(doc, { clipId: second.id, edge: 'start', toUs: 10 * S });
    expect(unwrap(next)).toBe(doc);
    // Shortening the first, then extending it again stops at the second.
    const shorter = valid(trim(doc, { clipId: screen.id, edge: 'end', toUs: 15 * S }));
    const longer = valid(trim(shorter, { clipId: screen.id, edge: 'end', toUs: 40 * S }));
    expect(clipEndUs(firstClip(longer, 'Screen'))).toBe(second.timelineStartUs);
  });

  it('keeps at least one frame', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(trim(doc, { clipId: face.id, edge: 'end', toUs: 0 }));
    expect(clipEndUs(firstClip(next, 'Face')) - face.timelineStartUs).toBe(FRAME);
  });

  it('trims alone and unlinks with includeLinked false', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(
      trim(doc, { clipId: face.id, edge: 'end', toUs: 15 * S, includeLinked: false }),
    );
    expect(clipEndUs(firstClip(next, 'Face'))).toBe(15 * S);
    expect(clipEndUs(firstClip(next, 'Voice'))).toBe(20 * S);
    expect(firstClip(next, 'Face').linkId).toBeNull();
    expect(firstClip(next, 'Voice').linkId).toBeNull();
  });

  it('returns the same document when nothing changes', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const result = applyOpWithPatches(doc, {
      type: 'trim',
      clipId: face.id,
      edge: 'end',
      toUs: clipEndUs(face),
    });
    expect(unwrap(result).doc).toBe(doc);
    expect(unwrap(result).patches).toEqual([]);
  });
});

describe('move (R1.39)', () => {
  it('moves a clip with its linked partner', () => {
    let doc = project();
    const face = firstClip(doc, 'Face');
    doc = valid(trim(doc, { clipId: face.id, edge: 'end', toUs: 5 * S }));
    const next = valid(move(doc, { clipId: face.id, toStartUs: 8 * S }));
    expect(firstClip(next, 'Face').timelineStartUs).toBe(8 * S);
    expect(firstClip(next, 'Voice').timelineStartUs).toBe(8 * S);
    // The source does not change.
    expect(firstClip(next, 'Face').sourceStartUs).toBe(face.sourceStartUs);
  });

  it('snaps to the nearest free position instead of overlapping', () => {
    let doc = project();
    const face = firstClip(doc, 'Face');
    doc = valid(trim(doc, { clipId: face.id, edge: 'end', toUs: 5 * S }));
    // 15 s into a 5 s clip would overlap the second face clip (starts at 20 s): nearest free
    // start is 15 s → fits exactly [15, 20)? 15 + ~5 s ends just before 20 s.
    const duration = clipEndUs(firstClip(doc, 'Face')) - face.timelineStartUs;
    const next = valid(move(doc, { clipId: face.id, toStartUs: 18 * S }));
    expect(firstClip(next, 'Face').timelineStartUs).toBe(20 * S - duration);
  });

  it('refuses an overlap when asked to', () => {
    let doc = project();
    const face = firstClip(doc, 'Face');
    doc = valid(trim(doc, { clipId: face.id, edge: 'end', toUs: 5 * S }));
    expect(errorCode(move(doc, { clipId: face.id, toStartUs: 18 * S, onOverlap: 'refuse' }))).toBe(
      'overlap',
    );
  });

  it('keeps clips sorted when a clip jumps over another', () => {
    let doc = project();
    const face = firstClip(doc, 'Face');
    doc = valid(trim(doc, { clipId: face.id, edge: 'end', toUs: 5 * S }));
    const next = valid(move(doc, { clipId: face.id, toStartUs: 80 * S }));
    expect(trackByName(next, 'Face').clips[1]?.id).toBe(face.id);
  });
});

describe('delete and ripple delete (R1.37)', () => {
  it('delete leaves a gap and removes linked partners', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(deleteClips(doc, { clipIds: [face.id] }));
    expect(trackByName(next, 'Face').clips).toHaveLength(1);
    expect(trackByName(next, 'Voice').clips).toHaveLength(1);
    expect(trackByName(next, 'Face').clips[0]?.timelineStartUs).toBe(20 * S);
  });

  it('delete with includeLinked false clears the orphaned partner link', () => {
    const doc = project();
    const next = valid(
      deleteClips(doc, { clipIds: [firstClip(doc, 'Face').id], includeLinked: false }),
    );
    expect(trackByName(next, 'Voice').clips).toHaveLength(2);
    expect(firstClip(next, 'Voice').linkId).toBeNull();
  });

  it('ripple delete removes the span from all unlocked tracks and closes the gap', () => {
    const doc = project();
    const screen = firstClip(doc, 'Screen');
    const next = valid(rippleDelete(doc, { clipIds: [screen.id] }));
    const removed = clipEndUs(screen) - screen.timelineStartUs;
    expect(timelineDurationUs(next)).toBe(timelineDurationUs(doc) - removed);
    // The session instant 26 s (timeline 21 s before) is now at 21 s − removed on every track.
    for (const name of ['Screen', 'Face', 'Voice']) {
      expect(refTimeAt(trackByName(next, name), 21 * S - removed)).toBe(26 * S);
    }
  });

  it('refuses a clip on a locked track', () => {
    const doc = project();
    const locked = unwrap(setLocked(doc, { trackId: trackByName(doc, 'Screen').id, locked: true }));
    expect(errorCode(deleteClips(locked, { clipIds: [firstClip(doc, 'Screen').id] }))).toBe(
      'track-locked',
    );
    expect(errorCode(deleteClips(doc, { clipIds: ['clp_nope'] }))).toBe('unknown-clip');
  });
});

describe('cutRange (R1.38)', () => {
  it('removes [in, out) from all unlocked tracks, splitting clips that span it', () => {
    const doc = project();
    const next = valid(cutRange(doc, { inUs: 5 * S, outUs: 8 * S }, ids()));
    const screen = trackByName(next, 'Screen');
    expect(spans(screen)[0]).toEqual([2_200, 5 * S]);
    expect(spans(screen)[1]).toEqual([5 * S, 17 * S]);
    expect(refTimeAt(screen, 5 * S)).toBe(8 * S);
    // Linked pieces on the right share a new link.
    const faceRight = trackByName(next, 'Face').clips[1]!;
    const voiceRight = trackByName(next, 'Voice').clips[1]!;
    expect(faceRight.linkId).toBe(voiceRight.linkId);
    expect(faceRight.linkId).not.toBe(firstClip(next, 'Face').linkId);
  });

  it('preserves sync: every track shows the same session instant before and after', () => {
    const doc = project();
    const next = valid(cutRange(doc, { inUs: 5 * S, outUs: 8 * S }, ids()));
    for (const t of [1 * S, 4.9 * S, 8 * S, 12 * S, 30 * S]) {
      const mapped = mapTimeThroughCut(t, 5 * S, 8 * S);
      for (const name of ['Screen', 'Face', 'Voice', 'System audio']) {
        expect(refTimeAt(trackByName(next, name), mapped)).toBe(
          refTimeAt(trackByName(doc, name), t),
        );
      }
    }
  });

  it('leaves locked tracks alone and unlinks groups that span locked and unlocked tracks', () => {
    const doc = project();
    const locked = unwrap(setLocked(doc, { trackId: trackByName(doc, 'Voice').id, locked: true }));
    const next = valid(cutRange(locked, { inUs: 5 * S, outUs: 8 * S }, ids()));
    expect(spans(trackByName(next, 'Voice'))).toEqual(spans(trackByName(doc, 'Voice')));
    expect(trackByName(next, 'Face').clips.every((c) => c.linkId === null)).toBe(true);
  });

  it('drops slivers shorter than one frame', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const next = valid(cutRange(doc, { inUs: face.timelineStartUs + 1_000, outUs: 10 * S }, ids()));
    expect(trackByName(next, 'Face').clips[0]?.timelineStartUs).toBe(face.timelineStartUs + 1_000);
    expect(trackByName(next, 'Face').clips[0]?.sourceStartUs).toBe(10 * S);
  });

  it('maps the marks and clears an emptied range', () => {
    const doc = unwrap(setMarks(project(), { inUs: 5 * S, outUs: 8 * S }));
    const next = valid(cutRange(doc, { inUs: 5 * S, outUs: 8 * S }, ids()));
    expect(next.timeline.marks).toEqual({ inUs: null, outUs: null });
    const later = unwrap(setMarks(project(), { inUs: 10 * S, outUs: 12 * S }));
    expect(unwrap(cutRange(later, { inUs: 5 * S, outUs: 8 * S }, ids())).timeline.marks).toEqual({
      inUs: 7 * S,
      outUs: 9 * S,
    });
  });

  it('rejects an empty or negative range', () => {
    expect(errorCode(cutRange(project(), { inUs: 5 * S, outUs: 5 * S }))).toBe('invalid-value');
    expect(errorCode(cutRange(project(), { inUs: -1, outUs: 5 * S }))).toBe('invalid-value');
  });
});

describe('track properties (R1.40)', () => {
  it('gain is clamped to −60…+12 dB in 0.5 dB steps', () => {
    const doc = project();
    const voice = trackByName(doc, 'Voice').id;
    const gain = (db: number) => {
      const t = trackByName(unwrap(setGain(doc, { trackId: voice, gainDb: db })), 'Voice');
      return t.type === 'audio' ? t.gainDb : NaN;
    };
    expect(gain(-6.3)).toBe(-6.5);
    expect(gain(-100)).toBe(GAIN_MIN_DB);
    expect(gain(40)).toBe(GAIN_MAX_DB);
    expect(errorCode(setGain(doc, { trackId: voice, gainDb: Number.NaN }))).toBe('invalid-value');
  });

  it('mute, solo and hide apply to the right track types', () => {
    const doc = project();
    const voice = trackByName(doc, 'Voice').id;
    const screen = trackByName(doc, 'Screen').id;
    expect(
      trackByName(valid(setMuted(doc, { trackId: voice, muted: true })), 'Voice'),
    ).toMatchObject({
      muted: true,
    });
    expect(trackByName(valid(setSolo(doc, { trackId: voice, solo: true })), 'Voice')).toMatchObject(
      {
        solo: true,
      },
    );
    expect(
      trackByName(valid(setHidden(doc, { trackId: screen, hidden: true })), 'Screen'),
    ).toMatchObject({
      hidden: true,
    });
    expect(errorCode(setHidden(doc, { trackId: voice, hidden: true }))).toBe('wrong-track-type');
    expect(errorCode(setMuted(doc, { trackId: screen, muted: true }))).toBe('wrong-track-type');
    expect(errorCode(setMuted(doc, { trackId: 'trk_nope', muted: true }))).toBe('unknown-track');
  });

  it('track property changes are allowed on locked tracks', () => {
    const doc = project();
    const voice = trackByName(doc, 'Voice').id;
    const locked = unwrap(setLocked(doc, { trackId: voice, locked: true }));
    expect(setMuted(locked, { trackId: voice, muted: true }).ok).toBe(true);
  });
});

describe('setLayout (R1.41)', () => {
  it('changes the face overlay and keeps it inside the canvas', () => {
    const doc = project();
    const face = trackByName(doc, 'Face').id;
    const next = valid(
      setLayout(doc, {
        trackId: face,
        layout: { centerX: 1, centerY: 1, width: 0.9, shape: 'rounded' },
      }),
    );
    const layout = trackByName(next, 'Face');
    expect(layout.type === 'video' && layout.layout.kind === 'overlay').toBe(true);
    if (layout.type !== 'video' || layout.layout.kind !== 'overlay') return;
    expect(layout.layout.width).toBe(0.5);
    expect(layout.layout.shape).toBe('rounded');
    // A 0.5-wide 16:9 overlay is 960 × 540 on 1920 × 1080: the centre is pulled to 0.75, 0.75.
    expect(layout.layout.centerX).toBeCloseTo(0.75);
    expect(layout.layout.centerY).toBeCloseTo(0.75);
  });

  it('sets and clamps the screen crop, and refuses overlay fields on a screen track', () => {
    const doc = project();
    const screen = trackByName(doc, 'Screen').id;
    const next = valid(
      setLayout(doc, {
        trackId: screen,
        layout: { crop: { x: 1800, y: 0, width: 400, height: 2000 } },
      }),
    );
    const track = trackByName(next, 'Screen');
    expect(track.type === 'video' && track.layout.crop).toEqual({
      x: 1800,
      y: 0,
      width: 120,
      height: 1080,
    });
    expect(errorCode(setLayout(doc, { trackId: screen, layout: { width: 0.2 } }))).toBe(
      'wrong-track-type',
    );
    expect(
      errorCode(
        setLayout(doc, { trackId: screen, layout: { crop: { x: 0, y: 0, width: 0, height: 5 } } }),
      ),
    ).toBe('invalid-value');
  });
});

describe('nudge (R1.42)', () => {
  it('sets syncAdjustUs on every media of the component without moving clips', () => {
    const doc = project();
    const face = doc.components.find((c) => c.type === 'face-voice')!;
    const next = valid(nudge(doc, { target: { componentId: face.id }, syncAdjustUs: -120_000 }));
    for (const id of face.mediaIds) {
      expect(next.media.find((m) => m.id === id)?.syncAdjustUs).toBe(-120_000);
    }
    // The second face clip keeps its position (only edges outside the media would change).
    expect(trackByName(next, 'Face').clips[1]?.timelineStartUs).toBe(20 * S);
    expect(firstClip(next, 'Face').timelineStartUs).toBe(firstClip(doc, 'Face').timelineStartUs);
  });

  it('is non-destructive: clips keep their ranges even where the nudged media no longer covers them', () => {
    const doc = project();
    const face = doc.components.find((c) => c.type === 'face-voice')!;
    const next = valid(nudge(doc, { target: { componentId: face.id }, syncAdjustUs: 100_000 }));
    // The media now starts 100 ms later in session time; the clips are untouched (the render
    // plan shows a gap at the head instead).
    for (const name of ['Face', 'Voice']) {
      expect(trackByName(next, name).clips).toEqual(trackByName(doc, name).clips);
    }
    // Nudging back restores the document exactly.
    const back = valid(nudge(next, { target: { componentId: face.id }, syncAdjustUs: 0 }));
    expect(back).toEqual(doc);
  });

  it('trims against the un-nudged media bounds', () => {
    const doc = project();
    const face = doc.components.find((c) => c.type === 'face-voice')!;
    const nudged = valid(nudge(doc, { target: { componentId: face.id }, syncAdjustUs: -500_000 }));
    const clip = firstClip(nudged, 'Face');
    const camera = nudged.media.find((m) => m.id === clip.mediaId)!;
    // Dragging the head far left stops at the media's recorded start, not the nudged one.
    const trimmed = valid(trim(nudged, { clipId: clip.id, edge: 'start', toUs: 0 }));
    expect(firstClip(trimmed, 'Face').sourceStartUs).toBe(mediaEditBounds(camera).startUs);
  });

  it('clamps to ±2000 ms and accepts explicit media IDs', () => {
    const doc = project();
    const system = doc.media.find((m) => m.role === 'system-audio')!;
    const next = valid(nudge(doc, { target: { mediaIds: [system.id] }, syncAdjustUs: 9 * S }));
    expect(next.media.find((m) => m.id === system.id)?.syncAdjustUs).toBe(NUDGE_MAX_US);
    expect(errorCode(nudge(doc, { target: { mediaIds: ['med_nope'] }, syncAdjustUs: 1 }))).toBe(
      'unknown-media',
    );
  });
});

describe('unlink and relink', () => {
  it('unlinks a whole group and links clips that line up', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const voice = firstClip(doc, 'Voice');
    const unlinked = valid(unlink(doc, { clipIds: [face.id] }));
    expect(firstClip(unlinked, 'Face').linkId).toBeNull();
    expect(firstClip(unlinked, 'Voice').linkId).toBeNull();
    const relinked = valid(relink(unlinked, { clipIds: [face.id, voice.id] }, ids()));
    expect(firstClip(relinked, 'Face').linkId).toBe('lnk_X0001');
    expect(firstClip(relinked, 'Voice').linkId).toBe('lnk_X0001');
  });

  it('refuses to link clips that do not line up or share a track', () => {
    const doc = project();
    const face = firstClip(doc, 'Face');
    const screen = firstClip(doc, 'Screen');
    expect(errorCode(relink(doc, { clipIds: [face.id, screen.id] }))).toBe('cannot-link');
    const second = trackByName(doc, 'Face').clips[1]!;
    expect(errorCode(relink(doc, { clipIds: [face.id, second.id] }))).toBe('cannot-link');
    expect(errorCode(relink(doc, { clipIds: [face.id] }))).toBe('cannot-link');
  });
});

describe('marks', () => {
  it('sets and clears marks and rejects an inverted range', () => {
    const doc = project();
    expect(valid(setMarks(doc, { inUs: S, outUs: 2 * S })).timeline.marks).toEqual({
      inUs: S,
      outUs: 2 * S,
    });
    expect(errorCode(setMarks(doc, { inUs: 2 * S, outUs: S }))).toBe('invalid-value');
    expect(valid(setMarks(doc, { inUs: S, outUs: null })).timeline.marks.outUs).toBeNull();
  });
});

describe('the spec example project', () => {
  it('accepts edits on the §4.4.2 example', () => {
    const doc = exampleProject();
    const next = valid(applyOp(doc, { type: 'split', atUs: 60 * S }, ids()));
    expect(findClip(next, 'clp_1')?.clip.sourceEndUs).toBe(60 * S);
    expect(trackByName(next, 'Face').clips).toHaveLength(2);
  });

  it('returns an invariant error instead of a broken document', () => {
    const doc = exampleProject();
    const broken = structuredClone(doc);
    broken.timeline.tracks[0]!.clips[0]!.sourceEndUs = 900 * S;
    const result = applyOp(doc, { type: 'replaceDocument', doc: broken });
    expect(errorCode(result)).toBe('invariant');
  });
});

describe('invariants extension', () => {
  it('reports duplicate clip, track and media IDs', () => {
    const doc = exampleProject();
    doc.timeline.tracks[1]!.clips[0]!.id = 'clp_1';
    doc.timeline.tracks[2]!.id = 'trk_s';
    expect(checkProjectInvariants(doc).map((v) => v.code)).toEqual([
      'duplicate-id',
      'duplicate-id',
    ]);
  });
});
