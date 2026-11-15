/**
 * Fixtures of the preview/export parity harness (`parity.spec.ts`; R1.48, §5 P2 acceptance a).
 * Each fixture is a synthetic project whose media FFmpeg generates, plus what to check at its
 * sampled frames. Every Phase 2 step that adds something visible adds a fixture here, so the
 * harness covers each object type and effect at 10 times.
 *
 * Media are colour-keyed: the screen is grey (`testsrc2` without saturation) and the camera is
 * flat magenta, so the face can be found in any picture.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { frameTimeUs } from '../../../src/shared/export/frame-render';
import { cameraRect } from '../../../src/shared/project/camera-keyframes';
import { DEFAULT_CURSOR_EFFECTS } from '../../../src/shared/project/cursor-effects';
import { serializeCursorTrack, type CursorEvent } from '../../../src/shared/project/cursor-track';
import { importedMediaEntry } from '../../../src/shared/project/media-import';
import { TEXT_PRESETS, newObject, type ObjectKind } from '../../../src/shared/project/objects';
import type { RectF } from '../../../src/shared/project/scene';
import { sceneAt } from '../../../src/shared/project/scene';
import type { FRect, Project, TimelineObject } from '../../../src/shared/project/schema';
import { applyOp, type TimelineOp } from '../../../src/shared/project/timeline-ops';
import { unwrap } from '../../../src/shared/result';
import { counterIds, recordedProject, trackByName } from '../../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../../..');
export const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
export const FFMPEG = path.join(FFMPEG_DIR, 'ffmpeg');
export const FFPROBE = path.join(FFMPEG_DIR, 'ffprobe');

export const FPS = 30;

/** A colour-keyed region whose bounding box must match the scene's rect (within the fixture's `maxRegionPx`, 2 px by default). */
export interface KeyedRegion {
  name: string;
  /** Whether an RGB pixel belongs to the region. */
  key: (r: number, g: number, b: number) => boolean;
  /** The region's rect in the scene at `tUs`, or null when it is not visible. */
  rectAt: (doc: Project, tUs: number) => RectF | null;
}

export interface ParityFixture {
  name: string;
  /** Builds the project folder (media and `project.json`) inside `projectsDir`. */
  build(projectsDir: string): { root: string; doc: Project };
  /** Ten output frames to compare. */
  frames: number[];
  /** Minimum SSIM between the preview and the export at each frame. */
  minSsim: number;
  regions: KeyedRegion[];
  /** Largest region box distance from the scene, in px (default 2). */
  maxRegionPx?: number;
  /**
   * A Phase 1 project: also export it with the filter graph, which must match the frame render
   * (switching paths changes nothing).
   */
  phase1: boolean;
}

const BT601 = [
  '-pix_fmt',
  'yuv420p',
  '-colorspace',
  'smpte170m',
  '-color_primaries',
  'smpte170m',
  '-color_trc',
  'smpte170m',
];

export function ff(args: string[]): Buffer {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

const W = 1280;
const H = 720;

/** The camera's centre square (`centreSquare` media), in camera pixels. */
const CAMERA_SQUARE = { x: 240, y: 180, width: 160, height: 120 };
/**
 * The screen's white square on a flat mid-grey patch (`screenSquare` media), in screen pixels.
 * Both are neutral, so the key reads luma, which yuv420 keeps at full resolution: a chroma key
 * would blur the edge by a pixel in the export and hide what the 1 px check measures.
 */
const SCREEN_SQUARE = { x: 400, y: 200, width: 160, height: 96 };
const SCREEN_PATCH_MARGIN = 40;

interface MediaOptions {
  /** A black `CAMERA_SQUARE` in the camera: shows the face crop and zoom. */
  centreSquare?: boolean;
  /** A white `SCREEN_SQUARE` on the screen: shows where the camera puts the screen. */
  screenSquare?: boolean;
}

function grow(r: typeof SCREEN_SQUARE, by: number) {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/** An FFmpeg `drawbox` filling `r`. */
function box(r: typeof SCREEN_SQUARE, color: string): string {
  return `drawbox=x=${String(r.x)}:y=${String(r.y)}:w=${String(r.width)}:h=${String(r.height)}:color=${color}:t=fill`;
}

/** The usual recording: a grey 1280×720 screen and a magenta 640×480 camera, BT.601 tagged. */
function writeMedia(root: string, seconds: number, options: MediaOptions = {}): void {
  const { centreSquare = false, screenSquare = false } = options;
  const media = path.join(root, 'media');
  mkdirSync(media, { recursive: true });
  const d = String(seconds);
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${String(W)}x${String(H)}:rate=${String(FPS)}:duration=${d}`,
    // Grey, so only the face is magenta (its colour key).
    '-vf',
    screenSquare
      ? `hue=s=0,${box(grow(SCREEN_SQUARE, SCREEN_PATCH_MARGIN), '0x808080')},${box(SCREEN_SQUARE, 'white')}`
      : 'hue=s=0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '16',
    '-g',
    '30',
    ...BT601,
    path.join(media, 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0xFF00FF:s=640x480:r=${String(FPS)}:d=${d}`,
    ...(centreSquare
      ? [
          '-vf',
          `drawbox=x=${String(CAMERA_SQUARE.x)}:y=${String(CAMERA_SQUARE.y)}:w=${String(CAMERA_SQUARE.width)}:h=${String(CAMERA_SQUARE.height)}:color=black:t=fill`,
        ]
      : []),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    ...BT601,
    path.join(media, 'camera.mp4'),
  ]);
}

