/**
 * Speed, freeze frames, transitions and markers (R2.10, R2.18–R2.20): the operations (sync across
 * linked tracks, what moves with the content, refusals), `atempo` stages and render keys, the
 * transition scene, MP4 chapters, the preview's audio renders, the inspector's operations and
 * the M key.
 */
import { describe, expect, it, vi } from 'vitest';
import { AudioRenders } from '../../src/renderer/editor/audio/audio-renders';
import { playableSegments, wantedRenders } from '../../src/renderer/editor/audio/schedule-math';
import { runCommand, type CommandContext } from '../../src/renderer/editor/commands';
import { commandForKey } from '../../src/renderer/editor/keyboard';
import {
  speedIn,
  speedRange,
  transitionClip,
  transitionOp,
} from '../../src/renderer/editor/InspectorPanel/time-ops';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import { createUiStore } from '../../src/renderer/editor/ui-store';
import { exportChapters, ffmetadataText } from '../../src/shared/export/chapters';
import type { EditorPreloadApi } from '../../src/shared/ipc/preload-api';
import { atempoFactors, atempoFilters, audioRenderKey } from '../../src/shared/project/audio-speed';
import { audioSegments, clipLayerAt, layersAt } from '../../src/shared/project/render-plan';
import { sceneAt } from '../../src/shared/project/scene';
import type { Project } from '../../src/shared/project/schema';
import {
  applyOp,
  clipEndUs,
  timelineDurationUs,
  type TimelineOp,
} from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;

