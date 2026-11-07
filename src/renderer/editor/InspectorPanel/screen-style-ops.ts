/**
 * Screen background and zoom in the inspector (R2.9, R2.11): intents → timeline operations. Pure,
 * so the mapping is unit-tested; `ScreenStyleSections.tsx` renders the controls.
 *
 * Background: every change sends the whole beautify setting (`setBeautify`), built from the
 * current one or, when the background is still plain, from `DEFAULT_BEAUTIFY`.
 *
 * Zoom: the controls show and edit the camera keyframe in effect at the playhead (zoom and centre;
 * rects keep the canvas's aspect). Without keyframes an edit adds one at the playhead. "Zoom"
 * over the In–Out marks makes a zoomed range (`setCameraZoom`), centred where the camera looks at
 * the playhead.
 */
import {
  cameraKeyAt,
  cameraRect,
  cameraView,
  FULL_CAMERA,
} from '../../../shared/project/camera-keyframes';
import {
  DEFAULT_BEAUTIFY,
  DEFAULT_SCREEN_SHADOW,
  mergeBeautify,
  type BeautifyChange,
} from '../../../shared/project/beautify';
import type { Beautify, Easing, Media, Project } from '../../../shared/project/schema';
import type { TimelineOp } from '../../../shared/project/timeline-ops';

export { DEFAULT_SCREEN_SHADOW };

/** Backgrounds offered as one-click swatches. */
export const BACKGROUND_PRESETS: { label: string; background: Beautify['background'] }[] = [
  { label: 'Indigo to pink', background: DEFAULT_BEAUTIFY.background },
  {
    label: 'Teal to blue',
    background: { type: 'gradient', from: '#0D9488', to: '#1D4ED8', angleDeg: 135 },
  },
  {
    label: 'Amber to red',
    background: { type: 'gradient', from: '#F59E0B', to: '#DC2626', angleDeg: 160 },
  },
  {
    label: 'Slate',
    background: { type: 'gradient', from: '#334155', to: '#0F172A', angleDeg: 180 },
  },
  { label: 'White', background: { type: 'color', color: '#F8FAFC' } },
  { label: 'Black', background: { type: 'color', color: '#000000' } },
];

/** The CSS for a background swatch (the compositor draws gradients the CSS way). */
export function backgroundCss(background: Beautify['background']): string {
  return background.type === 'gradient'
    ? `linear-gradient(${String(background.angleDeg)}deg, ${background.from}, ${background.to})`
    : background.color;
}

/** A picture background (R2.11) from an imported picture, added in the same undo step. */
export function imageBackgroundOp(doc: Project, picture: Media): TimelineOp {
  const current = doc.timeline.beautify?.background;
  const color = current?.type === 'gradient' ? current.from : (current?.color ?? '#000000');
  return {
    type: 'setBeautify',
    beautify: mergeBeautify(doc.timeline.beautify, {
      background: { type: 'image', mediaId: picture.id, color },
    }),
    media: [picture],
  };
}

/** The background with its fill colour changed (a picture keeps its picture). */
export function withFillColor(
  background: Beautify['background'],
  color: string,
): Beautify['background'] {
  return background.type === 'image' ? { ...background, color } : { type: 'color', color };
}

/** The picture removed: its fill colour stays as a solid background. */
export function withoutPicture(background: Beautify['background']): Beautify['background'] {
  return background.type === 'image' ? { type: 'color', color: background.color } : background;
}

/** The beautify setting after a change, starting from the defaults when the background is plain. */
export function beautifyOp(doc: Project, change: BeautifyChange): TimelineOp {
  return { type: 'setBeautify', beautify: mergeBeautify(doc.timeline.beautify, change) };
}

/** Back to the plain canvas colour. */
export function plainBackgroundOp(): TimelineOp {
  return { type: 'setBeautify', beautify: null };
}

/** The gradient with one end colour or the angle changed (a colour becomes a gradient from it). */
export function gradientOf(
  background: Beautify['background'],
  change: { from?: string; to?: string; angleDeg?: number },
): Beautify['background'] {
  const base =
    background.type === 'gradient'
      ? background
      : { type: 'gradient' as const, from: background.color, to: background.color, angleDeg: 135 };
  return { ...base, ...change };
}

export interface CameraState {
  zoom: number;
  centerX: number;
  centerY: number;
  /** The keyframe edits change (in effect at the playhead), or null without keyframes. */
  keyTime: number | null;
}

/** The zoom and centre of the camera keyframe in effect at `atUs`. */
export function cameraStateAt(doc: Project, atUs: number): CameraState {
  const key = cameraKeyAt(doc.timeline.camera, atUs);
  return { ...cameraView(key?.rect ?? FULL_CAMERA), keyTime: key?.tUs ?? null };
}

/** Changes the zoom or centre of the keyframe in effect at `atUs` (adds one there without any). */
export function cameraEditOp(
  doc: Project,
  atUs: number,
  change: { zoom?: number; centerX?: number; centerY?: number },
): TimelineOp {
  const state = cameraStateAt(doc, atUs);
  const rect = cameraRect(
    change.zoom ?? state.zoom,
    change.centerX ?? state.centerX,
    change.centerY ?? state.centerY,
  );
  return { type: 'setCameraKeyframe', tUs: state.keyTime ?? atUs, rect };
}

/**
 * Zooms by `zoom` over the In–Out marks when both are set (eased by `easeUs`), centred where the
 * camera looks at the playhead (the canvas centre when it shows the full frame); otherwise sets
 * the zoom of the keyframe at the playhead.
 */
export function cameraZoomOp(doc: Project, atUs: number, zoom: number, easeUs: number): TimelineOp {
  const { inUs, outUs } = doc.timeline.marks;
  const state = cameraStateAt(doc, atUs);
  if (inUs !== null && outUs !== null && outUs > inUs) {
    const rect = cameraRect(zoom, state.centerX, state.centerY);
    return { type: 'setCameraZoom', startUs: inUs, endUs: outUs, rect, easeUs };
  }
  return {
    type: 'setCameraKeyframe',
    tUs: atUs,
    rect: cameraRect(zoom, state.centerX, state.centerY),
  };
}

export function addCameraKeyframeOp(atUs: number): TimelineOp {
  return { type: 'setCameraKeyframe', tUs: atUs };
}

export function cameraEasingOp(tUs: number, easing: Easing): TimelineOp {
  return { type: 'setCameraKeyframe', tUs, easing };
}

export function removeCameraKeyframeOp(tUs: number): TimelineOp {
  return { type: 'removeCameraKeyframe', tUs };
}