/**
 * A recorded project with its own id and name: the library finds projects by id, so fixtures
 * must not share one. `serial` is one Crockford digit.
 */
function recorded(seconds: number, serial: string, name: string): Project {
  const doc = recordedProject({
    durationUs: seconds * 1_000_000,
    pauses: [],
    mic: false,
    system: false,
    screenSize: { width: W, height: H },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0 },
  });
  return { ...doc, id: `prj_01JBQ4ZJ4X6V3K8N2M7P5R9T${serial}P`, name };
}

function save(projectsDir: string, doc: Project, seconds: number, media: MediaOptions = {}) {
  const root = path.join(projectsDir, `${doc.name}.cstudio`);
  writeMedia(root, seconds, media);
  writeFileSync(path.join(root, 'project.json'), JSON.stringify(doc, null, 2));
  return { root, doc };
}

export const magenta = (r: number, g: number, b: number) => r > 170 && g < 90 && b > 170;

/** The face layer's rect in the scene (the camera track), or null when hidden or transparent. */
function faceRect(doc: Project, tUs: number): RectF | null {
  const face = trackByName(doc, 'Face').id;
  const layer = sceneAt(doc, tUs).layers.find((l) => l.trackId === face);
  return layer && layer.opacity > 0.99 ? layer.destRect : null;
}

const FACE: KeyedRegion = { name: 'face', key: magenta, rectAt: faceRect };

const green = (r: number, g: number, b: number) => g > 170 && r < 90 && b < 90;
const black = (r: number, g: number, b: number) => r < 40 && g < 40 && b < 40;

/** The face layer at `tUs`. */
function faceLayer(doc: Project, tUs: number) {
  const face = trackByName(doc, 'Face').id;
  return sceneAt(doc, tUs).layers.find((l) => l.trackId === face) ?? null;
}

/** Bordered face: the border colour covers the whole box, the picture is inset by its width. */
const BORDER: KeyedRegion = { name: 'border', key: green, rectAt: faceRect };
const FACE_INSIDE_BORDER: KeyedRegion = {
  name: 'face inside the border',
  key: magenta,
  rectAt: (doc, tUs) => {
    const layer = faceLayer(doc, tUs);
    const w = layer?.border?.widthPx ?? 0;
    return layer
      ? {
          x: layer.destRect.x + w,
          y: layer.destRect.y + w,
          width: layer.destRect.width - 2 * w,
          height: layer.destRect.height - 2 * w,
        }
      : null;
  },
};
/** The camera's centre square where the face's source rect (crop, zoom) puts it. */
const CAMERA_CENTRE: KeyedRegion = {
  name: 'camera centre square',
  key: black,
  rectAt: (doc, tUs) => {
    const layer = faceLayer(doc, tUs);
    if (!layer) return null;
    const src = layer.sourceRect;
    const dst = layer.destRect;
    const sx = dst.width / src.width;
    const sy = dst.height / src.height;
    return {
      x: dst.x + (CAMERA_SQUARE.x - src.x) * sx,
      y: dst.y + (CAMERA_SQUARE.y - src.y) * sy,
      width: CAMERA_SQUARE.width * sx,
      height: CAMERA_SQUARE.height * sy,
    };
  },
};

