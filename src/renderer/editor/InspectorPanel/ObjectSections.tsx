/**
 * Annotation panels of the inspector (R2.5–R2.8). "Annotations" adds text (title, subtitle,
 * caption, label, code), callouts (arrow, rectangle, ellipse, step, highlight, spotlight) and
 * privacy regions (blur, pixelate) at the playhead, and selects the new object. "Annotation"
 * edits the selected object: its look by kind, opacity, fades, its motion (box keyframes) and
 * Delete. Its place and size are edited on the preview (handles). Operations come from
 * `annotation-ops.ts`; sliders group a drag into one undo step.
 */
import type { ReactNode } from 'react';
import { newId } from '../../../shared/ids';
import {
  OBJECT_KIND_LABELS,
  TEXT_PRESETS,
  objectLabel,
  type ObjectKind,
  type TextPreset,
} from '../../../shared/project/objects';
import type { ObjectPatch } from '../../../shared/project/object-patch';
import {
  EASINGS,
  OBJECT_FONTS,
  type Easing,
  type Project,
  type TimelineObject,
} from '../../../shared/project/schema';
import { formatTimecode } from '../../../shared/time';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { useUi } from '../ui-store';
import { addObjectOp, addObjectKeyframeOp, findObject, patchObjectOp } from './annotation-ops';
import { useApply, useGesture } from './hooks';
import { alphaOf, EASING_LABELS, withAlpha } from './inspector-ops';

const TEXT_PRESET_LABELS: Record<TextPreset, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  caption: 'Caption',
  label: 'Label',
  code: 'Code',
};

const FONT_LABELS: Record<(typeof OBJECT_FONTS)[number], string> = {
  sans: 'Sans (Inter)',
  serif: 'Serif (Source Serif)',
  mono: 'Mono (JetBrains Mono)',
  handwriting: 'Handwriting (Caveat)',
};

const CALLOUTS: ObjectKind[] = ['arrow', 'rectangle', 'ellipse', 'step', 'highlight', 'spotlight'];
const PRIVACY: ObjectKind[] = ['blur', 'pixelate'];

const FADES: { us: number; label: string }[] = [
  { us: 0, label: 'None' },
  { us: 300_000, label: '0.3 s' },
  { us: 500_000, label: '0.5 s' },
  { us: 1_000_000, label: '1 s' },
];

/** Add buttons (R2.5–R2.7). */
export function AnnotationsSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const { ui, docStore } = useEditor();
  const playheadUs = useUi(ui, (s) => s.playheadUs);
  const add = (kind: ObjectKind, preset?: TextPreset) => {
    const id = newId('object');
    const op = addObjectOp(doc, kind, playheadUs, id, preset);
    if (!op) return;
    apply(op);
    // Select it once it is in the document (the add may be refused, e.g. on a locked track).
    const after = docStore.getState().doc;
    if (after && findObject(after, id)) ui.getState().selectObject(id);
  };
  const button = (label: string, onClick: () => void) => (
    <button key={label} type="button" onClick={onClick}>
      {label}
    </button>
  );
  return (
    <section data-testid="annotations-panel">
      <h2>Annotations</h2>
      <p className={styles.muted}>Added at the playhead; drag them on the preview.</p>
      <Row label="Text">
        {(Object.keys(TEXT_PRESETS) as TextPreset[]).map((preset) =>
          button(TEXT_PRESET_LABELS[preset], () => add('text', preset)),
        )}
      </Row>
      <Row label="Callout">
        {CALLOUTS.map((kind) => button(OBJECT_KIND_LABELS[kind], () => add(kind)))}
      </Row>
      <Row label="Privacy">
        {PRIVACY.map((kind) => button(OBJECT_KIND_LABELS[kind], () => add(kind)))}
      </Row>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <span>{label}</span>
      <span className={styles.group} style={{ flexWrap: 'wrap' }}>
        {children}
      </span>
      <span />
    </div>
  );
}

