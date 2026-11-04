/**
 * Edit steps as the model writes them (seconds, track names, presets) and how each becomes the
 * app's `TimelineOp`s. `buildBatch` resolves the steps one after another against a local copy of
 * the document, applying each step's operations before resolving the next, so a later step sees
 * the timeline the earlier ones left (the app then applies the same operations to the same
 * document, guarded by `ifVersion`).
 */
import { z } from 'zod';
import {
  FACE_CORNERS,
  FACE_SIZE_PRESETS,
  applyCornerPreset,
  applySizePreset,
  type FaceSizePreset,
} from '../shared/project/face-layout';
import { mergeBeautify } from '../shared/project/beautify';
import { cameraAt, cameraRect, cameraView } from '../shared/project/camera-keyframes';
import type { ExternalOp } from '../shared/project/op-schema';
import {
  EASINGS,
  FACE_MODES,
  type OverlayLayout,
  type Project,
  type Track,
  type VideoTrack,
} from '../shared/project/schema';
import {
  applyOpsWithPatches,
  timelineDurationUs,
  trackFrameSize,
} from '../shared/project/timeline-ops';
import { opFailure, ToolInputError } from './errors';
import { TimeInput, toUs } from './units';

const ClipId = z.string().min(1).describe('A clip ID from get_project (clp_…)');
const TrackRef = z.string().min(1).describe('A track name from get_project ("Voice") or its ID');
const IncludeLinked = z
  .boolean()
  .optional()
  .describe('Edit linked clips (camera + mic) together; default true');