/** Phase 1: a rounded face overlay on the screen (the original R1.48 parity project). */
const roundedFace: ParityFixture = {
  name: 'p1-rounded-face',
  frames: [8, 25, 42, 59, 76, 93, 110, 127, 144, 161],
  // R1.48 asks for 0.95; this content scores about 0.96 half a second off, so 0.98 is held.
  minSsim: 0.98,
  regions: [FACE],
  phase1: true,
  build(projectsDir) {
    const seconds = 6;
    let doc = recorded(seconds, '1', 'Parity rounded face');
    doc = unwrap(
      applyOp(
        doc,
        {
          type: 'setLayout',
          trackId: trackByName(doc, 'Face').id,
          layout: {
            shape: 'rounded',
            cornerRadius: 0.2,
            width: 0.3,
            centerX: 0.72,
            centerY: 0.66,
          },
        },
        { generateId: counterIds('P') },
      ),
    );
    return save(projectsDir, doc, seconds);
  },
};

/**
 * Phase 2: face layout keyframes. Overlay, eased to full screen over 1 s, then side by side
 * (the screen moves into the left half), samples taken mid-transition too.
 */
const faceKeyframes: ParityFixture = {
  name: 'p2-face-keyframes',
  frames: [10, 40, 66, 75, 84, 100, 130, 141, 150, 170],
  minSsim: 0.98,
  regions: [FACE],
  phase1: false,
  build(projectsDir) {
    const seconds = 6;
    const doc = recorded(seconds, '2', 'Parity face keyframes');
    const face = trackByName(doc, 'Face');
    if (face.type !== 'video' || face.layout.kind !== 'overlay') throw new Error('no face track');
    const layout = { ...face.layout, shape: 'rounded' as const, cornerRadius: 0.15 };
    face.layoutKeyframes = [
      { tUs: 2_000_000, mode: 'overlay', layout, easing: 'ease-in-out' },
      { tUs: 3_000_000, mode: 'full', layout, easing: 'linear' },
      { tUs: 4_400_000, mode: 'full', layout, easing: 'ease-out' },
      { tUs: 5_000_000, mode: 'side-by-side', layout, easing: 'hold' },
    ];
    return save(projectsDir, doc, seconds);
  },
};

/** Phase 2: face zoom ×2, a green border and a drop shadow (R2.3, R2.4). */
const faceStyle: ParityFixture = {
  name: 'p2-face-style',
  frames: [5, 22, 39, 56, 73, 90, 107, 124, 141, 158],
  minSsim: 0.98,
  regions: [BORDER, FACE_INSIDE_BORDER, CAMERA_CENTRE],
  phase1: false,
  build(projectsDir) {
    const seconds = 6;
    let doc = recorded(seconds, '3', 'Parity face style');
    doc = unwrap(
      applyOp(
        doc,
        {
          type: 'setLayout',
          trackId: trackByName(doc, 'Face').id,
          layout: {
            shape: 'rounded',
            cornerRadius: 0.12,
            width: 0.35,
            centerX: 0.68,
            centerY: 0.6,
            zoom: 2,
            border: { width: 0.01, color: '#00FF00' },
            shadow: { blur: 0.03, offsetX: 0.01, offsetY: 0.02, color: '#000000B0' },
          },
        },
        { generateId: counterIds('S') },
      ),
    );
    return save(projectsDir, doc, seconds, { centreSquare: true });
  },
};

/** Brighter than halfway from the grey patch (128) to white: the square's edge at 50 %. */
const white = (r: number, g: number, b: number) => r > 191 && g > 191 && b > 191;
/** Grey screen pixels (the background gradient and its shadow are saturated). */
const grey = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) < 24;

/** The screen layer at `tUs`. */
function screenLayer(doc: Project, tUs: number) {
  const screen = trackByName(doc, 'Screen').id;
  return sceneAt(doc, tUs).layers.find((l) => l.trackId === screen) ?? null;
}

