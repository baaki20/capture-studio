/**
 * The inspector (R1.40–R1.42, R2.1–R2.9, R2.11): per-track gain, mute, solo, hide and lock; the face
 * overlay (corner and size presets, size, shape, radius, mirror, crop, zoom); its border and
 * shadow; its layout over time (face mode for the In–Out range or from the playhead, and the
 * keyframe list); the screen crop; annotations (R2.5–R2.8, in `ObjectSections.tsx`: the selected
 * one's editor on top, the add buttons below the screen); speed, freeze frames, the selected
 * clip's transition and markers (R2.10, R2.18–R2.20, in `TimeSections.tsx`); clip gain and fades,
 * noise reduction, ducking, volume keyframes, normalization and pauses (R2.12–R2.17, in
 * `AudioSections.tsx`); the background and zoom (R2.9, R2.11,
 * in `ScreenStyleSections.tsx`); and the sync nudge of Face + Voice and System audio with the
 * recorded clock information. Every control maps to a timeline operation through
 * `inspector-ops.ts`; sliders group a whole drag into one undo step. Geometry shown and edited is
 * the keyframe in effect at the playhead.
 */
import { useState, type ReactNode } from 'react';
import {
  BORDER_WIDTH_MAX,
  FACE_CORNERS,
  FACE_SIZE_PRESETS,
  FACE_WIDTH_MAX,
  FACE_WIDTH_MIN,
  FACE_ZOOM_MAX,
  FACE_ZOOM_MIN,
  SHADOW_BLUR_MAX,
  SHADOW_OFFSET_MAX,
  type Corner,
  type FaceSizePreset,
} from '../../../shared/project/face-layout';
import {
  EASINGS,
  FACE_MODES,
  type AudioTrack,
  type Easing,
  type NRect,
  type OverlayLayout,
  type Project,
  type VideoTrack,
} from '../../../shared/project/schema';
import { formatTimecode } from '../../../shared/time';
import {
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  GAIN_STEP_DB,
  trackFrameSize,
} from '../../../shared/project/timeline-ops';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { useDocumentStore } from '../store/document-store';
import { useUi } from '../ui-store';
import { useApply, useGesture } from './hooks';
import { AudioCleanupSection, ClipAudioSection, PausesSection } from './AudioSections';
import { MediaSection } from './MediaSection';
import { AnnotationsSection, ObjectSection } from './ObjectSections';
import { BackgroundSection, CameraSection } from './ScreenStyleSections';
import { MarkersSection, SpeedSection, TransitionSection } from './TimeSections';
import {
  DEFAULT_BORDER,
  DEFAULT_SHADOW,
  EASING_LABELS,
  FACE_MODE_LABELS,
  NUDGE_MAX_MS,
  addKeyframeOp,
  alphaOf,
  borderOp,
  cornerOp,
  cropOp,
  faceLayoutAt,
  faceModeOp,
  faceTrack,
  gainOp,
  keyframeEasingOp,
  mirrorOp,
  removeKeyframeOp,
  shadowOp,
  withAlpha,
  zoomOp,
  nudgeOp,
  radiusOp,
  resetGainOp,
  screenTrack,
  shapeOp,
  sizeOp,
  sizePresetOp,
  syncComponents,
  toggleOp,
  type ComponentSync,
} from './inspector-ops';

const CORNER_LABELS: Record<Corner, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
};

const SHAPES: { value: OverlayLayout['shape']; label: string }[] = [
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'circle', label: 'Circle' },
];