function project(): Project {
  return recordedProject({
    durationUs: 20 * S,
    pauses: [],
    system: false,
    screenSize: { width: 1280, height: 720 },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
}

const run = (doc: Project, ...ops: (TimelineOp | null)[]) =>
  ops.reduce((d, op) => unwrap(applyOp(d, op!, { generateId: counterIds('M') })), doc);

const spans = (doc: Project, name: string) =>
  trackByName(doc, name).clips.map((c) => [c.timelineStartUs / S, clipEndUs(c) / S, c.speed ?? 1]);

describe('atempo', () => {
  it('splits speeds into stages within 0.5–2', () => {
    expect(atempoFactors(1)).toEqual([]);
    expect(atempoFactors(2)).toEqual([2]);
    expect(atempoFactors(4)).toEqual([2, 2]);
    expect(atempoFactors(3)).toEqual([2, 1.5]);
    expect(atempoFactors(0.25)).toEqual([0.5, 0.5]);
    expect(atempoFilters(0.75)).toEqual(['atempo=0.75']);
    expect(audioRenderKey({ mediaId: 'med_A', fileStartUs: 1, fileEndUs: 9, speed: 1.5 })).toBe(
      'med_A-1-9-1500000',
    );
  });
});

describe('setSpeed', () => {
  it('speeds a range up on every track, keeps linked clips together and moves what follows', () => {
    let doc = run(
      project(),
      { type: 'addMarker', marker: { id: 'mrk_A', tUs: 15 * S, label: 'End', chapter: true } },
      { type: 'setCameraKeyframe', tUs: 4 * S },
    );
    doc = run(doc, { type: 'setSpeed', inUs: 2 * S, outUs: 6 * S, speed: 2 });
    for (const name of ['Screen', 'Face', 'Voice']) {
      expect(spans(doc, name)).toEqual([
        [0, 2, 1],
        [2, 4, 2],
        [4, 18, 1],
      ]);
    }
    expect(timelineDurationUs(doc)).toBe(18 * S);
    expect(doc.timeline.markers?.[0]?.tUs).toBe(13 * S);
    // Inside the range, times scale: the camera keyframe at 4 s is now at 3 s.
    expect(doc.timeline.camera?.map((k) => k.tUs)).toContain(3 * S);
    // The picture at 3 s is the recording at 4 s.
    const screen = layersAt(doc, 3 * S).find((l) => l.kind === 'screen');
    expect(screen?.refTimeUs).toBe(
      trackByName(project(), 'Screen').clips[0]!.sourceStartUs + 4 * S,
    );
    // Back to 1× restores plain clips.
    const back = run(doc, { type: 'setSpeed', inUs: 2 * S, outUs: 4 * S, speed: 1 });
    expect(spans(back, 'Screen')).toEqual([
      [0, 2, 1],
      [2, 6, 1],
      [6, 20, 1],
    ]);
    expect(trackByName(back, 'Screen').clips[1]?.durationUs).toBeUndefined();
  });

  it('refuses mixed speeds, no clips and out-of-range speeds', () => {
    const doc = run(project(), { type: 'setSpeed', inUs: 2 * S, outUs: 4 * S, speed: 2 });
    const refuse = (op: TimelineOp) => expect(applyOp(doc, op).ok).toBe(false);
    refuse({ type: 'setSpeed', inUs: S, outUs: 5 * S, speed: 3 });
    refuse({ type: 'setSpeed', inUs: 30 * S, outUs: 31 * S, speed: 2 });
    refuse({ type: 'setSpeed', inUs: 0, outUs: S, speed: 5 });
    expect(applyOp(doc, { type: 'setSpeed', inUs: 2 * S, outUs: 3 * S, speed: 2 })).toMatchObject({
      error: { code: 'nothing-to-do' },
    });
  });
});

describe('freezeFrame', () => {
  it('holds every video track and opens a silent gap in the audio', () => {
    const doc = run(
      project(),
      {
        type: 'addObject',
        item: {
          id: 'obj_A',
          kind: 'blur',
          inUs: 4 * S,
          outUs: 6 * S,
          box: { x: 0, y: 0, width: 0.2, height: 0.2 },
          radius: 0.01,
        },
      },
      { type: 'freezeFrame', atUs: 5 * S, durationUs: 2 * S },
    );
    const screen = trackByName(doc, 'Screen').clips;
    expect(screen.map((c) => [c.timelineStartUs / S, clipEndUs(c) / S, c.freeze ?? false])).toEqual(
      [
        [0, 5, false],
        [5, 7, true],
        [7, 22, false],
      ],
    );
    expect(
      trackByName(doc, 'Voice').clips.map((c) => [c.timelineStartUs / S, clipEndUs(c) / S]),
    ).toEqual([
      [0, 5],
      [7, 22],
    ]);
    // The held picture is what showed at 5 s; the audio has nothing there.
    expect(layersAt(doc, 6 * S).find((l) => l.kind === 'screen')?.refTimeUs).toBe(
      layersAt(project(), 5 * S).find((l) => l.kind === 'screen')?.refTimeUs,
    );
    expect(
      audioSegments(doc).some((s) => s.timelineStartUs < 6 * S && s.timelineEndUs > 6 * S),
    ).toBe(false);
    // An object showing at the freeze stays through it.
    expect(doc.timeline.objectTracks?.[0]?.items[0]).toMatchObject({ inUs: 4 * S, outUs: 8 * S });
  });
});

describe('transitions', () => {
  function cutAt(
    t: number,
    transition: NonNullable<TimelineOp & { type: 'setTransition' }>['transition'],
  ) {
    const doc = run(project(), { type: 'split', atUs: t });
    const second = trackByName(doc, 'Screen').clips[1]!;
    return run(doc, { type: 'setTransition', clipId: second.id, transition });
  }
  const screenLayers = (doc: Project, t: number) =>
    sceneAt(doc, t).layers.filter((l) => l.kind === 'screen');

  it('dissolves the incoming clip in over the outgoing one, which keeps playing', () => {
    const doc = cutAt(5 * S, { kind: 'dissolve', durationUs: S });
    const [out, inc] = screenLayers(doc, 5.25 * S);
    expect(inc?.opacity).toBeCloseTo(0.25, 9);
    expect(out?.opacity).toBe(1);
    // The outgoing clip continues past its end: 5.25 s of the recording.
    expect(out!.refTimeUs - inc!.refTimeUs).toBe(0);
    expect(screenLayers(doc, 6 * S)).toHaveLength(1);
  });

  it('fades through a colour, and slides in from the side', () => {
    const fade = cutAt(5 * S, { kind: 'fade-color', durationUs: S, color: '#FFFFFF' });
    expect(screenLayers(fade, 5.25 * S)).toEqual([
      expect.objectContaining({ tint: { color: '#FFFFFF', amount: 0.5 } }),
    ]);
    expect(screenLayers(fade, 5.75 * S)[0]?.tint?.amount).toBeCloseTo(0.5, 9);
    const slide = cutAt(5 * S, { kind: 'slide', durationUs: S, direction: 'left' });
    const [, inc] = screenLayers(slide, 5.5 * S);
    expect(inc?.destRect.x).toBe(640);
  });

  it('come from the background at the start, and refuse a length past the clip', () => {
    const doc = project();
    const first = trackByName(doc, 'Screen').clips[0]!;
    const faded = run(doc, {
      type: 'setTransition',
      clipId: first.id,
      transition: { kind: 'dissolve', durationUs: S },
    });
    expect(screenLayers(faded, 0.5 * S)).toEqual([expect.objectContaining({ opacity: 0.5 })]);
    expect(
      applyOp(doc, {
        type: 'setTransition',
        clipId: first.id,
        transition: { kind: 'dissolve', durationUs: 30 * S },
      }),
    ).toMatchObject({ error: { code: 'invalid-value' } });
    const voice = trackByName(doc, 'Voice').clips[0]!;
    expect(
      applyOp(doc, {
        type: 'setTransition',
        clipId: voice.id,
        transition: { kind: 'dissolve', durationUs: S },
      }),
    ).toMatchObject({ error: { code: 'wrong-track-type' } });
  });

  it('hold the outgoing media’s last frame when it runs out', () => {
    const doc = project();
    const track = doc.timeline.tracks.findIndex((t) => t.name === 'Screen');
    const clip = trackByName(doc, 'Screen').clips[0]!;
    const late = clipLayerAt(doc, track, clip, 60 * S);
    expect(late!.refTimeUs).toBeLessThan(21 * S);
  });
});

describe('markers and chapters', () => {
  it('adds, renames, refuses duplicates and drops markers on cut content', () => {
    let doc = run(
      project(),
      { type: 'addMarker', marker: { id: 'mrk_A', tUs: 3 * S, label: '', chapter: false } },
      { type: 'addMarker', marker: { id: 'mrk_B', tUs: S, label: 'Intro', chapter: true } },
    );
    expect(doc.timeline.markers?.map((m) => m.id)).toEqual(['mrk_B', 'mrk_A']);
    expect(
      applyOp(doc, {
        type: 'addMarker',
        marker: { id: 'mrk_C', tUs: S, label: '', chapter: false },
      }),
    ).toMatchObject({ error: { code: 'overlap' } });
    doc = run(doc, { type: 'updateMarker', markerId: 'mrk_A', label: 'Demo', chapter: true });
    const cut = run(doc, { type: 'cutRange', inUs: 2 * S, outUs: 4 * S });
    expect(cut.timeline.markers?.map((m) => m.id)).toEqual(['mrk_B']);
    const none = run(cut, { type: 'removeMarker', markerId: 'mrk_B' });
    expect(none.timeline.markers).toBeUndefined();
  });

  it('turn chapter markers into chapters from 0:00 with escaped titles', () => {
    const chapters = exportChapters(
      [
        { id: 'mrk_A', tUs: 2 * S, label: 'A = b; #1', chapter: true },
        { id: 'mrk_B', tUs: 5 * S, label: '', chapter: true },
        { id: 'mrk_C', tUs: 6 * S, label: 'not a chapter', chapter: false },
        { id: 'mrk_D', tUs: 20 * S, label: 'past the end', chapter: true },
      ],
      10 * S,
    );
    expect(chapters).toEqual([
      { startUs: 0, endUs: 2 * S, title: 'Start' },
      { startUs: 2 * S, endUs: 5 * S, title: 'A = b; #1' },
      { startUs: 5 * S, endUs: 10 * S, title: 'Chapter 2' },
    ]);
    expect(ffmetadataText(chapters)).toContain('title=A \\= b\\; \\#1');
    expect(exportChapters(undefined, 10 * S)).toEqual([]);
  });
});

describe('preview audio renders', () => {
  it('play a sped-up segment from its render, and leave it silent until then', () => {
    const doc = run(project(), { type: 'setSpeed', inUs: 2 * S, outUs: 6 * S, speed: 2 });
    const segments = audioSegments(doc);
    const [want] = wantedRenders(segments);
    expect(want?.request).toMatchObject({ range: { speed: 2 } });
    const sped = segments.find((s) => s.speed === 2)!;
    const urls = { [sped.mediaId]: 'cs-media://p/media/microphone.mp4' };
    expect(playableSegments(segments, urls, new Map()).segments).toHaveLength(segments.length - 1);
    const renders = new Map([[want!.key, 'cs-media://p/cache/audio/x.wav']]);
    const played = playableSegments(segments, urls, renders);
    const swapped = played.segments.find((s) => s.mediaId.startsWith('render:'))!;
    expect(swapped).toMatchObject({ fileStartSeconds: 0, speed: 1, timelineStartUs: 2 * S });
    // Two seconds of the recording (the microphone's clock runs a little off).
    expect(swapped.fileEndSeconds).toBeCloseTo(2, 3);
    expect(played.urls[swapped.mediaId]).toBe('cs-media://p/cache/audio/x.wav');
  });

  it('are requested once, retried while pending, and reported when ready', async () => {
    vi.useFakeTimers();
    try {
      const answers = [
        { status: 'pending' as const, url: null },
        { status: 'ready' as const, url: 'cs-media://p/cache/audio/x.wav' },
      ];
      const audioRender = vi.fn(() => Promise.resolve(answers.shift() ?? answers[0]!));
      const api = { audioRender } as unknown as EditorPreloadApi['media'];
      const renders = new AudioRenders(api, 'prj_A');
      const seen: number[] = [];
      renders.onChange((ready) => seen.push(ready.size));
      const doc = run(project(), { type: 'setSpeed', inUs: 2 * S, outUs: 6 * S, speed: 2 });
      renders.load(doc);
      renders.load(doc);
      await vi.advanceTimersByTimeAsync(0);
      expect(audioRender).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(audioRender).toHaveBeenCalledTimes(2);
      expect(seen).toEqual([1]);
      renders.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('inspector time operations', () => {
  it('speeds the In–Out range, else the selected clips', () => {
    const doc = project();
    const clip = trackByName(doc, 'Screen').clips[0]!;
    expect(speedRange(doc, [])).toBeNull();
    expect(speedRange(doc, [clip.id])).toMatchObject({ inUs: 0, source: 'selection' });
    const marked = run(doc, { type: 'setMarks', inUs: S, outUs: 2 * S });
    expect(speedRange(marked, [clip.id])).toEqual({ inUs: S, outUs: 2 * S, source: 'marks' });
    const sped = run(doc, { type: 'setSpeed', inUs: 2 * S, outUs: 4 * S, speed: 2 });
    expect(speedIn(sped, { inUs: 2 * S, outUs: 3 * S })).toBe(2);
    expect(speedIn(sped, { inUs: 0, outUs: 3 * S })).toBeNull();
  });

  it('sets a transition on the first selected video clip, clamped to its length', () => {
    const doc = project();
    const voice = trackByName(doc, 'Voice').clips[0]!;
    const screen = trackByName(doc, 'Screen').clips[0]!;
    expect(transitionClip(doc, [voice.id])).toBeNull();
    expect(transitionClip(doc, [voice.id, screen.id])?.id).toBe(screen.id);
    expect(transitionOp(screen, 'slide')).toEqual({
      type: 'setTransition',
      clipId: screen.id,
      transition: { kind: 'slide', durationUs: 500_000, direction: 'left' },
    });
    expect(transitionOp(screen, 'dissolve', { durationUs: 99 * S })).toMatchObject({
      transition: { durationUs: 20 * S },
    });
  });

  it('adds a marker at the playhead with M', () => {
    expect(
      commandForKey({ key: 'm', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }),
    ).toBe('add-marker');
    const docStore = createDocumentStore({ opOptions: { generateId: counterIds('D') } });
    docStore.getState().load({ doc: project(), revision: 0, mediaUrls: {}, readOnly: false });
    const ui = createUiStore({ playheadUs: 3 * S });
    const transport = {
      toggle: vi.fn(),
      shuttle: vi.fn(),
      step: vi.fn(),
      home: vi.fn(),
      end: vi.fn(),
    };
    const ctx: CommandContext = { docStore, ui, transport, timelineWidth: () => 800 };
    runCommand('add-marker', ctx);
    expect(docStore.getState().doc!.timeline.markers).toEqual([
      expect.objectContaining({ tUs: 3 * S, label: '', chapter: false }),
    ]);
    expect(docStore.getState().undoLabel).toBe('Add marker');
  });
});