export const SHAPES = {
  cut: {
    start: TimeInput,
    end: TimeInput,
  },
  trimEnds: {
    startSeconds: z.number().nonnegative().optional().describe('Seconds to remove from the start'),
    endSeconds: z.number().nonnegative().optional().describe('Seconds to remove from the end'),
  },
  split: {
    at: TimeInput,
    clipIds: z
      .array(ClipId)
      .min(1)
      .optional()
      .describe('Only these clips; default every clip under the time'),
  },
  deleteClips: {
    clipIds: z.array(ClipId).min(1),
    ripple: z
      .boolean()
      .optional()
      .describe('Close the gap on every unlocked track (keeps sync); default false leaves a gap'),
    includeLinked: IncludeLinked,
  },
  trimClip: {
    clipId: ClipId,
    edge: z.enum(['start', 'end']),
    to: TimeInput.describe('Where the edge goes, in timeline time'),
    includeLinked: IncludeLinked,
  },
  moveClip: {
    clipId: ClipId,
    toStart: TimeInput.describe('The new start, in timeline time'),
    ifOccupied: z
      .enum(['nearest-free', 'refuse'])
      .optional()
      .describe('When another clip is in the way; default nearest-free'),
    includeLinked: IncludeLinked,
  },
  track: {
    track: TrackRef,
    gainDb: z
      .number()
      .optional()
      .describe('Audio tracks: volume in dB (−60 to +12, 0 = unchanged level)'),
    muted: z.boolean().optional().describe('Audio tracks'),
    solo: z.boolean().optional().describe('Audio tracks'),
    hidden: z.boolean().optional().describe('Video tracks'),
    locked: z.boolean().optional().describe('Locked tracks are left alone by clip edits and cuts'),
  },
  faceLayout: {
    track: TrackRef.optional().describe('Default: the face (camera overlay) track'),
    corner: z.enum(FACE_CORNERS as [string, ...string[]]).optional(),
    size: z
      .enum(Object.keys(FACE_SIZE_PRESETS) as [FaceSizePreset, ...FaceSizePreset[]])
      .optional(),
    width: z
      .number()
      .optional()
      .describe('Overlay width as a fraction of the canvas width (0.05–0.5)'),
    centerX: z.number().optional().describe('Overlay centre, fraction of canvas width (0–1)'),
    centerY: z.number().optional().describe('Overlay centre, fraction of canvas height (0–1)'),
    shape: z.enum(['rectangle', 'rounded', 'circle']).optional(),
    cornerRadius: z
      .number()
      .optional()
      .describe('Rounded shape only: fraction of the short side (0–0.5)'),
    mirror: z.boolean().optional(),
    zoom: z.number().optional().describe('Zoom into the camera picture inside the shape (1–4)'),
    border: z
      .object({
        width: z.number().describe('Fraction of the canvas short side (0–0.05), e.g. 0.006'),
        color: z.string().describe('#RRGGBB or #RRGGBBAA'),
      })
      .nullable()
      .optional()
      .describe('null removes the border'),
    shadow: z
      .object({
        blur: z.number().describe('Fraction of the canvas short side (0–0.1), e.g. 0.03'),
        offsetX: z.number().describe('Fraction of the short side (−0.1–0.1)'),
        offsetY: z.number().describe('Fraction of the short side (−0.1–0.1), e.g. 0.015'),
        color: z.string().describe('#RRGGBBAA, e.g. #00000099'),
      })
      .nullable()
      .optional()
      .describe('null removes the shadow'),
  },
  faceMode: {
    track: TrackRef.optional().describe('Default: the face (camera overlay) track'),
    start: TimeInput,
    end: TimeInput,
    mode: z
      .enum(FACE_MODES)
      .describe('overlay, full (face fills the frame), side-by-side (screen left), hidden'),
    transitionSeconds: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Eased change into and out of the mode; default 0 (a cut)'),
  },
  faceKeyframe: {
    track: TrackRef.optional().describe('Default: the face (camera overlay) track'),
    at: TimeInput,
    remove: z.boolean().optional().describe('Remove the keyframe at this time instead'),
    mode: z.enum(FACE_MODES).optional(),
    easing: z
      .enum(EASINGS)
      .optional()
      .describe('How it changes to the next keyframe; hold keeps it, then cuts'),
    width: z.number().optional().describe('Overlay width, fraction of the canvas width'),
    centerX: z.number().optional().describe('Overlay centre, fraction of canvas width'),
    centerY: z.number().optional().describe('Overlay centre, fraction of canvas height'),
  },
  background: {
    off: z.boolean().optional().describe('true: back to the plain canvas colour'),
    color: z.string().optional().describe('A solid background, #RRGGBB'),
    gradient: z
      .object({
        from: z.string().describe('#RRGGBB'),
        to: z.string().describe('#RRGGBB'),
        angle: z
          .number()
          .min(0)
          .max(360)
          .optional()
          .describe('Degrees, as CSS: 0 bottom to top, 90 left to right; default 135'),
      })
      .optional(),
    padding: z
      .number()
      .optional()
      .describe('Space around the screen, fraction of the canvas short side (0–0.3), e.g. 0.06'),
    cornerRadius: z
      .number()
      .optional()
      .describe('Screen corner radius, fraction of the short side (0–0.2), e.g. 0.02'),
    shadow: z
      .object({
        blur: z.number().describe('Fraction of the canvas short side (0–0.1), e.g. 0.03'),
        offsetX: z.number().describe('Fraction of the short side (−0.1–0.1)'),
        offsetY: z.number().describe('Fraction of the short side (−0.1–0.1), e.g. 0.012'),
        color: z.string().describe('#RRGGBBAA, e.g. #00000066'),
      })
      .nullable()
      .optional()
      .describe('Screen drop shadow; null removes it'),
  },
  zoom: {
    start: TimeInput,
    end: TimeInput,
    zoom: z.number().min(1).max(4).describe('Magnification, e.g. 2 shows a quarter of the frame'),
    centerX: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Where to look, fraction of canvas width; default 0.5'),
    centerY: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Where to look, fraction of canvas height; default 0.5'),
    transitionSeconds: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Eased zoom in and out; default 0.6'),
  },
  zoomKeyframe: {
    at: TimeInput,
    remove: z.boolean().optional().describe('Remove the zoom keyframe at this time instead'),
    zoom: z.number().min(1).max(4).optional(),
    centerX: z.number().min(0).max(1).optional(),
    centerY: z.number().min(0).max(1).optional(),
    easing: z
      .enum(EASINGS)
      .optional()
      .describe('How it changes to the next keyframe; hold keeps it, then cuts'),
  },
  screenCrop: {
    track: TrackRef.optional().describe('Default: the screen track'),
    crop: z
      .object({
        x: z.int().nonnegative(),
        y: z.int().nonnegative(),
        width: z.int().positive(),
        height: z.int().positive(),
      })
      .nullable()
      .describe(
        'In the recording’s pixels (sourceSize in get_project); null shows the whole frame',
      ),
  },
  syncNudge: {
    component: z
      .string()
      .min(1)
      .describe('"face-voice" (camera + mic), "system-audio", "screen", or a component ID'),
    offsetMs: z
      .number()
      .describe('Absolute shift in ms (±2000); positive plays the component later'),
  },
  marks: {
    in: TimeInput.nullable().optional().describe('In mark; null clears it, omit to keep'),
    out: TimeInput.nullable().optional().describe('Out mark; null clears it, omit to keep'),
  },
} as const;