export function InspectorPanel() {
  const { docStore } = useEditor();
  const doc = useDocumentStore(docStore, (s) => s.doc);
  if (!doc) return null;
  return (
    <aside className={styles.inspector} aria-label="Inspector" data-testid="inspector">
      {/* The selected annotation first: it shows only while one is selected. */}
      <ObjectSection doc={doc} />
      <TransitionSection doc={doc} />
      <ClipAudioSection doc={doc} />
      <TracksSection doc={doc} />
      <FaceSection doc={doc} />
      <FaceStyleSection doc={doc} />
      <FaceTimeSection doc={doc} />
      <ScreenSection doc={doc} />
      <MediaSection doc={doc} />
      <AnnotationsSection doc={doc} />
      <SpeedSection doc={doc} />
      <AudioCleanupSection doc={doc} />
      <PausesSection doc={doc} />
      <MarkersSection doc={doc} />
      <BackgroundSection doc={doc} />
      <CameraSection doc={doc} />
      <SyncSection doc={doc} />
    </aside>
  );
}

function TracksSection({ doc }: { doc: Project }) {
  const apply = useApply();
  return (
    <section>
      <h2>Tracks</h2>
      {doc.timeline.tracks.map((track) =>
        track.type === 'audio' ? (
          <GainRow key={track.id} track={track} />
        ) : (
          <div key={track.id} className={styles.field}>
            <span>{track.name}</span>
            <span className={styles.group}>
              <button
                type="button"
                aria-pressed={track.hidden}
                onClick={() => apply(toggleOp(track, 'hide'))}
              >
                {track.hidden ? 'Hidden' : 'Visible'}
              </button>
              <button
                type="button"
                aria-pressed={track.locked}
                onClick={() => apply(toggleOp(track, 'lock'))}
              >
                Lock
              </button>
            </span>
            <span />
          </div>
        ),
      )}
    </section>
  );
}

function GainRow({ track }: { track: AudioTrack }) {
  const apply = useApply();
  const gesture = useGesture();
  return (
    <div className={styles.field} data-testid={`gain-${track.name}`}>
      <label htmlFor={`gain-${track.id}`}>{track.name}</label>
      <input
        id={`gain-${track.id}`}
        type="range"
        min={GAIN_MIN_DB}
        max={GAIN_MAX_DB}
        step={GAIN_STEP_DB}
        value={track.gainDb}
        aria-label={`${track.name} volume`}
        title="Double-click to reset to 0 dB"
        onChange={(e) => apply(gainOp(track.id, Number(e.target.value)))}
        onDoubleClick={() => apply(resetGainOp(track.id))}
        {...gesture}
      />
      <span className={styles.group}>
        <span
          className={styles.muted}
        >{`${track.gainDb > 0 ? '+' : ''}${track.gainDb.toFixed(1)} dB`}</span>
        <button
          type="button"
          aria-pressed={track.muted}
          aria-label={`Mute ${track.name}`}
          onClick={() => apply(toggleOp(track, 'mute'))}
        >
          M
        </button>
        <button
          type="button"
          aria-pressed={track.solo}
          aria-label={`Solo ${track.name}`}
          onClick={() => apply(toggleOp(track, 'solo'))}
        >
          S
        </button>
      </span>
    </div>
  );
}

function FaceSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const gesture = useGesture();
  const { ui } = useEditor();
  const playheadUs = useUi(ui, (s) => s.playheadUs);
  const track = faceTrack(doc);
  if (!track) return null;
  // Style is the track's; geometry is the keyframe's in effect at the playhead.
  const layout = track.layout;
  const shown = faceLayoutAt(doc, track.id, playheadUs);
  const width = shown?.layout.width ?? layout.width;
  const frame = trackFrameSize(doc, track);
  return (
    <section data-testid="face-panel">
      <h2>Face overlay</h2>
      <div className={styles.field}>
        <span>Corner</span>
        <span className={styles.group} style={{ flexWrap: 'wrap' }}>
          {FACE_CORNERS.map((corner) => (
            <button
              key={corner}
              type="button"
              onClick={() => apply(cornerOp(doc, track.id, corner, playheadUs))}
            >
              {CORNER_LABELS[corner]}
            </button>
          ))}
        </span>
        <span />
      </div>
      <div className={styles.field}>
        <label htmlFor="face-size">Size</label>
        <input
          id="face-size"
          type="range"
          min={FACE_WIDTH_MIN}
          max={FACE_WIDTH_MAX}
          step={0.005}
          value={width}
          onChange={(e) => apply(sizeOp(doc, track.id, Number(e.target.value), playheadUs))}
          {...gesture}
        />
        <span className={styles.muted}>{`${String(Math.round(width * 100))} %`}</span>
      </div>
      <div className={styles.field}>
        <span />
        <span className={styles.group}>
          {(Object.keys(FACE_SIZE_PRESETS) as FaceSizePreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => apply(sizePresetOp(doc, track.id, preset, playheadUs))}
            >
              {preset.charAt(0).toUpperCase() + preset.slice(1)}
            </button>
          ))}
        </span>
        <span />
      </div>
      <div className={styles.field}>
        <span>Shape</span>
        <span className={styles.group} role="radiogroup" aria-label="Shape">
          {SHAPES.map((shape) => (
            <button
              key={shape.value}
              type="button"
              role="radio"
              aria-checked={layout.shape === shape.value}
              aria-pressed={layout.shape === shape.value}
              onClick={() => apply(shapeOp(track.id, shape.value))}
            >
              {shape.label}
            </button>
          ))}
        </span>
        <span />
      </div>
      {layout.shape === 'rounded' ? (
        <div className={styles.field}>
          <label htmlFor="face-radius">Radius</label>
          <input
            id="face-radius"
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={layout.cornerRadius}
            onChange={(e) => apply(radiusOp(track.id, Number(e.target.value)))}
            {...gesture}
          />
          <span
            className={styles.muted}
          >{`${String(Math.round(layout.cornerRadius * 100))} %`}</span>
        </div>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="face-mirror">Mirror</label>
        <input
          id="face-mirror"
          type="checkbox"
          checked={layout.mirror}
          onChange={(e) => apply(mirrorOp(track.id, e.target.checked))}
        />
        <span />
      </div>
      <div className={styles.field}>
        <label htmlFor="face-zoom">Zoom</label>
        <input
          id="face-zoom"
          type="range"
          min={FACE_ZOOM_MIN}
          max={FACE_ZOOM_MAX}
          step={0.05}
          value={layout.zoom ?? 1}
          onChange={(e) => apply(zoomOp(track.id, Number(e.target.value)))}
          {...gesture}
        />
        <span className={styles.muted}>{`${(layout.zoom ?? 1).toFixed(2)}×`}</span>
      </div>
      <CropFields
        label="Face crop"
        crop={layout.crop}
        frame={frame}
        onChange={(crop) => apply(cropOp(track.id, crop))}
      />
      <p className={styles.muted}>
        Drag the face in the preview to move it; drag a corner to resize.
        {track.layoutKeyframes ? ' Position and size change the keyframe at the playhead.' : ''}
      </p>
    </section>
  );
}

