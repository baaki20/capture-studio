/**
 * Background and zoom panels of the inspector (R2.9, R2.11). The background panel turns the
 * beautify setting on and off and edits its fill (swatches, colours, gradient angle), padding,
 * rounded corners and shadow. The zoom panel edits the camera keyframe in effect at the playhead
 * (zoom and centre), zooms the In–Out range, and lists the camera keyframes. Operations come
 * from `screen-style-ops.ts`; sliders group a whole drag into one undo step.
 */
import { useState } from 'react';
import { CAMERA_ZOOM_MAX } from '../../../shared/project/camera-keyframes';
import { SHADOW_BLUR_MAX } from '../../../shared/project/face-layout';
import { EASINGS, type Easing, type Project } from '../../../shared/project/schema';
import { formatTimecode } from '../../../shared/time';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { useUi } from '../ui-store';
import { useApply, useGesture } from './hooks';
import { alphaOf, EASING_LABELS, withAlpha } from './inspector-ops';
import {
  addCameraKeyframeOp,
  BACKGROUND_PRESETS,
  backgroundCss,
  beautifyOp,
  cameraEasingOp,
  cameraEditOp,
  cameraStateAt,
  cameraZoomOp,
  DEFAULT_SCREEN_SHADOW,
  gradientOf,
  plainBackgroundOp,
  removeCameraKeyframeOp,
} from './screen-style-ops';

const percent = (fraction: number) => `${String(Math.round(fraction * 100))} %`;

/** Screen background, padding, corners and shadow (R2.11). */
export function BackgroundSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const gesture = useGesture();
  const beautify = doc.timeline.beautify;
  const shadow = beautify?.shadow;
  const short = Math.min(doc.timeline.canvas.width, doc.timeline.canvas.height);
  const px = (fraction: number) => `${String(Math.round(fraction * short))} px`;
  return (
    <section data-testid="background-panel">
      <h2>Background</h2>
      <div className={styles.field}>
        <label htmlFor="beautify-on">Styled</label>
        <input
          id="beautify-on"
          type="checkbox"
          checked={beautify !== undefined}
          onChange={(e) => apply(e.target.checked ? beautifyOp(doc, {}) : plainBackgroundOp())}
        />
        <span />
      </div>
      {beautify ? (
        <>
          <div className={styles.swatches} role="group" aria-label="Background presets">
            {BACKGROUND_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={styles.swatch}
                title={preset.label}
                aria-label={preset.label}
                aria-pressed={
                  JSON.stringify(preset.background) === JSON.stringify(beautify.background)
                }
                style={{ background: backgroundCss(preset.background) }}
                onClick={() => apply(beautifyOp(doc, { background: preset.background }))}
              />
            ))}
          </div>
          <div className={styles.field}>
            <span>Fill</span>
            <span className={styles.group}>
              <input
                type="color"
                aria-label={beautify.background.type === 'gradient' ? 'Gradient start' : 'Colour'}
                value={
                  beautify.background.type === 'gradient'
                    ? beautify.background.from
                    : beautify.background.color
                }
                onChange={(e) =>
                  apply(
                    beautifyOp(doc, {
                      background:
                        beautify.background.type === 'gradient'
                          ? gradientOf(beautify.background, { from: e.target.value })
                          : { type: 'color', color: e.target.value },
                    }),
                  )
                }
              />
              {beautify.background.type === 'gradient' ? (
                <input
                  type="color"
                  aria-label="Gradient end"
                  value={beautify.background.to}
                  onChange={(e) =>
                    apply(
                      beautifyOp(doc, {
                        background: gradientOf(beautify.background, { to: e.target.value }),
                      }),
                    )
                  }
                />
              ) : null}
            </span>
            <button
              type="button"
              onClick={() =>
                apply(
                  beautifyOp(doc, {
                    background:
                      beautify.background.type === 'gradient'
                        ? { type: 'color', color: beautify.background.from }
                        : gradientOf(beautify.background, {}),
                  }),
                )
              }
            >
              {beautify.background.type === 'gradient' ? 'Solid' : 'Gradient'}
            </button>
          </div>
          {beautify.background.type === 'gradient' ? (
            <Slider
              id="beautify-angle"
              label="Angle"
              min={0}
              max={360}
              step={5}
              value={beautify.background.angleDeg}
              shown={`${String(beautify.background.angleDeg)}°`}
              onChange={(angleDeg) =>
                apply(
                  beautifyOp(doc, { background: gradientOf(beautify.background, { angleDeg }) }),
                )
              }
              gesture={gesture}
            />
          ) : null}
          <Slider
            id="beautify-padding"
            label="Padding"
            min={0}
            max={0.2}
            step={0.005}
            value={beautify.padding}
            shown={px(beautify.padding)}
            onChange={(padding) => apply(beautifyOp(doc, { padding }))}
            gesture={gesture}
          />
          <Slider
            id="beautify-radius"
            label="Corners"
            min={0}
            max={0.1}
            step={0.002}
            value={beautify.cornerRadius}
            shown={px(beautify.cornerRadius)}
            onChange={(cornerRadius) => apply(beautifyOp(doc, { cornerRadius }))}
            gesture={gesture}
          />
          <div className={styles.field}>
            <label htmlFor="beautify-shadow">Shadow</label>
            <input
              id="beautify-shadow"
              type="checkbox"
              checked={shadow !== undefined}
              onChange={(e) =>
                apply(beautifyOp(doc, { shadow: e.target.checked ? DEFAULT_SCREEN_SHADOW : null }))
              }
            />
            <span />
          </div>
          {shadow ? (
            <>
              <Slider
                id="beautify-shadow-blur"
                label="Blur"
                min={0}
                max={SHADOW_BLUR_MAX}
                step={0.002}
                value={shadow.blur}
                shown={px(shadow.blur)}
                onChange={(blur) => apply(beautifyOp(doc, { shadow: { ...shadow, blur } }))}
                gesture={gesture}
              />
              <Slider
                id="beautify-shadow-opacity"
                label="Opacity"
                min={0}
                max={1}
                step={0.05}
                value={alphaOf(shadow.color)}
                shown={percent(alphaOf(shadow.color))}
                onChange={(opacity) =>
                  apply(
                    beautifyOp(doc, {
                      shadow: { ...shadow, color: withAlpha(shadow.color, opacity) },
                    }),
                  )
                }
                gesture={gesture}
              />
            </>
          ) : null}
        </>
      ) : (
        <p className={styles.muted}>The screen fills the canvas on a plain background.</p>
      )}
    </section>
  );
}

