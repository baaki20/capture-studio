/**
 * Timeline objects (v2, R2.5–R2.8): text and titles, callouts (arrow, rectangle, ellipse, step,
 * highlight, spotlight) and privacy regions (blur, pixelate). Pure: defaults for a new object,
 * text style presets, step labels, box keyframe edits, and the draw plan of an object in the
 * scene (where its picture goes on the output frame and the sizes it is drawn with). The editor's
 * rasteriser (`renderer/editor/preview/object-raster.ts`) draws the plan with canvas 2D and the
 * compositor composites it, in the preview and the export alike.
 *
 * Sizes stored as fractions: text size of the canvas height; strokes, blur radius and pixelate
 * blocks of the canvas's short side. The draw plan turns them into output pixels, camera zoom
 * included (objects zoom with the screen).
 */
import type { Us } from '../time';
import { objectBoxAt, type SceneObject } from './scene';
import type { Easing, FRect, TimelineObject } from './schema';

export type ObjectKind = TimelineObject['kind'];
/** An object of one kind (rectangle and ellipse share a schema, so `Extract` cannot narrow). */
export type ObjectOf<K extends ObjectKind> = TimelineObject & { kind: K };
export type TextObject = Extract<TimelineObject, { kind: 'text' }>;
export type TextStyle = TextObject['style'];

export const OBJECT_KINDS = [
  'text',
  'arrow',
  'rectangle',
  'ellipse',
  'step',
  'highlight',
  'spotlight',
  'blur',
  'pixelate',
] as const satisfies readonly ObjectKind[];

export const OBJECT_KIND_LABELS: Record<ObjectKind, string> = {
  text: 'Text',
  arrow: 'Arrow',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  step: 'Step',
  highlight: 'Highlight',
  spotlight: 'Spotlight',
  blur: 'Blur',
  pixelate: 'Pixelate',
};

/** A short name for an object in lists and on the timeline. */
export function objectLabel(item: TimelineObject): string {
  if (item.kind === 'text') {
    const first = item.text.split('\n')[0]?.trim() ?? '';
    return first === '' ? 'Text' : first;
  }
  if (item.kind === 'step') return `Step ${stepLabel(item.value, item.format)}`;
  return OBJECT_KIND_LABELS[item.kind];
}

/** Length of an object added without one. */
export const DEFAULT_OBJECT_US = 3_000_000;
/** Easing of a box keyframe added without one (regions follow motion at a steady pace). */
export const DEFAULT_OBJECT_EASING: Easing = 'linear';

/** Text style presets (`preset` on the object records which one it came from). */
export const TEXT_PRESETS = {
  title: {
    font: 'sans',
    size: 0.09,
    color: '#FFFFFF',
    bold: true,
    italic: false,
    align: 'center',
    outline: { color: '#000000B3', width: 0.004 },
  },
  subtitle: {
    font: 'sans',
    size: 0.055,
    color: '#FFFFFF',
    bold: false,
    italic: false,
    align: 'center',
    background: '#000000A6',
  },
  caption: {
    font: 'sans',
    size: 0.04,
    color: '#FFFFFF',
    bold: false,
    italic: false,
    align: 'left',
    background: '#000000A6',
  },
  label: {
    font: 'handwriting',
    size: 0.06,
    color: '#FFD60A',
    bold: true,
    italic: false,
    align: 'left',
    outline: { color: '#000000', width: 0.003 },
  },
  code: {
    font: 'mono',
    size: 0.04,
    color: '#E5E7EB',
    bold: false,
    italic: false,
    align: 'left',
    background: '#111827E6',
  },
} as const satisfies Record<string, TextStyle>;

export type TextPreset = keyof typeof TEXT_PRESETS;

const ACCENT = '#EF4444';

/** The default box of a new object of `kind` (canvas fractions), centred. */
export function defaultBox(kind: ObjectKind): FRect {
  const size: Record<ObjectKind, [number, number]> = {
    text: [0.6, 0.14],
    arrow: [0.16, 0.16],
    rectangle: [0.3, 0.25],
    ellipse: [0.3, 0.25],
    step: [0.06, 0.1],
    highlight: [0.3, 0.07],
    spotlight: [0.3, 0.3],
    blur: [0.25, 0.15],
    pixelate: [0.25, 0.15],
  };
  const [w, h] = size[kind];
  return { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h };
}

/** A new object of `kind` with its defaults, shown on `[inUs, outUs)`. */
export function newObject<K extends ObjectKind>(
  kind: K,
  id: string,
  inUs: Us,
  outUs: Us,
  box: FRect = defaultBox(kind),
): ObjectOf<K> {
  return defaults(kind, id, inUs, outUs, box) as ObjectOf<K>;
}

