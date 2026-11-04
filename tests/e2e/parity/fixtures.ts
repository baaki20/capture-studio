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
import type { RectF } from '../../../src/shared/project/scene';
import { sceneAt } from '../../../src/shared/project/scene';
import type { Project } from '../../../src/shared/project/schema';
import { applyOp } from '../../../src/shared/project/timeline-ops';
import { unwrap } from '../../../src/shared/result';
import { counterIds, recordedProject, trackByName } from '../../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../../..');
export const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
export const FFMPEG = path.join(FFMPEG_DIR, 'ffmpeg');
export const FFPROBE = path.join(FFMPEG_DIR, 'ffprobe');

export const FPS = 30;

/** A colour-keyed region whose bounding box must match the scene's rect (within 2 px). */
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
 * The usual recording: a grey 1280×720 screen and a magenta 640×480 camera, BT.601 tagged. With
 * `centreSquare` the camera has a black `CAMERA_SQUARE`, which shows the face crop and zoom.
 */
function writeMedia(root: string, seconds: number, centreSquare = false): void {
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
    'hue=s=0',
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

function save(projectsDir: string, doc: Project, seconds: number, centreSquare = false) {
  const root = path.join(projectsDir, `${doc.name}.cstudio`);
  writeMedia(root, seconds, centreSquare);
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
    return save(projectsDir, doc, seconds, true);
  },
};

export const FIXTURES: readonly ParityFixture[] = [roundedFace, faceKeyframes, faceStyle];

/** Timeline time of an output frame. */
export function exportFrameTimeUs(n: number): number {
  return frameTimeUs(n, FPS);
}