export type StepKind = keyof typeof SHAPES;

export const EditStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cut'), ...SHAPES.cut }),
  z.object({ kind: z.literal('trimEnds'), ...SHAPES.trimEnds }),
  z.object({ kind: z.literal('split'), ...SHAPES.split }),
  z.object({ kind: z.literal('deleteClips'), ...SHAPES.deleteClips }),
  z.object({ kind: z.literal('trimClip'), ...SHAPES.trimClip }),
  z.object({ kind: z.literal('moveClip'), ...SHAPES.moveClip }),
  z.object({ kind: z.literal('track'), ...SHAPES.track }),
  z.object({ kind: z.literal('faceLayout'), ...SHAPES.faceLayout }),
  z.object({ kind: z.literal('faceMode'), ...SHAPES.faceMode }),
  z.object({ kind: z.literal('faceKeyframe'), ...SHAPES.faceKeyframe }),
  z.object({ kind: z.literal('background'), ...SHAPES.background }),
  z.object({ kind: z.literal('zoom'), ...SHAPES.zoom }),
  z.object({ kind: z.literal('zoomKeyframe'), ...SHAPES.zoomKeyframe }),
  z.object({ kind: z.literal('screenCrop'), ...SHAPES.screenCrop }),
  z.object({ kind: z.literal('syncNudge'), ...SHAPES.syncNudge }),
  z.object({ kind: z.literal('marks'), ...SHAPES.marks }),
]);
export type EditStep = z.infer<typeof EditStep>;