/** The screen's white square where the scene puts the screen (camera applied, acceptance b). */
const SCREEN_SQUARE_REGION: KeyedRegion = {
  name: 'screen square',
  key: white,
  rectAt: (doc, tUs) => {
    const layer = screenLayer(doc, tUs);
    if (!layer) return null;
    const src = layer.sourceRect;
    const dst = layer.destRect;
    const sx = dst.width / src.width;
    const sy = dst.height / src.height;
    return {
      x: dst.x + (SCREEN_SQUARE.x - src.x) * sx,
      y: dst.y + (SCREEN_SQUARE.y - src.y) * sy,
      width: SCREEN_SQUARE.width * sx,
      height: SCREEN_SQUARE.height * sy,
    };
  },
};
/** The padded screen on the background, checked while the camera shows the whole frame. */
const PADDED_SCREEN: KeyedRegion = {
  name: 'padded screen',
  key: grey,
  rectAt: (doc, tUs) => {
    const scene = sceneAt(doc, tUs);
    const full = scene.camera.width === 1 && scene.camera.height === 1;
    return full ? (screenLayer(doc, tUs)?.destRect ?? null) : null;
  },
};

/**
 * Phase 2: beautify (gradient background, padding, rounded corners, shadow) and a 2× camera zoom
 * on the screen's square, eased in over 0.6 s and out over 0.6 s (R2.9, R2.11). The square must
 * land within 1 px of the camera's pure function in preview and export (acceptance b).
 */
const beautifyCamera: ParityFixture = {
  name: 'p2-beautify-camera',
  // Before, easing in, zoomed, easing out, after.
  frames: [10, 45, 51, 56, 70, 100, 118, 124, 130, 160],
  minSsim: 0.98,
  regions: [SCREEN_SQUARE_REGION, PADDED_SCREEN],
  maxRegionPx: 1,
  phase1: false,
  build(projectsDir) {
    const seconds = 6;
    let doc = recorded(seconds, '4', 'Parity beautify camera');
    const ids = { generateId: counterIds('B') };
    doc = unwrap(
      applyOp(doc, { type: 'setHidden', trackId: trackByName(doc, 'Face').id, hidden: true }, ids),
    );
    doc = unwrap(
      applyOp(
        doc,
        {
          type: 'setBeautify',
          beautify: {
            background: { type: 'gradient', from: '#1E3A8A', to: '#7C3AED', angleDeg: 135 },
            padding: 0.08,
            cornerRadius: 0.03,
            shadow: { blur: 0.02, offsetX: 0, offsetY: 0.01, color: '#00000060' },
          },
        },
        ids,
      ),
    );
    // Centre the zoom on the square's position on the padded canvas.
    const layer = screenLayer(doc, 0);
    if (!layer) throw new Error('no screen layer');
    const k = layer.destRect.width / layer.sourceRect.width;
    const cx = (layer.destRect.x + (SCREEN_SQUARE.x + SCREEN_SQUARE.width / 2) * k) / W;
    const cy = (layer.destRect.y + (SCREEN_SQUARE.y + SCREEN_SQUARE.height / 2) * k) / H;
    doc = unwrap(
      applyOp(
        doc,
        {
          type: 'setCameraZoom',
          startUs: 2_000_000,
          endUs: 4_200_000,
          rect: cameraRect(2, cx, cy),
          easeUs: 600_000,
        },
        ids,
      ),
    );
    return save(projectsDir, doc, seconds, { screenSquare: true });
  },
};

/** A recorded project with the face hidden and `items` on an object track. */
function withObjects(serial: string, name: string, seconds: number, items: TimelineObject[]) {
  const doc = recorded(seconds, serial, name);
  const face = trackByName(doc, 'Face');
  if (face.type === 'video') face.hidden = true;
  doc.timeline.objectTracks = [
    {
      id: 'trk_01JBQ4ZJ4X6V3K8N2M7P5R9OBJ',
      name: 'Annotations',
      locked: false,
      hidden: false,
      items,
    },
  ];
  return doc;
}

const S = 1_000_000;
const objectId = (n: number) => `obj_01JBQ4ZJ4X6V3K8N2M7P5R9T${String(n).padStart(2, '0')}`;

