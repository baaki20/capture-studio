/**
 * Step 7 audio (R2.12–R2.17): the operations (clip gain and fades, volume keyframes, cleanup),
 * the gain envelope (fades, keyframes, ducking from peaks), the export's envelope and loudness
 * stages, loudnorm parsing, the noise floor, pauses (never inside sound, one undo step each) and
 * the MCP tools' shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  findPauses,
  normalizeOps,
  pauseCutOps,
  PAUSE_PAD_US,
} from '../../src/renderer/editor/InspectorPanel/audio-ops';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import {
  loudnormApply,
  noiseFilter,
  noiseFloorDb,
  parseLoudnorm,
  wantsNormalize,
} from '../../src/shared/project/audio-cleanup';
import { gainAt, trackEnvelope } from '../../src/shared/project/audio-gain';
import type { Project } from '../../src/shared/project/schema';
import {
  applyOp,
  timelineDurationUs,
  type TimelineOp,
} from '../../src/shared/project/timeline-ops';
import { volumeDbAt } from '../../src/shared/project/volume-keyframes';
import { unwrap } from '../../src/shared/result';
import {
  buildExportGraph,
  loudnessMeasure,
  resolveExportSettings,
} from '../../src/utility/media/export/graph-builder';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;

function project(): Project {
  const doc = recordedProject({
    durationUs: 10 * S,
    pauses: [],
    system: true,
    screenSize: { width: 1280, height: 720 },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0, microphone: 0, 'system-audio': 0 },
  });
  for (const m of doc.media) m.clockRatio = 1;
  return doc;
}

const run = (doc: Project, ...ops: TimelineOp[]) =>
  ops.reduce((d, op) => unwrap(applyOp(d, op, { generateId: counterIds('U') })), doc);

function audio(doc: Project, name: string) {
  const track = trackByName(doc, name);
  if (track.type !== 'audio') throw new Error(`${name} is not audio`);
  return track;
}
const voice = (doc: Project) => audio(doc, 'Voice');
const system = (doc: Project) => audio(doc, 'System audio');
const db = (gain: number) => 20 * Math.log10(gain);

/** Peaks (10 ms windows) loud from `fromS` to `toS`, quiet elsewhere, `seconds` long. */
function peaks(seconds: number, loud: [number, number][]): Int16Array {
  const windows = seconds * 100;
  const out = new Int16Array(windows * 2);
  for (const [a, b] of loud) {
    for (let w = a * 100; w < b * 100; w++) {
      out[w * 2] = -20000;
      out[w * 2 + 1] = 20000;
    }
  }
  return out;
}

describe('audio operations', () => {
  it('set clip gain and fades on audio clips only, within the clip', () => {
    const doc = project();
    const clip = voice(doc).clips[0]!;
    const edited = run(doc, {
      type: 'setClipAudio',
      clipIds: [clip.id],
      gainDb: -6.2,
      fadeInUs: 20 * S,
      fadeOutUs: S,
    });
    expect(voice(edited).clips[0]).toMatchObject({ gainDb: -6, fadeInUs: 10 * S, fadeOutUs: S });
    const cleared = run(edited, {
      type: 'setClipAudio',
      clipIds: [clip.id],
      gainDb: null,
      fadeInUs: 0,
    });
    expect(voice(cleared).clips[0]?.gainDb).toBeUndefined();
    expect(voice(cleared).clips[0]?.fadeInUs).toBeUndefined();
    const screen = trackByName(doc, 'Screen').clips[0]!;
    expect(applyOp(doc, { type: 'setClipAudio', clipIds: [screen.id], gainDb: 1 })).toMatchObject({
      error: { code: 'wrong-track-type' },
    });
  });

  it('add volume keyframes with a level anchor at 0, and move them with cuts', () => {
    const doc = project();
    const id = voice(doc).id;
    let edited = run(doc, { type: 'setVolumeKeyframe', trackId: id, tUs: 4 * S, gainDb: -12 });
    expect(voice(edited).volumeKeyframes).toEqual([
      { tUs: 0, gainDb: 0, easing: 'hold' },
      { tUs: 4 * S, gainDb: -12, easing: 'linear' },
    ]);
    edited = run(edited, { type: 'setVolumeKeyframe', trackId: id, tUs: 2 * S, easing: 'linear' });
    expect(volumeDbAt(voice(edited).volumeKeyframes, 3 * S)).toBeCloseTo(-6, 9);
    const cut = run(edited, { type: 'cutRange', inUs: S, outUs: 3 * S });
    expect(voice(cut).volumeKeyframes?.map((k) => k.tUs)).toEqual([0, S, 2 * S]);
  });

  it('set cleanup, refuse ducking under itself, and drop it when everything is off', () => {
    const doc = project();
    const sys = system(doc).id;
    const duck = { byTrackId: voice(doc).id, amountDb: -60, attackMs: 0, releaseMs: 9000 };
    const edited = run(doc, {
      type: 'setCleanup',
      trackId: sys,
      cleanup: { noise: 'light', duck },
    });
    expect(system(edited).cleanup).toEqual({
      noise: 'light',
      normalize: false,
      duck: { byTrackId: voice(doc).id, amountDb: -40, attackMs: 1, releaseMs: 5000 },
    });
    expect(
      applyOp(doc, {
        type: 'setCleanup',
        trackId: sys,
        cleanup: { duck: { ...duck, byTrackId: sys } },
      }),
    ).toMatchObject({ error: { code: 'invalid-value' } });
    const off = run(edited, {
      type: 'setCleanup',
      trackId: sys,
      cleanup: { noise: 'off', duck: null },
    });
    expect(system(off).cleanup).toBeUndefined();
  });
});