function defaults(kind: ObjectKind, id: string, inUs: Us, outUs: Us, box: FRect): TimelineObject {
  const base = { id, inUs, outUs, box };
  const stroke = { color: ACCENT, width: 0.006 };
  switch (kind) {
    case 'text':
      return { ...base, kind, text: 'Text', preset: 'title', style: { ...TEXT_PRESETS.title } };
    case 'arrow':
      return { ...base, kind, tail: 'bottom-left', stroke, head: 'triangle' };
    case 'rectangle':
    case 'ellipse':
      return { ...base, kind, stroke };
    case 'step':
      return { ...base, kind, value: 1, format: '1', fill: ACCENT, textColor: '#FFFFFF' };
    case 'highlight':
      return { ...base, kind, color: '#FFE60066' };
    case 'spotlight':
      return { ...base, kind, shape: 'ellipse', dim: 0.6 };
    case 'blur':
      return { ...base, kind, radius: 0.012 };
    case 'pixelate':
      return { ...base, kind, blockSize: 0.02 };
  }
}

/** The label of a step number in its format: 1, A, a, I or i. */
export function stepLabel(value: number, format: '1' | 'A' | 'a' | 'I' | 'i'): string {
  switch (format) {
    case '1':
      return String(value);
    case 'A':
    case 'a': {
      let n = value;
      let out = '';
      while (n > 0) {
        n -= 1;
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26);
      }
      return format === 'a' ? out.toLowerCase() : out;
    }
    case 'I':
    case 'i': {
      const numerals: [number, string][] = [
        [1000, 'M'],
        [900, 'CM'],
        [500, 'D'],
        [400, 'CD'],
        [100, 'C'],
        [90, 'XC'],
        [50, 'L'],
        [40, 'XL'],
        [10, 'X'],
        [9, 'IX'],
        [5, 'V'],
        [4, 'IV'],
        [1, 'I'],
      ];
      let n = value;
      let out = '';
      for (const [v, s] of numerals) {
        while (n >= v) {
          out += s;
          n -= v;
        }
      }
      return format === 'i' ? out.toLowerCase() : out;
    }
  }
}

/** The next step number on a timeline: one more than the largest so far. */
export function nextStepValue(items: readonly TimelineObject[]): number {
  let max = 0;
  for (const item of items) if (item.kind === 'step') max = Math.max(max, item.value);
  return Math.min(999, max + 1);
}

// ---------------------------------------------------------------------------------------------
// Box keyframes

type BoxKeyframe = NonNullable<TimelineObject['keyframes']>[number];

/**
 * Sets the box keyframe at `tUs` (inside the object's times): changes the one there, or adds one
 * starting from the box shown. An object's first keyframe after its start also gets an anchor at
 * its start with the box it had, so the region moves from there.
 */
export function upsertBoxKeyframe(
  item: TimelineObject,
  tUs: Us,
  change: { box?: FRect; easing?: Easing },
): BoxKeyframe[] {
  const list = [...(item.keyframes ?? [])];
  const index = list.findIndex((k) => k.tUs === tUs);
  const existing = list[index];
  if (existing) {
    list[index] = {
      tUs,
      box: change.box ?? existing.box,
      easing: change.easing ?? existing.easing,
    };
    return list;
  }
  const shown = objectBoxAt(item, tUs);
  if (list.length === 0 && tUs > item.inUs) {
    list.push({ tUs: item.inUs, box: item.box, easing: DEFAULT_OBJECT_EASING });
  }
  list.push({ tUs, box: change.box ?? shown, easing: change.easing ?? DEFAULT_OBJECT_EASING });
  return list.sort((a, b) => a.tUs - b.tUs);
}

// ---------------------------------------------------------------------------------------------
// Draw plan

/** A rect on the output frame, in pixels (may be fractional or partly outside the frame). */
export interface PxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How one scene object is drawn on the output frame:
 * - `raster`: a picture the rasteriser draws with canvas 2D at `size` (whole pixels) and the
 *   compositor places at `rect`; `key` changes whenever the picture does, so it is cached.
 *   `inner` is the object's box inside the picture (arrows and spotlights draw outside it).
 * - `blur` / `pixelate`: a region of the picture under it, blurred (Gaussian, `radiusPx` ≈ 3σ)
 *   or in blocks of `blockPx`.
 */