/** Phase 2: text in the four bundled fonts, with a background, an outline and fades (R2.5). */
const textObjects: ParityFixture = {
  name: 'p2-text',
  frames: [5, 12, 20, 40, 70, 95, 110, 130, 150, 172],
  minSsim: 0.98,
  regions: [],
  phase1: false,
  build(projectsDir) {
    const seconds = 6;
    const text = (n: number, preset: keyof typeof TEXT_PRESETS, value: string, box: FRect) => ({
      ...newObject('text', objectId(n), 0, seconds * S, box),
      text: value,
      preset,
      style: { ...TEXT_PRESETS[preset] },
    });
    const items: TimelineObject[] = [
      {
        ...text(1, 'title', 'Capture Studio — Ångström', {
          x: 0.1,
          y: 0.05,
          width: 0.8,
          height: 0.16,
        }),
        fadeInUs: 600_000,
        fadeOutUs: 600_000,
        inUs: 0,
        outUs: 5 * S,
      },
      text(2, 'caption', 'A caption on a background that wraps onto a second line', {
        x: 0.05,
        y: 0.62,
        width: 0.42,
        height: 0.2,
      }),
      text(3, 'code', 'npm run test:e2e', { x: 0.55, y: 0.66, width: 0.4, height: 0.1 }),
      {
        ...text(4, 'label', 'Look here!', { x: 0.6, y: 0.3, width: 0.3, height: 0.12 }),
        inUs: 2 * S,
      },
      {
        ...text(5, 'subtitle', 'Serif italic', { x: 0.2, y: 0.84, width: 0.6, height: 0.1 }),
        style: { ...TEXT_PRESETS.subtitle, font: 'serif', italic: true },
      },
    ];
    return save(projectsDir, withObjects('5', 'Parity text', seconds, items), seconds);
  },
};

const red = (r: number, g: number, b: number) => r > 200 && g < 70 && b < 70;

/** The red rectangle callout's box, while no spotlight dims it. */
const RED_RECTANGLE: KeyedRegion = {
  name: 'rectangle callout',
  key: red,
  rectAt: (doc, tUs) => {
    const objects = sceneAt(doc, tUs).objects;
    if (objects.some((o) => o.item.kind === 'spotlight')) return null;
    return objects.find((o) => o.item.kind === 'rectangle')?.rectPx ?? null;
  },
};

/** Phase 2: every callout kind, an arrow moving on keyframes, a spotlight fading in (R2.6). */
const callouts: ParityFixture = {
  name: 'p2-callouts',
  frames: [5, 30, 45, 60, 90, 105, 112, 125, 150, 172],
  minSsim: 0.98,
  regions: [RED_RECTANGLE],
  phase1: false,
  build(projectsDir) {
    const seconds = 6;
    const all = <K extends ObjectKind>(kind: K, n: number, box: FRect) =>
      newObject(kind, objectId(n), 0, seconds * S, box);
    const arrowBox = { x: 0.45, y: 0.5, width: 0.15, height: 0.2 };
    const items: TimelineObject[] = [
      {
        ...all('rectangle', 1, { x: 0.08, y: 0.1, width: 0.3, height: 0.25 }),
        stroke: { color: '#FF0000', width: 0.008 },
      },
      {
        ...all('ellipse', 2, { x: 0.5, y: 0.08, width: 0.25, height: 0.3 }),
        stroke: { color: '#00C8FF', width: 0.006 },
        fill: '#00C8FF33',
      },
      {
        ...all('arrow', 3, arrowBox),
        stroke: { color: '#00FF00', width: 0.008 },
        keyframes: [
          { tUs: S, box: arrowBox, easing: 'ease-in-out' },
          { tUs: 4 * S, box: { ...arrowBox, x: 0.6, y: 0.55 }, easing: 'linear' },
        ],
      },
      {
        ...all('step', 4, { x: 0.1, y: 0.6, width: 0.07, height: 0.12 }),
        value: 2,
        fill: '#0000FF',
      },
      {
        ...all('step', 5, { x: 0.2, y: 0.6, width: 0.07, height: 0.12 }),
        value: 4,
        format: 'I',
      },
      all('highlight', 6, { x: 0.25, y: 0.78, width: 0.3, height: 0.06 }),
      {
        ...all('spotlight', 7, { x: 0.55, y: 0.1, width: 0.3, height: 0.4 }),
        inUs: 3.5 * S,
        outUs: 5.5 * S,
        fadeInUs: 300_000,
        dim: 0.5,
      },
    ];
    return save(projectsDir, withObjects('6', 'Parity callouts', seconds, items), seconds);
  },
};