describe('gain envelope', () => {
  it('is absent for a Phase 1 track', () => {
    expect(trackEnvelope(project(), voice(project()).id)).toBeNull();
  });

  it('ramps fades in amplitude and adds clip gain and keyframes', () => {
    const doc = project();
    const clip = voice(doc).clips[0]!;
    const edited = run(
      doc,
      { type: 'setClipAudio', clipIds: [clip.id], gainDb: -6, fadeInUs: 2 * S },
      { type: 'setVolumeKeyframe', trackId: voice(doc).id, tUs: 5 * S, gainDb: 0, easing: 'hold' },
      { type: 'setVolumeKeyframe', trackId: voice(doc).id, tUs: 5 * S + 1, gainDb: -20 },
    );
    const env = trackEnvelope(edited, voice(edited).id)!;
    expect(gainAt(env, S)).toBeCloseTo(0.5 * 10 ** (-6 / 20), 3);
    expect(db(gainAt(env, 3 * S))).toBeCloseTo(-6, 1);
    expect(db(gainAt(env, 7 * S))).toBeCloseTo(-26, 1);
  });

  it('ducks under the voice with attack and release, from its peaks', () => {
    const doc = project();
    const sys = system(doc).id;
    const edited = run(doc, {
      type: 'setCleanup',
      trackId: sys,
      cleanup: { duck: { byTrackId: voice(doc).id, amountDb: -12, attackMs: 100, releaseMs: 500 } },
    });
    const mic = doc.media.find((m) => m.role === 'microphone')!.id;
    const env = trackEnvelope(edited, sys, (id) => (id === mic ? peaks(10, [[3, 5]]) : null))!;
    expect(db(gainAt(env, 2 * S))).toBeCloseTo(0, 1);
    // Halfway through the 100 ms attack (in 10 ms steps).
    expect(db(gainAt(env, 3.05 * S))).toBeGreaterThan(-8.5);
    expect(db(gainAt(env, 3.05 * S))).toBeLessThan(-4);
    expect(db(gainAt(env, 4 * S))).toBeCloseTo(-12, 1);
    expect(db(gainAt(env, 5.25 * S))).toBeGreaterThan(-8.5);
    expect(db(gainAt(env, 5.25 * S))).toBeLessThan(-4);
    expect(db(gainAt(env, 6 * S))).toBeCloseTo(0, 1);
    // Without the voice's peaks there is no ducking (nothing is guessed).
    expect(trackEnvelope(edited, sys)).toBeNull();
  });
});