/** Transition lengths offered for a zoomed In–Out range. */
const ZOOM_EASES: { us: number; label: string }[] = [
  { us: 0, label: 'Cut' },
  { us: 300_000, label: '0.3 s' },
  { us: 600_000, label: '0.6 s' },
  { us: 1_000_000, label: '1 s' },
];

const ZOOM_STEPS = [1.5, 2, 3];

/** Zoom and pan (R2.9): the keyframe at the playhead, a zoomed range, the keyframe list. */
export function CameraSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const gesture = useGesture();
  const { ui, playback } = useEditor();
  const playheadUs = useUi(ui, (s) => s.playheadUs);
  const [easeUs, setEaseUs] = useState(600_000);
  const fps = doc.timeline.frameRate;
  const { inUs, outUs } = doc.timeline.marks;
  const range = inUs !== null && outUs !== null && outUs > inUs;
  const state = cameraStateAt(doc, playheadUs);
  const keys = doc.timeline.camera ?? [];
  return (
    <section data-testid="camera-panel">
      <h2>Zoom and pan</h2>
      <p className={styles.muted}>
        {range
          ? `Zoom In–Out (${formatTimecode(inUs, fps)}–${formatTimecode(outUs, fps)}):`
          : 'Zoom from the playhead on (set In and Out for a section):'}
      </p>
      <div className={styles.field}>
        <span>Zoom</span>
        <span className={styles.group} role="group" aria-label="Zoom presets">
          {ZOOM_STEPS.map((zoom) => (
            <button
              key={zoom}
              type="button"
              onClick={() => apply(cameraZoomOp(doc, playheadUs, zoom, easeUs))}
            >
              {`${String(zoom)}×`}
            </button>
          ))}
        </span>
        <span />
      </div>
      {range ? (
        <div className={styles.field}>
          <label htmlFor="camera-ease">Change</label>
          <select
            id="camera-ease"
            value={easeUs}
            onChange={(e) => setEaseUs(Number(e.target.value))}
          >
            {ZOOM_EASES.map((option) => (
              <option key={option.us} value={option.us}>
                {option.label}
              </option>
            ))}
          </select>
          <span />
        </div>
      ) : null}
      <Slider
        id="camera-zoom"
        label="Scale"
        min={1}
        max={CAMERA_ZOOM_MAX}
        step={0.05}
        value={state.zoom}
        shown={`${state.zoom.toFixed(2)}×`}
        onChange={(zoom) => apply(cameraEditOp(doc, playheadUs, { zoom }))}
        gesture={gesture}
      />
      <Slider
        id="camera-x"
        label="Centre X"
        min={0}
        max={1}
        step={0.005}
        value={state.centerX}
        shown={percent(state.centerX)}
        disabled={state.zoom <= 1}
        onChange={(centerX) => apply(cameraEditOp(doc, playheadUs, { centerX }))}
        gesture={gesture}
      />
      <Slider
        id="camera-y"
        label="Centre Y"
        min={0}
        max={1}
        step={0.005}
        value={state.centerY}
        shown={percent(state.centerY)}
        disabled={state.zoom <= 1}
        onChange={(centerY) => apply(cameraEditOp(doc, playheadUs, { centerY }))}
        gesture={gesture}
      />
      {keys.length === 0 ? (
        <p className={styles.muted}>No zoom keyframes: the whole canvas is shown.</p>
      ) : (
        <ul
          className={styles.keyframeList}
          aria-label="Zoom keyframes"
          data-testid="camera-keyframe-list"
        >
          {keys.map((key) => (
            <li key={key.tUs} aria-current={key.tUs === state.keyTime ? 'true' : undefined}>
              <button
                type="button"
                className={styles.linkButton}
                title="Go to this keyframe"
                onClick={() => playback.seek(key.tUs)}
              >
                {formatTimecode(key.tUs, fps)}
              </button>
              <span>{`${(1 / Math.max(key.rect.width, key.rect.height)).toFixed(2)}×`}</span>
              <select
                aria-label={`Zoom change after ${formatTimecode(key.tUs, fps)}`}
                value={key.easing}
                onChange={(e) => apply(cameraEasingOp(key.tUs, e.target.value as Easing))}
              >
                {EASINGS.map((easing) => (
                  <option key={easing} value={easing}>
                    {EASING_LABELS[easing]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Delete zoom keyframe at ${formatTimecode(key.tUs, fps)}`}
                onClick={() => apply(removeCameraKeyframeOp(key.tUs))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => apply(addCameraKeyframeOp(playheadUs))}>
        Add zoom keyframe at playhead
      </button>
    </section>
  );
}

function Slider(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  shown: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  gesture: ReturnType<typeof useGesture>;
}) {
  return (
    <div className={styles.field}>
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        {...props.gesture}
      />
      <span className={styles.muted}>{props.shown}</span>
    </div>
  );
}
