/**
 * The MCP tools end to end in memory: an MCP client calls the real server and tools, which talk
 * to the real automation service and an editor document store (`fixtures/automation-app.ts`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { AppError, type AppApi } from '../../src/mcp/app-client';
import { createServer } from '../../src/mcp/server';
import { timelineDurationUs } from '../../src/shared/project/timeline-ops';
import { fakeApp, peaksBytes } from '../fixtures/automation-app';
import { recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;

async function connect(app: AppApi) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(app).connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string; data?: string }[];
    return {
      isError: result.isError === true,
      text: content.map((c) => c.text ?? '').join('\n'),
      content,
    };
  };
  return { client, call };
}

async function setup() {
  const doc = recordedProject({ pauses: [] });
  const fake = fakeApp(doc);
  return { doc, fake, ...(await connect(fake.app)) };
}

describe('Capture Studio MCP tools', () => {
  it('offers the editing tools with usage instructions', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_annotation',
        'edit_annotation',
        'remove_annotations',
        'set_speed',
        'freeze_frame',
        'set_transition',
        'set_marker',
        'remove_marker',
        'apply_edits',
        'cancel_export',
        'cut_range',
        'delete_clips',
        'export_project',
        'export_status',
        'find_silences',
        'get_frame',
        'get_project',
        'list_projects',
        'move_clip',
        'nudge_sync',
        'redo',
        'remove_silences',
        'set_background',
        'set_face_keyframe',
        'set_face_layout',
        'set_face_mode',
        'set_marks',
        'set_screen_crop',
        'set_track',
        'split_at',
        'trim_clip',
        'trim_ends',
        'set_zoom_keyframe',
        'undo',
        'zoom_screen',
      ].sort(),
    );
    expect(client.getInstructions()).toMatch(/list_projects/);
    const reads = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(reads.sort()).toEqual(
      ['export_status', 'find_silences', 'get_frame', 'get_project', 'list_projects'].sort(),
    );
  });

  it('lists projects and reads one by name', async () => {
    const { call, doc } = await setup();
    const listed = await call('list_projects');
    expect(JSON.parse(listed.text)).toEqual([
      expect.objectContaining({ id: doc.id, name: 'Lesson test', openInEditor: false }),
    ]);
    const got = await call('get_project', { project: 'lesson test' });
    const summary = JSON.parse(got.text) as { tracks: { name: string }[]; version: number };
    expect(summary.tracks.map((t) => t.name)).toEqual(['Screen', 'Face', 'Voice', 'System audio']);
    expect(summary.version).toBe(0);
    const unknown = await call('get_project', { project: 'Nope' });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.text).toContain('"Lesson test"');
  });

  it('cuts in the editor as one labelled undo step, and dry runs open nothing', async () => {
    const { call, doc, fake } = await setup();
    const dry = await call('cut_range', { project: doc.id, start: '0:01', end: 3, dryRun: true });
    expect(dry.text).toMatch(/^Dry run of "Cut 0:01–3 s"/);
    expect(dry.text).toContain('(−2 s)');
    expect(fake.editor()).toBeNull();

    const cut = await call('cut_range', { project: doc.id, start: '0:01', end: 3 });
    expect(cut.isError).toBe(false);
    expect(cut.text).toMatch(/^Applied "Cut 0:01–3 s" as one undo step/);
    const store = fake.editor()!;
    expect(store.getState().undoLabel).toBe('Cut 0:01–3 s');
    expect(timelineDurationUs(store.getState().doc!)).toBe(timelineDurationUs(doc) - 2 * S);

    const undone = await call('undo', { project: doc.id });
    expect(undone.text).toMatch(/^Undid "Cut 0:01–3 s"/);
    expect(store.getState().doc).toEqual(doc);
    expect((await call('undo', { project: doc.id })).text).toBe('Nothing to undo.');
  });

  it('applies several steps as one, each seeing the timeline the earlier ones left', async () => {
    const { call, doc, fake } = await setup();
    const result = await call('apply_edits', {
      project: doc.id,
      label: 'Tidy up',
      steps: [
        { kind: 'trimEnds', startSeconds: 2, endSeconds: 3 },
        { kind: 'track', track: 'voice', gainDb: -6 },
        { kind: 'track', track: 'System audio', muted: true },
        { kind: 'faceLayout', corner: 'top-left', size: 'small', shape: 'circle' },
        { kind: 'marks', in: 1, out: '0:10' },
      ],
    });
    expect(result.isError).toBe(false);
    const after = fake.editor()!.getState().doc!;
    expect(timelineDurationUs(after)).toBe(timelineDurationUs(doc) - 5 * S);
    const voice = trackByName(after, 'Voice');
    expect(voice.type === 'audio' && voice.gainDb).toBe(-6);
    const face = trackByName(after, 'Face');
    expect(face.type === 'video' && face.layout).toMatchObject({
      kind: 'overlay',
      width: 0.12,
      shape: 'circle',
    });
    if (face.type === 'video' && face.layout.kind === 'overlay') {
      expect(face.layout.centerX).toBeLessThan(0.2);
      expect(face.layout.centerY).toBeLessThan(0.3);
    }
    expect(after.timeline.marks).toEqual({ inUs: S, outUs: 10 * S });
    expect(fake.editor()!.getState().undoLabel).toBe('Tidy up');
    fake.editor()!.getState().undo();
    expect(fake.editor()!.getState().doc).toEqual(doc);
  });

  it('styles the face, changes its mode over time and lists the keyframes (R2.1–R2.4)', async () => {
    const { call, doc, fake } = await setup();
    const styled = await call('set_face_layout', {
      project: doc.id,
      zoom: 1.5,
      border: { width: 0.006, color: '#FFFFFF' },
      shadow: { blur: 0.03, offsetX: 0, offsetY: 0.015, color: '#00000099' },
    });
    expect(styled.isError).toBe(false);
    const mode = await call('set_face_mode', {
      project: doc.id,
      start: 4,
      end: 8,
      mode: 'side-by-side',
      transitionSeconds: 0.5,
    });
    expect(mode.text).toMatch(/^Applied "Face side-by-side 4 s–8 s"/);
    const keyed = await call('set_face_keyframe', {
      project: doc.id,
      at: 10,
      mode: 'hidden',
      easing: 'hold',
    });
    expect(keyed.isError).toBe(false);
    const face = trackByName(fake.editor()!.getState().doc!, 'Face');
    if (face.type !== 'video' || face.layout.kind !== 'overlay') throw new Error('no face overlay');
    expect(face.layout).toMatchObject({ zoom: 1.5, border: { color: '#FFFFFF' } });
    expect(face.layoutKeyframes?.map((k) => [k.tUs / S, k.mode])).toEqual([
      [3.5, 'overlay'],
      [4, 'side-by-side'],
      [7.5, 'side-by-side'],
      [8, 'overlay'],
      [10, 'hidden'],
    ]);
    const summary = JSON.parse((await call('get_project', { project: doc.id })).text) as {
      tracks: { name: string; layoutKeyframes?: { mode: string; at: { seconds: number } }[] }[];
    };
    const listed = summary.tracks.find((t) => t.name === 'Face')?.layoutKeyframes ?? [];
    expect(listed.map((k) => k.mode)).toEqual([
      'overlay',
      'side-by-side',
      'side-by-side',
      'overlay',
      'hidden',
    ]);
    const removed = await call('set_face_keyframe', { project: doc.id, at: 10, remove: true });
    expect(removed.isError).toBe(false);
    const backwards = await call('set_face_mode', {
      project: doc.id,
      start: 5,
      end: 2,
      mode: 'full',
    });
    expect(backwards).toMatchObject({ isError: true });
  });

  it('styles the background and zooms the screen (R2.9, R2.11)', async () => {
    const { call, doc, fake } = await setup();
    const styled = await call('set_background', {
      project: doc.id,
      gradient: { from: '#0D9488', to: '#1D4ED8', angle: 90 },
      padding: 0.08,
      shadow: null,
    });
    expect(styled.text).toMatch(/^Applied "Change background"/);
    const zoomed = await call('zoom_screen', {
      project: doc.id,
      start: 4,
      end: 8,
      zoom: 2,
      centerX: 0.25,
      centerY: 0.25,
      transitionSeconds: 0.5,
    });
    expect(zoomed.text).toMatch(/^Applied "Zoom 2× 4 s–8 s"/);
    const keyed = await call('set_zoom_keyframe', { project: doc.id, at: 10, zoom: 3 });
    expect(keyed.isError).toBe(false);
    const timeline = fake.editor()!.getState().doc!.timeline;
    expect(timeline.beautify).toEqual({
      background: { type: 'gradient', from: '#0D9488', to: '#1D4ED8', angleDeg: 90 },
      padding: 0.08,
      cornerRadius: 0.02,
    });
    expect(timeline.camera?.map((k) => [k.tUs / S, k.rect.width])).toEqual([
      [3.5, 1],
      [4, 0.5],
      [7.5, 0.5],
      [8, 1],
      [10, 1 / 3],
    ]);
    // Zoom 2 centred at (0.25, 0.25) touches the top-left corner.
    expect(timeline.camera?.[1]?.rect).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
    const summary = JSON.parse((await call('get_project', { project: doc.id })).text) as {
      background?: unknown;
      zoomKeyframes?: { zoom: number; at: { seconds: number } }[];
    };
    expect(summary.background).toEqual(timeline.beautify);
    expect(summary.zoomKeyframes?.map((k) => [k.at.seconds, k.zoom])).toEqual([
      [3.5, 1],
      [4, 2],
      [7.5, 2],
      [8, 1],
      [10, 3],
    ]);
    expect(
      await call('set_zoom_keyframe', { project: doc.id, at: 10, remove: true }),
    ).toMatchObject({ isError: false });
    expect(await call('set_background', { project: doc.id, off: true })).toMatchObject({
      isError: false,
    });
    expect(fake.editor()!.getState().doc!.timeline.beautify).toBeUndefined();
    const both = await call('set_background', {
      project: doc.id,
      color: '#000000',
      gradient: { from: '#000000', to: '#FFFFFF' },
    });
    expect(both).toMatchObject({ isError: true });
  });

  it('adds, edits and removes annotations (R2.5–R2.7)', async () => {
    const { call, doc, fake } = await setup();
    const title = await call('add_annotation', {
      project: doc.id,
      type: 'text',
      start: 1,
      end: 4,
      text: 'Welcome',
      preset: 'subtitle',
      fadeSeconds: 0.5,
    });
    expect(title.text).toMatch(/^Applied "Add text at 1 s"/);
    const blur = await call('add_annotation', {
      project: doc.id,
      type: 'blur',
      start: 2,
      box: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      strength: 0.5,
    });
    expect(blur.isError).toBe(false);
    const wrong = await call('add_annotation', {
      project: doc.id,
      type: 'arrow',
      start: 1,
      number: 3,
    });
    expect(wrong).toMatchObject({ isError: true });
    expect(wrong.text).toContain('number does not apply to a arrow');

    const summary = () =>
      call('get_project', { project: doc.id }).then(
        (r) =>
          JSON.parse(r.text) as {
            annotations?: { id: string; kind: string; label: string; moves: boolean }[];
          },
      );
    const listed = (await summary()).annotations ?? [];
    expect(listed.map((a) => [a.kind, a.label])).toEqual([
      ['text', 'Welcome'],
      ['blur', 'Blur'],
    ]);
    const [text, region] = listed;
    const timeline = () => fake.editor()!.getState().doc!.timeline;
    const items = () => timeline().objectTracks?.[0]?.items ?? [];
    expect(items()[0]).toMatchObject({
      inUs: S,
      outUs: 4 * S,
      fadeInUs: 500_000,
      style: { background: '#000000A6' },
    });
    expect(items()[1]).toMatchObject({ inUs: 2 * S, outUs: 5 * S });
    const region1 = items()[1];
    expect(region1?.kind === 'blur' ? region1.radius : null).toBeCloseTo(0.026, 9);

    const moved = await call('edit_annotation', {
      project: doc.id,
      id: region!.id,
      moveTo: { at: 4, box: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 } },
    });
    expect(moved.isError).toBe(false);
    expect(items()[1]?.keyframes?.map((k) => [k.tUs / S, k.box.x])).toEqual([
      [2, 0.1],
      [4, 0.5],
    ]);
    expect((await summary()).annotations?.[1]?.moves).toBe(true);
    await call('edit_annotation', { project: doc.id, id: text!.id, text: 'Hi', color: '#FF0000' });
    expect(items()[0]).toMatchObject({ text: 'Hi', style: { color: '#FF0000' } });
    const removed = await call('remove_annotations', { project: doc.id, ids: [text!.id] });
    expect(removed.text).toMatch(/Remove 1 annotation"/);
    expect(items().map((i) => i.kind)).toEqual(['blur']);
    const unknown = await call('edit_annotation', { project: doc.id, id: 'obj_nope', text: 'x' });
    expect(unknown).toMatchObject({ isError: true });
  });

  it('changes speed, freezes, adds a transition and chapter markers (R2.10, R2.18–R2.20)', async () => {
    const { call, doc, fake } = await setup();
    const sped = await call('set_speed', { project: doc.id, start: 2, end: 6, speed: 2 });
    expect(sped.text).toMatch(/^Applied "Speed 2× 2 s–6 s"/);
    const frozen = await call('freeze_frame', { project: doc.id, at: 10, seconds: 1.5 });
    expect(frozen.isError).toBe(false);
    const current = () => fake.editor()!.getState().doc!;
    const screen = trackByName(current(), 'Screen').clips;
    const later = screen.find((c) => c.timelineStartUs >= 4 * S && !c.freeze)!;
    const faded = await call('set_transition', {
      project: doc.id,
      clipId: later.id,
      type: 'fade-color',
      seconds: 0.4,
      color: '#FFFFFF',
    });
    expect(faded.text).toMatch(/^Applied "Transition fade-color"/);
    const marked = await call('set_marker', {
      project: doc.id,
      at: 1,
      label: 'Intro',
      chapter: true,
    });
    expect(marked.isError).toBe(false);
    const summary = JSON.parse((await call('get_project', { project: doc.id })).text) as {
      markers?: { id: string; label: string; chapter: boolean }[];
      tracks: { name: string; clips: { speed?: number; freeze?: true; transition?: unknown }[] }[];
    };
    const clips = summary.tracks.find((t) => t.name === 'Screen')!.clips;
    expect(clips.some((c) => c.speed === 2)).toBe(true);
    expect(clips.some((c) => c.freeze)).toBe(true);
    expect(clips.some((c) => c.transition)).toBe(true);
    expect(summary.markers).toEqual([expect.objectContaining({ label: 'Intro', chapter: true })]);
    const renamed = await call('set_marker', {
      project: doc.id,
      id: summary.markers![0]!.id,
      label: 'Hi',
    });
    expect(renamed.isError).toBe(false);
    expect(current().timeline.markers?.[0]?.label).toBe('Hi');
    await call('remove_marker', { project: doc.id, id: summary.markers![0]!.id });
    expect(current().timeline.markers).toBeUndefined();
    expect(await call('set_marker', { project: doc.id, label: 'no time' })).toMatchObject({
      isError: true,
    });
    expect(await call('set_speed', { project: doc.id, start: 1, end: 3, speed: 3 })).toMatchObject({
      isError: true,
    });
  });

  it('explains mistakes and refusals', async () => {
    const { call, doc } = await setup();
    const badTrack = await call('set_track', { project: doc.id, track: 'Music', muted: true });
    expect(badTrack.isError).toBe(true);
    expect(badTrack.text).toContain('No track "Music"');

    const wrongType = await call('set_track', { project: doc.id, track: 'Voice', hidden: true });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.text).toMatch(/gain, mute and solo are audio/);

    const badTime = await call('cut_range', { project: doc.id, start: 'soon', end: 3 });
    expect(badTime).toMatchObject({ isError: true });
    expect(badTime.text).toContain('"soon" is not a time');

    const locked = await call('apply_edits', {
      project: doc.id,
      label: 'x',
      steps: [
        { kind: 'track', track: 'Face', locked: true },
        { kind: 'trimClip', clipId: trackByName(doc, 'Face').clips[0]!.id, edge: 'end', to: 5 },
      ],
    });
    expect(locked.isError).toBe(true);
    expect(locked.text).toMatch(/^Step 2 \(trimClip\)/);
    expect(locked.text).toContain('unlock it with set_track');
  });

  it('finds and removes pauses as one step', async () => {
    const { call, doc, fake } = await setup();
    const mic = doc.media.find((m) => m.role === 'microphone')!;
    const system = doc.media.find((m) => m.role === 'system-audio')!;
    fake.peaks.set(
      mic.id,
      peaksBytes(mic.durationUs, [
        [10 * S, 13 * S],
        [30 * S, 32 * S],
      ]),
    );
    fake.peaks.set(system.id, peaksBytes(system.durationUs, [[0, 60 * S]]));
    const found = await call('find_silences', { project: doc.id });
    expect(found.text).toMatch(/^2 pause\(s\)/);
    const removed = await call('remove_silences', { project: doc.id });
    expect(removed.text).toMatch(/^Applied "Remove 2 pauses"/);
    const after = fake.editor()!.getState().doc!;
    expect((timelineDurationUs(doc) - timelineDurationUs(after)) / S).toBeCloseTo(4.4, 1);
  });

  it('returns frames as images', async () => {
    const { call, doc } = await setup();
    const frame = await call('get_frame', { project: doc.id, at: 2.5, maxWidth: 320 });
    expect(frame.content[0]).toMatchObject({ type: 'image', data: 'iVBORw0KGgoAAAA' });
    expect(frame.text).toContain('00:00:02:15');
  });

  it('exports and follows the job', async () => {
    const { call, doc, fake } = await setup();
    const started = await call('export_project', { project: doc.id, resolution: '720p' });
    expect(started.text).toMatch(/^Export started: job job_01/);
    expect(fake.exports.started[0]).toMatchObject({
      options: { resolution: '720p', fps: 'project', quality: 'standard', encoder: 'auto' },
    });
    fake.exports.emit({
      type: 'done',
      jobId: 'job_01',
      outputPath: '/exports/Lesson test.mp4',
      encoder: 'libx264',
      notice: null,
    });
    const status = await call('export_status', { jobId: 'job_01' });
    expect(JSON.parse(status.text)).toMatchObject({
      state: 'done',
      percent: 100,
      file: '/exports/Lesson test.mp4',
    });
  });

  it('says how to turn automation on when the app cannot be reached', async () => {
    const offline: AppApi = {
      call: () => Promise.reject(new AppError('app-unavailable', 'Capture Studio is not running')),
    };
    const { call } = await connect(offline);
    const result = await call('list_projects');
    expect(result).toMatchObject({ isError: true, text: 'Capture Studio is not running' });
  });
});