describe('export stages', () => {
  const build = (doc: Project, extra: Partial<Parameters<typeof buildExportGraph>[0]> = {}) =>
    unwrap(
      buildExportGraph({
        doc,
        projectRoot: '/p',
        settings: resolveExportSettings(
          doc,
          { resolution: 'canvas', fps: 30, quality: 'draft', encoder: 'software' },
          null,
        ),
        outputPath: '/p/out.mp4',
        filterScriptPath: '/w/video.txt',
        audioScriptPath: '/w/audio.txt',
        maskDir: '/w',
        ...extra,
      }),
    );

  it('leaves Phase 1 audio graphs alone and adds a timed volume stage for envelopes', () => {
    const plain = build(project());
    expect(plain.audioScriptText).not.toContain('asendcmd');
    const doc = project();
    const faded = run(doc, {
      type: 'setClipAudio',
      clipIds: [voice(doc).clips[0]!.id],
      fadeInUs: S,
    });
    const text = build(faded).audioScriptText;
    expect(text).toMatch(/asendcmd=c='0\.02\d* volume@e\d+ volume 0\.02/);
    expect(text).toMatch(/volume@e\d+=volume=0:eval=frame/);
  });

  it('measures, then applies loudnorm in linear mode, and reads cleaned audio', () => {
    const doc = project();
    const normalized = run(doc, {
      type: 'setCleanup',
      trackId: voice(doc).id,
      cleanup: { normalize: true },
    });
    expect(wantsNormalize(normalized)).toBe(true);
    const graph = build(normalized);
    const measure = loudnessMeasure(graph, '/w/loudness.txt');
    expect(measure.scriptText).toContain('loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json[aout]');
    expect(measure.args.slice(-4)).toEqual(['-map', '[aout]', '-f', 'null', '-'].slice(-4));
    const measured = {
      input_i: '-30.1',
      input_tp: '-9.2',
      input_lra: '3.0',
      input_thresh: '-40.5',
      target_offset: '0.2',
    };
    const applied = build(normalized, { loudness: measured }).audioScriptText;
    expect(applied).toContain(loudnormApply(measured));
    expect(applied).toContain('linear=true');
    const mic = doc.media.find((m) => m.role === 'microphone')!;
    const cleaned = build(doc, { audioPaths: new Map([[mic.id, '/p/cache/audio/clean.wav']]) });
    expect(cleaned.inputs.map((i) => i.path)).toContain('/p/cache/audio/clean.wav');
  });

  it('parses loudnorm output and tunes noise reduction to the floor', () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x0]\n{\n\t"input_i" : "-27.61",\n\t"input_tp" : "-4.47",\n\t"input_lra" : "18.06",\n\t"input_thresh" : "-39.20",\n\t"output_i" : "-16.58",\n\t"target_offset" : "0.58"\n}\n`;
    expect(parseLoudnorm(stderr)).toMatchObject({ input_i: '-27.61', target_offset: '0.58' });
    expect(parseLoudnorm('no json')).toBeNull();
    const pcm = new Int16Array(48_000).map((_, i) => (i % 2 ? 100 : -100));
    expect(noiseFloorDb(pcm)).toBeCloseTo(20 * Math.log10(100 / 32768), 1);
    expect(noiseFilter('strong', -50.4)).toBe('afftdn=nr=24:nf=-47');
    expect(noiseFilter('light', -120)).toBe('afftdn=nr=12:nf=-80');
  });
});

describe('pauses', () => {
  it('are found only where every audible track is quiet, padded off speech', () => {
    const doc = run(project(), { type: 'setMuted', trackId: system(project()).id, muted: true });
    const mic = doc.media.find((m) => m.role === 'microphone')!.id;
    const loaded = new Map([
      [
        mic,
        peaks(10, [
          [0, 2],
          [5, 7],
        ]),
      ],
    ]);
    const found = findPauses(doc, loaded, { thresholdDb: -45, minDurationUs: 800_000 });
    expect(found.pauses).toEqual([
      { startUs: 2 * S + PAUSE_PAD_US, endUs: 5 * S - PAUSE_PAD_US },
      { startUs: 7 * S + PAUSE_PAD_US, endUs: 10 * S },
    ]);
    // A media whose waveform has not loaded: nothing is proposed.
    expect(findPauses(doc, new Map(), { thresholdDb: -45, minDurationUs: 800_000 }).waiting).toBe(
      1,
    );
  });

  it('are cut latest first, each its own undo step', () => {
    const pauses = [
      { startUs: 2 * S, endUs: 3 * S },
      { startUs: 6 * S, endUs: 7 * S },
    ];
    const ops = pauseCutOps(pauses);
    expect(ops.map((o) => (o.type === 'cutRange' ? o.inUs : -1))).toEqual([6 * S, 2 * S]);
    const docStore = createDocumentStore({ opOptions: { generateId: counterIds('D') } });
    const doc = project();
    docStore.getState().load({ doc, revision: 0, mediaUrls: {}, readOnly: false });
    for (const op of ops) docStore.getState().apply(op, { coalesceKey: null, label: 'Cut pause' });
    expect(timelineDurationUs(docStore.getState().doc!)).toBe(8 * S);
    docStore.getState().undo();
    // One undo brings back only the last cut (the earlier pause); the later one stays cut.
    expect(timelineDurationUs(docStore.getState().doc!)).toBe(9 * S);
    docStore.getState().undo();
    expect(docStore.getState().doc).toEqual(doc);
  });

  it('turn normalization on for every audio track as one batch', () => {
    const doc = project();
    expect(normalizeOps(doc, true)).toHaveLength(2);
    const on = run(doc, ...normalizeOps(doc, true));
    expect(normalizeOps(on, true)).toEqual([]);
  });
});