/** Phase 2: a static blur and a pixelate region moving on keyframes (R2.7). */
const privacy: ParityFixture = {
  name: 'p2-privacy',
  frames: [5, 22, 39, 56, 73, 90, 107, 124, 141, 158],
  minSsim: 0.98,
  regions: [],
  phase1: false,
  build(projectsDir) {
    const seconds = 6;
    const pixBox = { x: 0.1, y: 0.55, width: 0.25, height: 0.2 };
    const items: TimelineObject[] = [
      {
        ...newObject('blur', objectId(1), 0, seconds * S, {
          x: 0.05,
          y: 0.05,
          width: 0.4,
          height: 0.35,
        }),
        radius: 0.02,
      },
      {
        ...newObject('pixelate', objectId(2), 0, seconds * S, pixBox),
        blockSize: 0.03,
        keyframes: [
          { tUs: 0, box: pixBox, easing: 'linear' },
          { tUs: 5 * S, box: { ...pixBox, x: 0.6, y: 0.4 }, easing: 'linear' },
        ],
      },
    ];
    return save(projectsDir, withObjects('7', 'Parity privacy', seconds, items), seconds);
  },
};

/**
 * Phase 2: time edits (R2.10, R2.18, R2.19): a fade from white at the start, 2× over 0.5–1.5 s,
 * a 0.5 s freeze frame, a dissolve across a cut (the outgoing clip keeps playing the cut part),
 * and a slide. Samples inside each.
 */
const timeEdits: ParityFixture = {
  name: 'p2-time',
  frames: [5, 20, 28, 50, 70, 95, 105, 112, 125, 133],
  minSsim: 0.98,
  regions: [],
  phase1: false,
  build(projectsDir) {
    const seconds = 6;
    let doc = recorded(seconds, '8', 'Parity time edits');
    const ids = { generateId: counterIds('E') };
    const op = (o: TimelineOp) => {
      doc = unwrap(applyOp(doc, o, ids));
    };
    op({ type: 'setHidden', trackId: trackByName(doc, 'Face').id, hidden: true });
    op({ type: 'setSpeed', inUs: 500_000, outUs: 1_500_000, speed: 2 });
    op({ type: 'freezeFrame', atUs: 1_500_000, durationUs: 500_000 });
    op({ type: 'cutRange', inUs: 3_000_000, outUs: 4_000_000 });
    op({ type: 'split', atUs: 4_000_000 });
    const screen = () => trackByName(doc, 'Screen').clips;
    const startingAt = (t: number) => {
      const clip = screen().find((c) => c.timelineStartUs === t);
      if (!clip) throw new Error(`no screen clip at ${String(t)}`);
      return clip.id;
    };
    op({
      type: 'setTransition',
      clipId: startingAt(0),
      transition: { kind: 'fade-color', durationUs: 400_000, color: '#FFFFFF' },
    });
    op({
      type: 'setTransition',
      clipId: startingAt(3_000_000),
      transition: { kind: 'dissolve', durationUs: 800_000 },
    });
    op({
      type: 'setTransition',
      clipId: startingAt(4_000_000),
      transition: { kind: 'slide', durationUs: 600_000, direction: 'left' },
    });
    return save(projectsDir, doc, seconds);
  },
};

/**
 * Phase 2: a picture background (R2.11). The picture is 1600×1200 (4:3), so "cover" crops its
 * top and bottom on the 16:9 canvas; the padded screen sits on it with rounded corners.
 */
const imageBackground: ParityFixture = {
  name: 'p2-image-background',
  frames: [0, 15, 30, 45, 60, 75, 90, 105, 120, 140],
  minSsim: 0.98,
  regions: [],
  phase1: false,
  build(projectsDir) {
    const seconds = 5;
    let doc = recorded(seconds, '9', 'Parity image background');
    const ids = { generateId: counterIds('G') };
    doc = unwrap(
      applyOp(doc, { type: 'setHidden', trackId: trackByName(doc, 'Face').id, hidden: true }, ids),
    );
    const pictureId = 'med_01JBQ4ZJ4X6V3K8N2M7P5R9PIC';
    const picture = importedMediaEntry(pictureId, 'media/background.mp4', {
      kind: 'video',
      durationUs: 33_334,
      video: { codec: 'h264', width: 1600, height: 1200, frameRateNominal: 30 },
    });
    doc = unwrap(
      applyOp(
        doc,
        {
          type: 'setBeautify',
          beautify: {
            background: { type: 'image', mediaId: pictureId, color: '#000000' },
            padding: 0.1,
            cornerRadius: 0.03,
          },
          media: [picture],
        },
        ids,
      ),
    );
    const saved = save(projectsDir, doc, seconds);
    // A smooth, colourful picture (one frame, like an imported PNG).
    ff([
      '-f',
      'lavfi',
      '-i',
      'gradients=s=1600x1200:c0=0x2050C0:c1=0xE0A030:c2=0x30A060:n=3:speed=0:d=0.04',
      '-frames:v',
      '1',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '16',
      ...BT601,
      path.join(saved.root, 'media', 'background.mp4'),
    ]);
    return saved;
  },
};