export type ObjectDrawPlan =
  | {
      kind: 'raster';
      key: string;
      rect: PxRect;
      size: { width: number; height: number };
      inner: PxRect;
      /** Output pixels per canvas short side (strokes, text outline). */
      unitPx: number;
      /** Output pixels per canvas height (text size). */
      heightPx: number;
      item: TimelineObject;
      opacity: number;
    }
  | { kind: 'blur'; rect: PxRect; radiusPx: number; opacity: number }
  | { kind: 'pixelate'; rect: PxRect; blockPx: number; opacity: number };

/** The visual fields of an object (what its picture depends on, not where or when it shows). */
function visualKey(item: TimelineObject): string {
  const {
    id: _id,
    inUs: _in,
    outUs: _out,
    box: _box,
    keyframes: _keys,
    opacity: _opacity,
    fadeInUs: _fadeIn,
    fadeOutUs: _fadeOut,
    ...visual
  } = item;
  return JSON.stringify(visual);
}

/**
 * The draw plan of a scene object on an output frame of `frame` size, where `canvas` is the
 * timeline canvas and `zoom` the camera's magnification (1 / camera width).
 */
export function objectDrawPlan(
  object: SceneObject,
  canvas: { width: number; height: number },
  zoom = 1,
): ObjectDrawPlan {
  const { item, rectPx, opacity } = object;
  const unitPx = Math.min(canvas.width, canvas.height) * zoom;
  const heightPx = canvas.height * zoom;
  if (item.kind === 'blur') {
    return { kind: 'blur', rect: rectPx, radiusPx: item.radius * unitPx, opacity };
  }
  if (item.kind === 'pixelate') {
    return {
      kind: 'pixelate',
      rect: rectPx,
      blockPx: Math.max(1, item.blockSize * unitPx),
      opacity,
    };
  }
  let rect: PxRect = rectPx;
  if (item.kind === 'spotlight') {
    // Dims the whole frame except the box.
    rect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  } else if (item.kind === 'arrow') {
    // Room for the head and the line's caps around the box.
    const margin = arrowHeadPx(item.stroke.width * unitPx);
    rect = {
      x: rectPx.x - margin,
      y: rectPx.y - margin,
      width: rectPx.width + 2 * margin,
      height: rectPx.height + 2 * margin,
    };
  }
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const size = {
    width: Math.max(1, Math.ceil(rect.x + rect.width) - x),
    height: Math.max(1, Math.ceil(rect.y + rect.height) - y),
  };
  const inner = { x: rectPx.x - x, y: rectPx.y - y, width: rectPx.width, height: rectPx.height };
  // Whole-pixel placement: the picture is drawn 1:1, so it is as sharp as canvas 2D drew it.
  const placed = { x, y, width: size.width, height: size.height };
  const r = (v: number) => Math.round(v * 100) / 100;
  const key = [
    visualKey(item),
    size.width,
    size.height,
    r(inner.x),
    r(inner.y),
    r(inner.width),
    r(inner.height),
    r(unitPx),
    r(heightPx),
  ].join('|');
  return { kind: 'raster', key, rect: placed, size, inner, unitPx, heightPx, item, opacity };
}

/** The draw plans of a scene's objects, bottom to top (camera zoom applied). */
export function sceneObjectPlans(scene: {
  canvas: { width: number; height: number };
  camera: FRect;
  objects: readonly SceneObject[];
}): ObjectDrawPlan[] {
  const zoom = 1 / scene.camera.width;
  return scene.objects.map((object) => objectDrawPlan(object, scene.canvas, zoom));
}

/** Length of an arrow's head for a line `widthPx` wide. */
export function arrowHeadPx(widthPx: number): number {
  return Math.max(10, widthPx * 4);
}

/** Start and end of an arrow in its box (`w × h`), from the tail corner to the opposite one. */
export function arrowEnds(
  tail: Extract<TimelineObject, { kind: 'arrow' }>['tail'],
  w: number,
  h: number,
): { from: [number, number]; to: [number, number] } {
  const left = tail.endsWith('left');
  const top = tail.startsWith('top');
  return {
    from: [left ? 0 : w, top ? 0 : h],
    to: [left ? w : 0, top ? h : 0],
  };
}

/**
 * Lines of `text` for a text object: broken at newlines and wrapped at spaces to `maxWidth`, as
 * measured with the canvas context's current font (a word longer than the width stays whole).
 */
export function wrapLines(
  ctx: { measureText(text: string): { width: number } },
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/(\s+)/).filter((w) => w.length > 0);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line.trim() !== '' && ctx.measureText(candidate.trimEnd()).width > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
