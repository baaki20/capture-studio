import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkProjectInvariants, type InvariantCode } from '../../src/shared/project/invariants';
import { projectJsonSchemaText } from '../../src/shared/project/json-schema';
import { parseProject } from '../../src/shared/project/migrations';
import {
  PROJECT_EXTENSION,
  ProjectV1Schema,
  ProjectV1StructureSchema,
  type ProjectV1,
  type VideoTrack,
} from '../../src/shared/project/schema';
import { exampleProject } from '../fixtures/example-project';

function codes(project: ProjectV1): InvariantCode[] {
  return checkProjectInvariants(project).map((v) => v.code);
}

function screenTrack(project: ProjectV1): VideoTrack {
  const track = project.timeline.tracks[0];
  if (track?.type !== 'video') throw new Error('fixture changed');
  return track;
}

describe('project schema v1', () => {
  it('accepts the spec example (§4.4.2)', () => {
    const result = ProjectV1Schema.safeParse(exampleProject());
    expect(result.success ? [] : result.error.issues).toEqual([]);
    expect(PROJECT_EXTENSION).toBe('.cstudio');
  });

  it('preserves extensions verbatim and drops unknown top-level keys', () => {
    const doc = {
      ...exampleProject(),
      extensions: { 'com.example.plugin': { nested: [1, { a: null }], flag: true } },
      somethingNew: 1,
    };
    const parsed = ProjectV1Schema.parse(doc);
    expect(parsed.extensions).toEqual(doc.extensions);
    expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty('somethingNew');
  });

  it.each([
    ['wrong format marker', (p: Record<string, unknown>) => (p.format = 'other')],
    ['non-integer µs', (p: ProjectV1) => (p.media[0]!.durationUs = 1.5)],
    ['bad project id prefix', (p: ProjectV1) => (p.id = 'med_123')],
    ['local time instead of UTC', (p: ProjectV1) => (p.createdAt = '2026-10-24T14:05:12+02:00')],
    ['odd canvas width', (p: ProjectV1) => (p.timeline.canvas.width = 1921)],
    ['canvas too small', (p: ProjectV1) => (p.timeline.canvas.height = 32)],
    [
      'unsupported frame rate',
      (p: ProjectV1) => ((p.timeline as { frameRate: number }).frameRate = 29),
    ],
    [
      'overlay too wide',
      (p: ProjectV1) => {
        const face = p.timeline.tracks[1] as VideoTrack;
        if (face.layout.kind === 'overlay') face.layout.width = 0.6;
      },
    ],
    [
      'gain above +12 dB',
      (p: ProjectV1) => ((p.timeline.tracks[2] as { gainDb: number }).gainDb = 13),
    ],
    ['bad colour', (p: ProjectV1) => (p.timeline.canvas.background.color = 'black')],
    ['zero clock ratio', (p: ProjectV1) => (p.media[0]!.clockRatio = 0)],
  ])('rejects %s', (_label, mutate) => {
    const doc = exampleProject();
    mutate(doc);
    expect(ProjectV1Schema.safeParse(doc).success).toBe(false);
  });

  it.each([
    '/etc/passwd',
    '../outside.mp4',
    'media/../../outside.mp4',
    'media\\screen.mp4',
    'C:/media/screen.mp4',
    'media//screen.mp4',
    './media/screen.mp4',
    'media/',
    '',
  ])('rejects media path %j', (badPath) => {
    const doc = exampleProject();
    doc.media[0]!.path = badPath;
    expect(ProjectV1StructureSchema.safeParse(doc).success).toBe(false);
  });

  it('accepts nested relative media paths', () => {
    const doc = exampleProject();
    doc.media[0]!.path = 'media/sub dir/screen.v2.mp4';
    expect(ProjectV1StructureSchema.safeParse(doc).success).toBe(true);
  });
});