/** Border and drop shadow of the face (R2.4), as fractions of the canvas's short side. */
function FaceStyleSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const gesture = useGesture();
  const track = faceTrack(doc);
  if (!track) return null;
  const { border, shadow } = track.layout;
  const short = Math.min(doc.timeline.canvas.width, doc.timeline.canvas.height);
  const px = (fraction: number) => `${String(Math.round(fraction * short))} px`;
  return (
    <section data-testid="face-style-panel">
      <h2>Border and shadow</h2>
      <div className={styles.field}>
        <label htmlFor="face-border">Border</label>
        <input
          id="face-border"
          type="checkbox"
          checked={border !== undefined}
          onChange={(e) => apply(borderOp(track.id, e.target.checked ? DEFAULT_BORDER : null))}
        />
        {border ? (
          <input
            type="color"
            aria-label="Border colour"
            value={border.color.slice(0, 7)}
            onChange={(e) => apply(borderOp(track.id, { ...border, color: e.target.value }))}
          />
        ) : (
          <span />
        )}
      </div>
      {border ? (
        <div className={styles.field}>
          <label htmlFor="face-border-width">Width</label>
          <input
            id="face-border-width"
            type="range"
            min={0.001}
            max={BORDER_WIDTH_MAX / 2}
            step={0.001}
            value={border.width}
            onChange={(e) =>
              apply(borderOp(track.id, { ...border, width: Number(e.target.value) }))
            }
            {...gesture}
          />
          <span className={styles.muted}>{px(border.width)}</span>
        </div>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="face-shadow">Shadow</label>
        <input
          id="face-shadow"
          type="checkbox"
          checked={shadow !== undefined}
          onChange={(e) => apply(shadowOp(track.id, e.target.checked ? DEFAULT_SHADOW : null))}
        />
        {shadow ? (
          <input
            type="color"
            aria-label="Shadow colour"
            value={shadow.color.slice(0, 7)}
            onChange={(e) =>
              apply(
                shadowOp(track.id, {
                  ...shadow,
                  color: withAlpha(e.target.value, alphaOf(shadow.color)),
                }),
              )
            }
          />
        ) : (
          <span />
        )}
      </div>
      {shadow ? (
        <>
          <div className={styles.field}>
            <label htmlFor="face-shadow-blur">Blur</label>
            <input
              id="face-shadow-blur"
              type="range"
              min={0}
              max={SHADOW_BLUR_MAX}
              step={0.002}
              value={shadow.blur}
              onChange={(e) =>
                apply(shadowOp(track.id, { ...shadow, blur: Number(e.target.value) }))
              }
              {...gesture}
            />
            <span className={styles.muted}>{px(shadow.blur)}</span>
          </div>
          <div className={styles.field}>
            <label htmlFor="face-shadow-distance">Distance</label>
            <input
              id="face-shadow-distance"
              type="range"
              min={0}
              max={SHADOW_OFFSET_MAX}
              step={0.002}
              value={shadow.offsetY}
              onChange={(e) =>
                apply(shadowOp(track.id, { ...shadow, offsetY: Number(e.target.value) }))
              }
              {...gesture}
            />
            <span className={styles.muted}>{px(shadow.offsetY)}</span>
          </div>
          <div className={styles.field}>
            <label htmlFor="face-shadow-opacity">Opacity</label>
            <input
              id="face-shadow-opacity"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={alphaOf(shadow.color)}
              onChange={(e) =>
                apply(
                  shadowOp(track.id, {
                    ...shadow,
                    color: withAlpha(shadow.color, Number(e.target.value)),
                  }),
                )
              }
              {...gesture}
            />
            <span
              className={styles.muted}
            >{`${String(Math.round(alphaOf(shadow.color) * 100))} %`}</span>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Transition lengths offered for a face mode over the In–Out range. */
const MODE_EASES: { us: number; label: string }[] = [
  { us: 0, label: 'Cut' },
  { us: 300_000, label: '0.3 s' },
  { us: 600_000, label: '0.6 s' },
  { us: 1_000_000, label: '1 s' },
];

/** Layout over time (R2.1, R2.2): face mode and the keyframe list. */
function FaceTimeSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const { ui, playback } = useEditor();
  const playheadUs = useUi(ui, (s) => s.playheadUs);
  const [easeUs, setEaseUs] = useState(300_000);
  const track = faceTrack(doc);
  if (!track) return null;
  const fps = doc.timeline.frameRate;
  const { inUs, outUs } = doc.timeline.marks;
  const range = inUs !== null && outUs !== null && outUs > inUs;
  const current = faceLayoutAt(doc, track.id, playheadUs);
  return (
    <section data-testid="face-time-panel">
      <h2>Layout over time</h2>
      <p className={styles.muted}>
        {range
          ? `Face mode for In–Out (${formatTimecode(inUs, fps)}–${formatTimecode(outUs, fps)}):`
          : 'Face mode from the playhead on (set In and Out for a section):'}
      </p>
      <div className={styles.field}>
        <span>Mode</span>
        <span
          className={styles.group}
          style={{ flexWrap: 'wrap' }}
          role="group"
          aria-label="Face mode"
        >
          {FACE_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={current?.mode === mode}
              onClick={() => apply(faceModeOp(doc, track.id, mode, playheadUs, easeUs))}
            >
              {FACE_MODE_LABELS[mode]}
            </button>
          ))}
        </span>
        <span />
      </div>
      {range ? (
        <div className={styles.field}>
          <label htmlFor="face-mode-ease">Change</label>
          <select
            id="face-mode-ease"
            value={easeUs}
            onChange={(e) => setEaseUs(Number(e.target.value))}
          >
            {MODE_EASES.map((option) => (
              <option key={option.us} value={option.us}>
                {option.label}
              </option>
            ))}
          </select>
          <span />
        </div>
      ) : null}
      <KeyframeList
        track={track}
        fps={fps}
        activeUs={current?.keyTime ?? null}
        onSeek={(tUs) => playback.seek(tUs)}
      />
      <button type="button" onClick={() => apply(addKeyframeOp(track.id, playheadUs))}>
        Add keyframe at playhead
      </button>
    </section>
  );
}

function KeyframeList(props: {
  track: VideoTrack;
  fps: number;
  activeUs: number | null;
  onSeek: (tUs: number) => void;
}) {
  const apply = useApply();
  const keys = props.track.layoutKeyframes ?? [];
  if (keys.length === 0) {
    return <p className={styles.muted}>No keyframes: the face keeps one layout.</p>;
  }
  return (
    <ul className={styles.keyframeList} aria-label="Layout keyframes" data-testid="keyframe-list">
      {keys.map((key) => (
        <li key={key.tUs} aria-current={key.tUs === props.activeUs ? 'true' : undefined}>
          <button
            type="button"
            className={styles.linkButton}
            title="Go to this keyframe"
            onClick={() => props.onSeek(key.tUs)}
          >
            {formatTimecode(key.tUs, props.fps)}
          </button>
          <span>{FACE_MODE_LABELS[key.mode]}</span>
          <select
            aria-label={`Change after ${formatTimecode(key.tUs, props.fps)}`}
            value={key.easing}
            onChange={(e) =>
              apply(keyframeEasingOp(props.track.id, key.tUs, e.target.value as Easing))
            }
          >
            {EASINGS.map((easing) => (
              <option key={easing} value={easing}>
                {EASING_LABELS[easing]}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={`Delete keyframe at ${formatTimecode(key.tUs, props.fps)}`}
            onClick={() => apply(removeKeyframeOp(props.track.id, key.tUs))}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function ScreenSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const track = screenTrack(doc);
  if (track?.layout.kind !== 'screen') return null;
  return (
    <section data-testid="screen-panel">
      <h2>Screen</h2>
      <CropFields
        label="Crop"
        crop={track.layout.crop}
        frame={trackFrameSize(doc, track)}
        onChange={(crop) => apply(cropOp(track.id, crop))}
      />
    </section>
  );
}

function CropFields(props: {
  label: string;
  crop: NRect | null;
  frame: { width: number; height: number };
  onChange: (crop: NRect | null) => void;
}) {
  const current = props.crop ?? {
    x: 0,
    y: 0,
    width: props.frame.width,
    height: props.frame.height,
  };
  // Edits stay local until committed (blur or Enter); otherwise the fields show the document.
  const [draft, setDraft] = useState<NRect | null>(null);
  const shown = draft ?? current;
  const commit = () => {
    if (!draft) return;
    setDraft(null);
    const values = [draft.x, draft.y, draft.width, draft.height];
    if (!values.every(Number.isFinite) || draft.width <= 0 || draft.height <= 0) return;
    if (JSON.stringify(draft) !== JSON.stringify(current)) props.onChange(draft);
  };
  const field = (name: keyof NRect, label: string): ReactNode => (
    <label className={styles.muted}>
      {label}
      <input
        type="number"
        value={shown[name]}
        min={0}
        aria-label={`${props.label} ${label}`}
        onChange={(e) => setDraft({ ...shown, [name]: Math.round(Number(e.target.value)) })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );
  return (
    <div>
      <div className={styles.field}>
        <span>{props.label}</span>
        <span className={styles.muted}>{props.crop ? 'Custom' : 'Full frame'}</span>
        <button type="button" disabled={!props.crop} onClick={() => props.onChange(null)}>
          Reset
        </button>
      </div>
      <div className={styles.cropGrid}>
        {field('x', 'X')}
        {field('y', 'Y')}
        {field('width', 'W')}
        {field('height', 'H')}
      </div>
    </div>
  );
}

function SyncSection({ doc }: { doc: Project }) {
  const components = syncComponents(doc);
  if (components.length === 0) return null;
  return (
    <section data-testid="sync-panel">
      <h2>Sync</h2>
      <p className={styles.muted}>Offset relative to the screen. Positive plays later.</p>
      {components.map((c) => (
        <SyncRow key={c.component.id} sync={c} />
      ))}
    </section>
  );
}

function SyncRow({ sync }: { sync: ComponentSync }) {
  const apply = useApply();
  // While the field has focus it shows what is typed; otherwise the document's value.
  const [editing, setEditing] = useState<string | null>(null);
  const set = (ms: number) => {
    if (Number.isFinite(ms)) apply(nudgeOp(sync.component.id, ms));
  };
  const id = `nudge-${sync.component.id}`;
  return (
    <div data-testid={`sync-${sync.component.type}`}>
      <div className={styles.field}>
        <label htmlFor={id}>{sync.label}</label>
        <span className={styles.group}>
          <button
            type="button"
            aria-label={`${sync.label} −10 ms`}
            onClick={() => set(sync.offsetMs - 10)}
          >
            −10
          </button>
          <input
            id={id}
            type="number"
            min={-NUDGE_MAX_MS}
            max={NUDGE_MAX_MS}
            step={1}
            value={editing ?? String(sync.offsetMs)}
            aria-label={`${sync.label} offset (ms)`}
            onFocus={() => setEditing(String(sync.offsetMs))}
            onBlur={() => setEditing(null)}
            onChange={(e) => {
              setEditing(e.target.value);
              if (e.target.value.trim() !== '' && e.target.value !== '-')
                set(Number(e.target.value));
            }}
          />
          <button
            type="button"
            aria-label={`${sync.label} +10 ms`}
            onClick={() => set(sync.offsetMs + 10)}
          >
            +10
          </button>
        </span>
        <span className={styles.muted}>ms</span>
      </div>
      <ul className={styles.syncInfo}>
        {sync.media.map((m) => (
          <li key={m.mediaId}>
            {m.label}:{' '}
            {m.mode === 'arrival-calibrated'
              ? 'arrival-calibrated clock'
              : m.mode === 'shared'
                ? 'shared capture clock'
                : 'clock unknown'}
            {m.outputLatencyMs !== null
              ? `, output latency ${m.outputLatencyMs.toFixed(1)} ms applied`
              : ''}
            {m.captureLatencyMs !== null
              ? `, camera latency ${m.captureLatencyMs.toFixed(1)} ms applied`
              : ''}
            {m.clockHandshakeMs !== null ? `, handshake ${m.clockHandshakeMs.toFixed(2)} ms` : ''}
            {m.driftPpm !== 0
              ? `, drift ${m.driftPpm > 0 ? '+' : ''}${String(m.driftPpm)} ppm corrected`
              : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