export function resolveTrack(doc: Project, ref: string): Track {
  const byId = doc.timeline.tracks.find((t) => t.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const byName = doc.timeline.tracks.filter((t) => t.name.toLowerCase() === wanted);
  if (byName.length === 1 && byName[0]) return byName[0];
  const names = doc.timeline.tracks.map((t) => `"${t.name}"`).join(', ');
  throw new ToolInputError(
    byName.length > 1
      ? `Several tracks are named "${ref}"; use the track ID from get_project.`
      : `No track "${ref}". Tracks: ${names}.`,
  );
}

function videoTrack(doc: Project, ref: string | undefined, kind: 'overlay' | 'screen'): VideoTrack {
  if (ref !== undefined) {
    const track = resolveTrack(doc, ref);
    if (track.type !== 'video' || track.layout.kind !== kind) {
      throw new ToolInputError(
        `Track "${track.name}" is not ${kind === 'overlay' ? 'a face (overlay)' : 'the screen'} track.`,
      );
    }
    return track;
  }
  const found = doc.timeline.tracks.find(
    (t): t is VideoTrack => t.type === 'video' && t.layout.kind === kind,
  );
  if (!found) {
    throw new ToolInputError(
      kind === 'overlay'
        ? 'This project has no face (camera) track.'
        : 'This project has no screen track.',
    );
  }
  return found;
}

const COMPONENT_WORDS: Record<string, 'face-voice' | 'system-audio' | 'screen'> = {
  'face-voice': 'face-voice',
  face: 'face-voice',
  camera: 'face-voice',
  voice: 'face-voice',
  mic: 'face-voice',
  microphone: 'face-voice',
  'system-audio': 'system-audio',
  system: 'system-audio',
  'system audio': 'system-audio',
  screen: 'screen',
};

function resolveComponentId(doc: Project, ref: string): string {
  if (doc.components.some((c) => c.id === ref)) return ref;
  const type = COMPONENT_WORDS[ref.trim().toLowerCase()];
  const component = type ? doc.components.find((c) => c.type === type) : undefined;
  if (!component) {
    const available = doc.components.map((c) => `"${c.type}"`).join(', ');
    throw new ToolInputError(`No component "${ref}". This project has ${available}.`);
  }
  return component.id;
}

function faceLayoutOps(
  doc: Project,
  step: Extract<EditStep, { kind: 'faceLayout' }>,
): ExternalOp[] {
  const track = videoTrack(doc, step.track, 'overlay');
  const canvas = doc.timeline.canvas;
  const frame = trackFrameSize(doc, track);
  let layout = { ...(track.layout as OverlayLayout) };
  if (step.shape !== undefined) layout.shape = step.shape;
  if (step.cornerRadius !== undefined) layout.cornerRadius = step.cornerRadius;
  if (step.mirror !== undefined) layout.mirror = step.mirror;
  if (step.size !== undefined) layout = applySizePreset(layout, step.size, canvas, frame);
  if (step.width !== undefined) layout.width = step.width;
  if (step.corner !== undefined) {
    layout = applyCornerPreset(layout, step.corner as (typeof FACE_CORNERS)[number], canvas, frame);
  }
  if (step.centerX !== undefined) layout.centerX = step.centerX;
  if (step.centerY !== undefined) layout.centerY = step.centerY;
  if (step.zoom !== undefined) layout.zoom = step.zoom;
  const { kind: _kind, border: _border, shadow: _shadow, ...patch } = layout;
  return [
    {
      type: 'setLayout',
      trackId: track.id,
      layout: {
        ...patch,
        ...(step.border !== undefined ? { border: step.border } : {}),
        ...(step.shadow !== undefined ? { shadow: step.shadow } : {}),
      },
    },
  ];
}

/** The operations for one step against `doc`. */
export function stepOps(doc: Project, step: EditStep): ExternalOp[] {
  const fps = doc.timeline.frameRate;
  const time = (t: TimeInput) => toUs(t, fps);
  switch (step.kind) {
    case 'cut': {
      const inUs = time(step.start);
      const outUs = time(step.end);
      if (outUs <= inUs) throw new ToolInputError('The cut must end after it starts.');
      return [{ type: 'cutRange', inUs, outUs }];
    }
    case 'trimEnds': {
      const durationUs = timelineDurationUs(doc);
      const ops: ExternalOp[] = [];
      // The end first, so cutting the start does not move it.
      if (step.endSeconds) {
        const inUs = Math.max(0, durationUs - Math.round(step.endSeconds * 1e6));
        if (inUs < durationUs) ops.push({ type: 'cutRange', inUs, outUs: durationUs });
      }
      if (step.startSeconds) {
        const outUs = Math.min(durationUs, Math.round(step.startSeconds * 1e6));
        if (outUs > 0) ops.push({ type: 'cutRange', inUs: 0, outUs });
      }
      if (ops.length === 0)
        throw new ToolInputError('Give startSeconds and/or endSeconds above 0.');
      return ops;
    }
    case 'split':
      return [
        {
          type: 'split',
          atUs: time(step.at),
          ...(step.clipIds ? { clipIds: step.clipIds } : {}),
        },
      ];
    case 'deleteClips':
      return [
        {
          type: step.ripple ? 'rippleDelete' : 'delete',
          clipIds: step.clipIds,
          ...(step.includeLinked !== undefined ? { includeLinked: step.includeLinked } : {}),
        },
      ];
    case 'trimClip':
      return [
        {
          type: 'trim',
          clipId: step.clipId,
          edge: step.edge,
          toUs: time(step.to),
          ...(step.includeLinked !== undefined ? { includeLinked: step.includeLinked } : {}),
        },
      ];
    case 'moveClip':
      return [
        {
          type: 'move',
          clipId: step.clipId,
          toStartUs: time(step.toStart),
          onOverlap: step.ifOccupied ?? 'nearest-free',
          ...(step.includeLinked !== undefined ? { includeLinked: step.includeLinked } : {}),
        },
      ];
    case 'track': {
      const { id: trackId } = resolveTrack(doc, step.track);
      const ops: ExternalOp[] = [];
      if (step.gainDb !== undefined) ops.push({ type: 'setGain', trackId, gainDb: step.gainDb });
      if (step.muted !== undefined) ops.push({ type: 'setMuted', trackId, muted: step.muted });
      if (step.solo !== undefined) ops.push({ type: 'setSolo', trackId, solo: step.solo });
      if (step.hidden !== undefined) ops.push({ type: 'setHidden', trackId, hidden: step.hidden });
      // Unlocking goes first and locking last, so the other settings apply either way.
      if (step.locked === false) ops.unshift({ type: 'setLocked', trackId, locked: false });
      if (step.locked === true) ops.push({ type: 'setLocked', trackId, locked: true });
      if (ops.length === 0) throw new ToolInputError('Give at least one track setting to change.');
      return ops;
    }
    case 'faceLayout':
      return faceLayoutOps(doc, step);
    case 'faceMode': {
      const track = videoTrack(doc, step.track, 'overlay');
      const startUs = time(step.start);
      const endUs = time(step.end);
      if (endUs <= startUs) throw new ToolInputError('The face mode must end after it starts.');
      return [
        {
          type: 'setFaceMode',
          trackId: track.id,
          startUs,
          endUs,
          mode: step.mode,
          easeUs: Math.round((step.transitionSeconds ?? 0) * 1e6),
        },
      ];
    }
    case 'faceKeyframe': {
      const track = videoTrack(doc, step.track, 'overlay');
      const tUs = time(step.at);
      if (step.remove) return [{ type: 'removeLayoutKeyframe', trackId: track.id, tUs }];
      const layout = {
        ...(step.width !== undefined ? { width: step.width } : {}),
        ...(step.centerX !== undefined ? { centerX: step.centerX } : {}),
        ...(step.centerY !== undefined ? { centerY: step.centerY } : {}),
      };
      return [
        {
          type: 'setLayoutKeyframe',
          trackId: track.id,
          tUs,
          ...(step.mode ? { mode: step.mode } : {}),
          ...(step.easing ? { easing: step.easing } : {}),
          ...(Object.keys(layout).length > 0 ? { layout } : {}),
        },
      ];
    }
    case 'background': {
      if (step.off) return [{ type: 'setBeautify', beautify: null }];
      if (step.color !== undefined && step.gradient !== undefined) {
        throw new ToolInputError('Give a colour or a gradient, not both.');
      }
      const background =
        step.color !== undefined
          ? { type: 'color' as const, color: step.color }
          : step.gradient
            ? {
                type: 'gradient' as const,
                from: step.gradient.from,
                to: step.gradient.to,
                angleDeg: step.gradient.angle ?? 135,
              }
            : undefined;
      const beautify = mergeBeautify(doc.timeline.beautify, {
        ...(background ? { background } : {}),
        ...(step.padding !== undefined ? { padding: step.padding } : {}),
        ...(step.cornerRadius !== undefined ? { cornerRadius: step.cornerRadius } : {}),
        ...(step.shadow !== undefined ? { shadow: step.shadow } : {}),
      });
      return [{ type: 'setBeautify', beautify }];
    }
    case 'zoom': {
      const startUs = time(step.start);
      const endUs = time(step.end);
      if (endUs <= startUs) throw new ToolInputError('The zoom must end after it starts.');
      return [
        {
          type: 'setCameraZoom',
          startUs,
          endUs,
          rect: cameraRect(step.zoom, step.centerX ?? 0.5, step.centerY ?? 0.5),
          easeUs: Math.round((step.transitionSeconds ?? 0.6) * 1e6),
        },
      ];
    }
    case 'zoomKeyframe': {
      const tUs = time(step.at);
      if (step.remove) return [{ type: 'removeCameraKeyframe', tUs }];
      const keys = doc.timeline.camera;
      const there = keys?.find((k) => k.tUs === tUs);
      const view = cameraView(there?.rect ?? cameraAt(keys, tUs));
      const moves = [step.zoom, step.centerX, step.centerY].some((v) => v !== undefined);
      return [
        {
          type: 'setCameraKeyframe',
          tUs,
          ...(moves
            ? {
                rect: cameraRect(
                  step.zoom ?? view.zoom,
                  step.centerX ?? view.centerX,
                  step.centerY ?? view.centerY,
                ),
              }
            : {}),
          ...(step.easing ? { easing: step.easing } : {}),
        },
      ];
    }
    case 'screenCrop': {
      const track = videoTrack(doc, step.track, 'screen');
      return [{ type: 'setLayout', trackId: track.id, layout: { crop: step.crop } }];
    }
    case 'syncNudge':
      return [
        {
          type: 'nudge',
          target: { componentId: resolveComponentId(doc, step.component) },
          syncAdjustUs: Math.round(step.offsetMs * 1000),
        },
      ];
    case 'marks': {
      const current = doc.timeline.marks;
      const mark = (value: TimeInput | null | undefined, keep: number | null) =>
        value === undefined ? keep : value === null ? null : time(value);
      return [
        {
          type: 'setMarks',
          inUs: mark(step.in, current.inUs),
          outUs: mark(step.out, current.outUs),
        },
      ];
    }
  }
}

/**
 * Every step's operations, each resolved against the document the previous steps produce.
 * Refusals surface here, with the step they belong to, before anything is sent.
 */
export function buildBatch(doc: Project, steps: readonly EditStep[]): ExternalOp[] {
  const all: ExternalOp[] = [];
  let current = doc;
  for (const [index, step] of steps.entries()) {
    const label = steps.length > 1 ? `Step ${String(index + 1)} (${step.kind}): ` : '';
    let ops: ExternalOp[];
    try {
      ops = stepOps(current, step);
    } catch (error) {
      if (error instanceof ToolInputError) throw new ToolInputError(label + error.message);
      throw error;
    }
    const applied = applyOpsWithPatches(current, ops);
    if (!applied.ok) throw opFailure(label + applied.error.message, applied.error.code, index);
    current = applied.value.doc;
    all.push(...ops);
  }
  return all;
}