describe('project invariants (§4.4.1)', () => {
  it('the example satisfies every invariant', () => {
    expect(checkProjectInvariants(exampleProject())).toEqual([]);
  });

  it('1: clips sorted and non-overlapping', () => {
    const unsorted = exampleProject();
    screenTrack(unsorted).clips.reverse();
    expect(codes(unsorted)).toContain('clip-order');

    const overlapping = exampleProject();
    screenTrack(overlapping).clips[1]!.timelineStartUs = 119_000_000;
    expect(codes(overlapping)).toContain('clip-overlap');

    const touching = exampleProject();
    screenTrack(touching).clips[1]!.timelineStartUs = 120_000_000;
    expect(codes(touching)).toEqual([]);
  });

  it('2: sourceEnd > sourceStart and within media bounds', () => {
    const empty = exampleProject();
    screenTrack(empty).clips[0]!.sourceEndUs = 0;
    expect(codes(empty)).toContain('clip-source-range');

    const pastEnd = exampleProject();
    screenTrack(pastEnd).clips[1]!.sourceEndUs = 738_500_001;
    expect(codes(pastEnd)).toContain('clip-media-bounds');

    const beforeStart = exampleProject();
    const face = beforeStart.timeline.tracks[1]!;
    face.clips[0]!.sourceStartUs = 41_199; // camera starts at 41 200
    expect(codes(beforeStart)).toContain('clip-media-bounds');
  });

  it('2: bounds follow clockRatio but ignore syncAdjustUs (nudges are non-destructive)', () => {
    const nudged = exampleProject();
    nudged.media[0]!.syncAdjustUs = 10; // the file now starts at 10, the clips stay valid
    expect(codes(nudged)).toEqual([]);
    nudged.media[0]!.syncAdjustUs = -2_000_000;
    expect(codes(nudged)).toEqual([]);

    const ratio = exampleProject();
    ratio.media[0]!.clockRatio = 1.00001; // extends the end by 7 385 µs
    screenTrack(ratio).clips[1]!.sourceEndUs = 738_500_000 + 7_385;
    expect(codes(ratio)).toEqual([]);
  });

  it('3: clips last at least one frame', () => {
    const doc = exampleProject();
    screenTrack(doc).clips[0]!.sourceEndUs = 33_332;
    expect(codes(doc)).toContain('clip-min-duration');
    screenTrack(doc).clips[0]!.sourceEndUs = 33_333;
    expect(codes(doc)).toEqual([]);
  });

  it('4: linked clips share start and duration and sit on different tracks', () => {
    const moved = exampleProject();
    moved.timeline.tracks[2]!.clips[0]!.timelineStartUs = 50_000;
    expect(codes(moved)).toContain('link-mismatch');

    const trimmed = exampleProject();
    trimmed.timeline.tracks[2]!.clips[0]!.sourceEndUs = 110_000_000;
    expect(codes(trimmed)).toContain('link-mismatch');

    const sameTrack = exampleProject();
    const screen = screenTrack(sameTrack);
    screen.clips[0]!.linkId = 'lnk_2';
    screen.clips[1]!.linkId = 'lnk_2';
    screen.clips[1]!.timelineStartUs = 0;
    expect(codes(sameTrack)).toContain('link-same-track');
  });

  it('5: canvas sides even and in range', () => {
    const doc = exampleProject();
    doc.timeline.canvas.width = 7682;
    expect(codes(doc)).toContain('canvas-size');
  });

  it('6: referenced media exists', () => {
    const doc = exampleProject();
    screenTrack(doc).clips[0]!.mediaId = 'med_gone';
    expect(codes(doc)).toContain('missing-media');
  });

  it('invariant failures surface as schema issues with paths', () => {
    const doc = exampleProject();
    screenTrack(doc).clips[0]!.mediaId = 'med_gone';
    const result = ProjectV1Schema.safeParse(doc);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['timeline', 'tracks', 0, 'clips', 0, 'mediaId']);
  });
});

describe('parseProject', () => {
  it('loads a current project read-write', () => {
    const result = parseProject(JSON.parse(JSON.stringify(exampleProject())));
    expect(result.ok && result.readOnly).toBe(false);
    expect(result.ok && result.fileFormatVersion).toBe(1);
  });

  it('opens a newer major version read-only when it still validates (R1.30)', () => {
    const doc = { ...exampleProject(), formatVersion: 2, extensions: { future: { x: 1 } } };
    const result = parseProject(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readOnly).toBe(true);
    expect(result.fileFormatVersion).toBe(2);
    expect(result.project.extensions).toEqual({ future: { x: 1 } });
  });

  it('reports a newer, incompatible project', () => {
    const doc = { ...exampleProject(), formatVersion: 3, timeline: 'v3 timeline' };
    const result = parseProject(doc);
    expect(!result.ok && result.reason).toBe('newer-incompatible');
  });

  it('rejects things that are not projects, or are invalid', () => {
    expect(!parseProject({ hello: 1 }).ok && parseProject({ hello: 1 })).toMatchObject({
      reason: 'not-a-project',
    });
    expect(parseProject(null)).toMatchObject({ ok: false, reason: 'not-a-project' });
    expect(parseProject({ ...exampleProject(), formatVersion: 0 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(parseProject({ ...exampleProject(), name: '' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('generated JSON Schema', () => {
  it('docs/schemas/project-1.schema.json is up to date (run `npm run gen:schema`)', () => {
    const committed = readFileSync(
      path.join(import.meta.dirname, '../../docs/schemas/project-1.schema.json'),
      'utf8',
    );
    expect(committed).toBe(projectJsonSchemaText());
  });

  it('describes the main structure', () => {
    const schema = JSON.parse(projectJsonSchemaText()) as {
      $schema: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.required).toEqual(
      expect.arrayContaining(['format', 'formatVersion', 'id', 'media', 'timeline', 'extensions']),
    );
    expect(schema.properties).not.toHaveProperty('somethingNew');
  });
});
