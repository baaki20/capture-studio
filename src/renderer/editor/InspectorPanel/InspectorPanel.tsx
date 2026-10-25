/**
 * The inspector (R1.40–R1.42): per-track gain, mute, solo, hide and lock; the face overlay
 * (corner and size presets, size, shape, radius, mirror, crop); the screen crop; and the sync
 * nudge of Face + Voice and System audio with the recorded clock information. Every control maps
 * to a timeline operation through `inspector-ops.ts`; sliders group a whole drag into one undo
 * step.
 */
import { useState, type ReactNode } from 'react';
import {
  FACE_CORNERS,
  FACE_SIZE_PRESETS,
  FACE_WIDTH_MAX,
  FACE_WIDTH_MIN,
  type Corner,
  type FaceSizePreset,
} from '../../../shared/project/face-layout';
import type { AudioTrack, NRect, OverlayLayout, ProjectV1 } from '../../../shared/project/schema';
import {
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  GAIN_STEP_DB,
  trackFrameSize,
  type TimelineOp,
} from '../../../shared/project/timeline-ops';
import { errorText } from '../commands';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { useDocumentStore } from '../store/document-store';
import {
  NUDGE_MAX_MS,
  cornerOp,
  cropOp,
  faceTrack,
  gainOp,
  mirrorOp,
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

/** Applies an operation and reports a refusal in the status line. */
function useApply(): (op: TimelineOp | null) => void {
  const { docStore, ui } = useEditor();
  return (op) => {
    if (!op) return;
    const result = docStore.getState().apply(op);
    ui.getState().setStatus(result.ok ? null : errorText(result.error));
  };
}

/** Pointer handlers that make a slider drag one undo step (R1.43). */
function useGesture() {
  const { docStore } = useEditor();
  return {
    onPointerDown: () => docStore.getState().beginGesture(),
    onPointerUp: () => docStore.getState().endGesture(),
    onPointerCancel: () => docStore.getState().endGesture(),
  };
}

export function InspectorPanel() {
  const { docStore } = useEditor();
  const doc = useDocumentStore(docStore, (s) => s.doc);
  if (!doc) return null;
  return (
    <aside className={styles.inspector} aria-label="Inspector" data-testid="inspector">
      <TracksSection doc={doc} />
      <FaceSection doc={doc} />
      <ScreenSection doc={doc} />
      <SyncSection doc={doc} />
    </aside>
  );
}

function TracksSection({ doc }: { doc: ProjectV1 }) {
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

function FaceSection({ doc }: { doc: ProjectV1 }) {
  const apply = useApply();
  const gesture = useGesture();
  const track = faceTrack(doc);
  if (!track) return null;
  const layout = track.layout;
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
              onClick={() => apply(cornerOp(doc, track.id, corner))}
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
          value={layout.width}
          onChange={(e) => apply(sizeOp(track.id, Number(e.target.value)))}
          {...gesture}
        />
        <span className={styles.muted}>{`${String(Math.round(layout.width * 100))} %`}</span>
      </div>
      <div className={styles.field}>
        <span />
        <span className={styles.group}>
          {(Object.keys(FACE_SIZE_PRESETS) as FaceSizePreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => apply(sizePresetOp(doc, track.id, preset))}
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
      <CropFields
        label="Face crop"
        crop={layout.crop}
        frame={frame}
        onChange={(crop) => apply(cropOp(track.id, crop))}
      />
      <p className={styles.muted}>
        Drag the face in the preview to move it; drag a corner to resize.
      </p>
    </section>
  );
}

function ScreenSection({ doc }: { doc: ProjectV1 }) {
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

function SyncSection({ doc }: { doc: ProjectV1 }) {
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