/**
 * Phase 3: cursor effects from a synthetic cursor track (R3.10): a smoothed, enlarged drawn
 * cursor (the screen video has none), click rings, a highlight, and a 2× camera zoom that the
 * effects follow. The track circles the screen with jitter, with presses at 1.0, 1.2 and 4.5 s.
 */
const cursorEffects: ParityFixture = {
  name: 'p3-cursor-effects',
  // Moving, ring growing (three), zoomed (two), ring at 4.5 s (two), late.
  frames: [15, 31, 36, 45, 60, 90, 100, 136, 140, 170],
  minSsim: 0.95,
  regions: [],
  phase1: false,
  build(projectsDir) {
    const seconds = 6;
    let doc = recorded(seconds, 'A', 'Parity cursor effects');
    const ids = { generateId: counterIds('C') };
    doc = unwrap(
      applyOp(doc, { type: 'setHidden', trackId: trackByName(doc, 'Face').id, hidden: true }, ids),
    );
    const screen = doc.media.find((m) => m.role === 'screen');
    if (!screen) throw new Error('no screen media');
    const events: CursorEvent[] = [];
    const presses = [1_000_000, 1_200_000, 4_500_000];
    const done = new Set<number>();
    for (let i = 0; i <= seconds * 120; i++) {
      const tUs = Math.round((i * 1_000_000) / 120);
      const a = (tUs / 1_000_000) * 1.3;
      const jitter = i % 2 === 0 ? 3 : -3;
      const x = Math.round(W / 2 + Math.cos(a) * 380 + jitter);
      const y = Math.round(H / 2 + Math.sin(a) * 220);
      const press = presses.find((p) => p >= tUs && p < tUs + 8_334 && !done.has(p));
      if (press !== undefined) {
        done.add(press);
        events.push({ tUs: press, x, y, action: 'down', button: 'left' });
        events.push({ tUs: press + 60_000, x, y, action: 'up', button: 'left' });
      } else if (!events.some((e) => e.tUs > tUs)) {
        events.push({ tUs, x, y });
      }
    }
    const cursorMedia: Project['media'][number] = {
      id: 'med_01JBQ4ZJ4X6V3K8N2M7P5R9CUR',
      role: 'cursor',
      kind: 'cursor',
      path: 'media/cursor.jsonl',
      status: 'ok',
      durationUs: seconds * 1_000_000,
      startOffsetUs: screen.startOffsetUs,
      syncAdjustUs: 0,
      clockRatio: 1,
      cursor: {
        screenMediaId: screen.id,
        inVideo: false,
        sampleRateHz: 120,
        samples: events.length,
        clicks: presses.length,
      },
    };
    doc = { ...doc, media: [...doc.media, cursorMedia] };
    doc = unwrap(
      applyOp(
        doc,
        {
          type: 'setCursorEffects',
          effects: {
            ...DEFAULT_CURSOR_EFFECTS,
            smoothing: 0.6,
            size: 1.5,
            clickRings: { enabled: true, color: '#FFB020', size: 0.05, durationUs: 600_000 },
            highlight: { enabled: true, color: '#FFE45C59', radius: 0.04 },
          },
        },
        ids,
      ),
    );
    doc = unwrap(
      applyOp(
        doc,
        {
          type: 'setCameraZoom',
          startUs: 2_600_000,
          endUs: 3_800_000,
          rect: cameraRect(2, 0.5, 0.5),
          easeUs: 300_000,
        },
        ids,
      ),
    );
    const saved = save(projectsDir, doc, seconds);
    writeFileSync(
      path.join(saved.root, 'media', 'cursor.jsonl'),
      serializeCursorTrack({ sampleRateHz: 120, width: W, height: H }, events),
    );
    return saved;
  },
};

export const FIXTURES: readonly ParityFixture[] = [
  roundedFace,
  faceKeyframes,
  faceStyle,
  beautifyCamera,
  textObjects,
  callouts,
  privacy,
  timeEdits,
  imageBackground,
  cursorEffects,
];

/** Timeline time of an output frame. */
export function exportFrameTimeUs(n: number): number {
  return frameTimeUs(n, FPS);
}