/** The selected object's editor. */
export function ObjectSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const { ui, playback } = useEditor();
  const selected = useUi(ui, (s) => s.selectedObject);
  const playheadUs = useUi(ui, (s) => s.playheadUs);
  const found = findObject(doc, selected);
  if (!found) return null;
  const { item, track } = found;
  const fps = doc.timeline.frameRate;
  const set = (patch: ObjectPatch) => apply(patchObjectOp(item.id, patch));
  return (
    <section data-testid="object-panel">
      <h2>{`${OBJECT_KIND_LABELS[item.kind]}: ${objectLabel(item)}`}</h2>
      <p className={styles.muted}>
        {`${formatTimecode(item.inUs, fps)}–${formatTimecode(item.outUs, fps)} on ${track.name}. Drag its bar on the timeline to move or trim it.`}
      </p>
      <KindFields item={item} set={set} />
      <Slider
        id="object-opacity"
        label="Opacity"
        min={0}
        max={1}
        step={0.05}
        value={item.opacity ?? 1}
        shown={`${String(Math.round((item.opacity ?? 1) * 100))} %`}
        onChange={(opacity) => set({ opacity: opacity >= 1 ? null : opacity })}
      />
      <div className={styles.field}>
        <span>Fade</span>
        <span className={styles.group}>
          <select
            aria-label="Fade in"
            value={item.fadeInUs ?? 0}
            onChange={(e) => set({ fadeInUs: Number(e.target.value) || null })}
          >
            {FADES.map((f) => (
              <option key={f.us} value={f.us}>{`In: ${f.label}`}</option>
            ))}
          </select>
          <select
            aria-label="Fade out"
            value={item.fadeOutUs ?? 0}
            onChange={(e) => set({ fadeOutUs: Number(e.target.value) || null })}
          >
            {FADES.map((f) => (
              <option key={f.us} value={f.us}>{`Out: ${f.label}`}</option>
            ))}
          </select>
        </span>
        <span />
      </div>
      <h3 className={styles.muted}>Motion</h3>
      {item.keyframes && item.keyframes.length > 0 ? (
        <ul
          className={styles.keyframeList}
          aria-label="Box keyframes"
          data-testid="object-keyframe-list"
        >
          {item.keyframes.map((key) => (
            <li key={key.tUs}>
              <button
                type="button"
                className={styles.linkButton}
                title="Go to this keyframe"
                onClick={() => playback.seek(key.tUs)}
              >
                {formatTimecode(key.tUs, fps)}
              </button>
              <span />
              <select
                aria-label={`Move after ${formatTimecode(key.tUs, fps)}`}
                value={key.easing}
                onChange={(e) =>
                  apply({
                    type: 'setObjectKeyframe',
                    objectId: item.id,
                    tUs: key.tUs,
                    easing: e.target.value as Easing,
                  })
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
                aria-label={`Delete box keyframe at ${formatTimecode(key.tUs, fps)}`}
                onClick={() =>
                  apply({ type: 'removeObjectKeyframe', objectId: item.id, tUs: key.tUs })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>
          It stays in place. Add keyframes to make it follow something.
        </p>
      )}
      <span className={styles.group}>
        <button type="button" onClick={() => apply(addObjectKeyframeOp(doc, item.id, playheadUs))}>
          Add box keyframe at playhead
        </button>
        <button
          type="button"
          onClick={() => {
            apply({ type: 'removeObjects', objectIds: [item.id] });
            ui.getState().selectObject(null);
          }}
        >
          Delete
        </button>
      </span>
    </section>
  );
}

/** The fields of one kind of object. */
function KindFields({ item, set }: { item: TimelineObject; set: (patch: ObjectPatch) => void }) {
  switch (item.kind) {
    case 'text': {
      const { style } = item;
      return (
        <>
          <textarea
            aria-label="Text"
            rows={3}
            style={{ width: '100%', boxSizing: 'border-box' }}
            value={item.text}
            onChange={(e) => set({ text: e.target.value })}
          />
          <div className={styles.field}>
            <label htmlFor="text-preset">Style</label>
            <select
              id="text-preset"
              value={item.preset ?? ''}
              onChange={(e) => {
                const preset = e.target.value as TextPreset;
                // The preset's whole style: a background or outline it lacks is removed.
                if (preset in TEXT_PRESETS) {
                  set({
                    preset,
                    style: { background: null, outline: null, ...TEXT_PRESETS[preset] },
                  });
                }
              }}
            >
              <option value="" disabled>
                Custom
              </option>
              {(Object.keys(TEXT_PRESETS) as TextPreset[]).map((p) => (
                <option key={p} value={p}>
                  {TEXT_PRESET_LABELS[p]}
                </option>
              ))}
            </select>
            <span />
          </div>
          <div className={styles.field}>
            <label htmlFor="text-font">Font</label>
            <select
              id="text-font"
              value={style.font}
              onChange={(e) =>
                set({ preset: null, style: { font: e.target.value as typeof style.font } })
              }
            >
              {OBJECT_FONTS.map((font) => (
                <option key={font} value={font}>
                  {FONT_LABELS[font]}
                </option>
              ))}
            </select>
            <span />
          </div>
          <Slider
            id="text-size"
            label="Size"
            min={0.02}
            max={0.2}
            step={0.005}
            value={style.size}
            shown={`${String(Math.round(style.size * 100))} %`}
            onChange={(size) => set({ preset: null, style: { size } })}
          />
          <div className={styles.field}>
            <span>Look</span>
            <span className={styles.group}>
              <input
                type="color"
                aria-label="Text colour"
                value={style.color.slice(0, 7)}
                onChange={(e) => set({ preset: null, style: { color: e.target.value } })}
              />
              <button
                type="button"
                aria-pressed={style.bold}
                onClick={() => set({ preset: null, style: { bold: !style.bold } })}
              >
                Bold
              </button>
              <button
                type="button"
                aria-pressed={style.italic}
                onClick={() => set({ preset: null, style: { italic: !style.italic } })}
              >
                Italic
              </button>
              {(['left', 'center', 'right'] as const).map((align) => (
                <button
                  key={align}
                  type="button"
                  aria-pressed={style.align === align}
                  aria-label={`Align ${align}`}
                  onClick={() => set({ preset: null, style: { align } })}
                >
                  {align === 'left' ? '⇤' : align === 'center' ? '↔' : '⇥'}
                </button>
              ))}
            </span>
            <span />
          </div>
          <div className={styles.field}>
            <label htmlFor="text-background">Background</label>
            <input
              id="text-background"
              type="checkbox"
              checked={style.background !== undefined}
              onChange={(e) =>
                set({ preset: null, style: { background: e.target.checked ? '#000000A6' : null } })
              }
            />
            {style.background ? (
              <input
                type="color"
                aria-label="Background colour"
                value={style.background.slice(0, 7)}
                onChange={(e) =>
                  set({
                    preset: null,
                    style: {
                      background: withAlpha(e.target.value, alphaOf(style.background ?? '#000')),
                    },
                  })
                }
              />
            ) : (
              <span />
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor="text-outline">Outline</label>
            <input
              id="text-outline"
              type="checkbox"
              checked={style.outline !== undefined}
              onChange={(e) =>
                set({
                  preset: null,
                  style: { outline: e.target.checked ? { color: '#000000', width: 0.003 } : null },
                })
              }
            />
            <span />
          </div>
        </>
      );
    }
    case 'rectangle':
    case 'ellipse':
    case 'arrow':
      return (
        <>
          <div className={styles.field}>
            <span>Line</span>
            <input
              type="color"
              aria-label="Line colour"
              value={item.stroke.color.slice(0, 7)}
              onChange={(e) => set({ stroke: { ...item.stroke, color: e.target.value } })}
            />
            <span />
          </div>
          <Slider
            id="stroke-width"
            label="Width"
            min={0.001}
            max={0.03}
            step={0.001}
            value={item.stroke.width}
            shown={`${(item.stroke.width * 100).toFixed(1)} %`}
            onChange={(width) => set({ stroke: { ...item.stroke, width } })}
          />
          {item.kind === 'arrow' ? (
            <>
              <div className={styles.field}>
                <label htmlFor="arrow-tail">Points</label>
                <select
                  id="arrow-tail"
                  value={item.tail}
                  onChange={(e) => set({ tail: e.target.value as typeof item.tail })}
                >
                  <option value="bottom-left">Up right ↗</option>
                  <option value="bottom-right">Up left ↖</option>
                  <option value="top-left">Down right ↘</option>
                  <option value="top-right">Down left ↙</option>
                </select>
                <span />
              </div>
              <div className={styles.field}>
                <label htmlFor="arrow-head">Head</label>
                <select
                  id="arrow-head"
                  value={item.head}
                  onChange={(e) => set({ head: e.target.value as typeof item.head })}
                >
                  <option value="triangle">Filled</option>
                  <option value="open">Open</option>
                  <option value="none">None</option>
                </select>
                <span />
              </div>
            </>
          ) : (
            <div className={styles.field}>
              <label htmlFor="shape-fill">Fill</label>
              <input
                id="shape-fill"
                type="checkbox"
                checked={item.fill !== undefined}
                onChange={(e) =>
                  set({ fill: e.target.checked ? withAlpha(item.stroke.color, 0.2) : null })
                }
              />
              {item.fill ? (
                <input
                  type="color"
                  aria-label="Fill colour"
                  value={item.fill.slice(0, 7)}
                  onChange={(e) =>
                    set({ fill: withAlpha(e.target.value, alphaOf(item.fill ?? '#000')) })
                  }
                />
              ) : (
                <span />
              )}
            </div>
          )}
        </>
      );
    case 'step':
      return (
        <>
          <div className={styles.field}>
            <label htmlFor="step-value">Number</label>
            <span className={styles.group}>
              <input
                id="step-value"
                type="number"
                min={1}
                max={999}
                value={item.value}
                onChange={(e) => {
                  const value = Math.round(Number(e.target.value));
                  if (value >= 1 && value <= 999) set({ value });
                }}
              />
              <select
                aria-label="Number style"
                value={item.format}
                onChange={(e) => set({ format: e.target.value as typeof item.format })}
              >
                <option value="1">1, 2, 3</option>
                <option value="A">A, B, C</option>
                <option value="a">a, b, c</option>
                <option value="I">I, II, III</option>
                <option value="i">i, ii, iii</option>
              </select>
            </span>
            <span />
          </div>
          <div className={styles.field}>
            <span>Colours</span>
            <span className={styles.group}>
              <input
                type="color"
                aria-label="Step colour"
                value={item.fill.slice(0, 7)}
                onChange={(e) => set({ fill: e.target.value })}
              />
              <input
                type="color"
                aria-label="Number colour"
                value={item.textColor.slice(0, 7)}
                onChange={(e) => set({ textColor: e.target.value })}
              />
            </span>
            <span />
          </div>
        </>
      );
    case 'highlight':
      return (
        <>
          <div className={styles.field}>
            <span>Colour</span>
            <input
              type="color"
              aria-label="Highlight colour"
              value={item.color.slice(0, 7)}
              onChange={(e) => set({ color: withAlpha(e.target.value, alphaOf(item.color)) })}
            />
            <span />
          </div>
          <Slider
            id="highlight-strength"
            label="Strength"
            min={0.1}
            max={1}
            step={0.05}
            value={alphaOf(item.color)}
            shown={`${String(Math.round(alphaOf(item.color) * 100))} %`}
            onChange={(a) => set({ color: withAlpha(item.color, a) })}
          />
        </>
      );
    case 'spotlight':
      return (
        <>
          <div className={styles.field}>
            <span>Shape</span>
            <span className={styles.group}>
              {(['ellipse', 'rectangle'] as const).map((shape) => (
                <button
                  key={shape}
                  type="button"
                  aria-pressed={item.shape === shape}
                  onClick={() => set({ shape })}
                >
                  {shape === 'ellipse' ? 'Ellipse' : 'Rectangle'}
                </button>
              ))}
            </span>
            <span />
          </div>
          <Slider
            id="spotlight-dim"
            label="Darken"
            min={0.1}
            max={0.95}
            step={0.05}
            value={item.dim}
            shown={`${String(Math.round(item.dim * 100))} %`}
            onChange={(dim) => set({ dim })}
          />
        </>
      );
    case 'blur':
      return (
        <Slider
          id="blur-radius"
          label="Strength"
          min={0.002}
          max={0.05}
          step={0.001}
          value={item.radius}
          shown={`${(item.radius * 100).toFixed(1)} %`}
          onChange={(radius) => set({ radius })}
        />
      );
    case 'pixelate':
      return (
        <Slider
          id="pixelate-block"
          label="Blocks"
          min={0.005}
          max={0.08}
          step={0.001}
          value={item.blockSize}
          shown={`${(item.blockSize * 100).toFixed(1)} %`}
          onChange={(blockSize) => set({ blockSize })}
        />
      );
  }
}

function Slider(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  shown: string;
  onChange: (value: number) => void;
}) {
  const gesture = useGesture();
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
        onChange={(e) => props.onChange(Number(e.target.value))}
        {...gesture}
      />
      <span className={styles.muted}>{props.shown}</span>
    </div>
  );
}
