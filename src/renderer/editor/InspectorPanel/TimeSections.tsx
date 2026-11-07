/**
 * Time panels of the inspector (R2.10, R2.18–R2.20): speed of the In–Out range or the selected
 * clips (every unlocked track, so face, voice and screen stay in sync), freeze frame at the
 * playhead, the selected video clip's transition in, and the markers (label, chapter, delete;
 * M adds one at the playhead). Operations come from `time-ops.ts`.
 */
import { useState } from 'react';
import { newId } from '../../../shared/ids';
import type { Project } from '../../../shared/project/schema';
import type { Transition } from '../../../shared/project/timeline-ops';
import { formatTimecode } from '../../../shared/time';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { useUi } from '../ui-store';
import { useApply } from './hooks';
import {
  addMarkerOp,
  FREEZE_LENGTHS_US,
  freezeOp,
  SPEEDS,
  speedIn,
  speedOp,
  speedRange,
  TRANSITION_LABELS,
  TRANSITION_LENGTHS_US,
  transitionClip,
  transitionOp,
} from './time-ops';

const seconds = (us: number) => `${String(us / 1_000_000)} s`;

/** Speed and freeze frames (R2.18, R2.19). */
export function SpeedSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const { ui } = useEditor();
  const selection = useUi(ui, (s) => s.selection);
  const playheadUs = useUi(ui, (s) => s.playheadUs);
  const [freezeUs, setFreezeUs] = useState<number>(FREEZE_LENGTHS_US[1]);
  const fps = doc.timeline.frameRate;
  const range = speedRange(doc, selection);
  const current = range ? speedIn(doc, range) : null;
  return (
    <section data-testid="speed-panel">
      <h2>Speed and time</h2>
      <p className={styles.muted}>
        {range
          ? `${range.source === 'marks' ? 'In–Out' : 'Selected clips'} (${formatTimecode(range.inUs, fps)}–${formatTimecode(range.outUs, fps)}), every unlocked track; audio keeps its pitch.`
          : 'Set In and Out, or select clips, to change their speed.'}
      </p>
      <div className={styles.field}>
        <label htmlFor="speed-select">Speed</label>
        <select
          id="speed-select"
          disabled={!range}
          value={current ?? ''}
          onChange={(e) => {
            if (range) apply(speedOp(range, Number(e.target.value)));
          }}
        >
          {current === null ? (
            <option value="" disabled>
              {range ? 'Mixed' : '—'}
            </option>
          ) : null}
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{`${String(s)}×`}</option>
          ))}
        </select>
        <span />
      </div>
      <div className={styles.field}>
        <span>Freeze</span>
        <span className={styles.group}>
          <select
            aria-label="Freeze length"
            value={freezeUs}
            onChange={(e) => setFreezeUs(Number(e.target.value))}
          >
            {FREEZE_LENGTHS_US.map((us) => (
              <option key={us} value={us}>
                {seconds(us)}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => apply(freezeOp(playheadUs, freezeUs))}>
            Freeze frame at playhead
          </button>
        </span>
        <span />
      </div>
    </section>
  );
}

/** The selected video clip's transition from the clip before it (R2.10). */
export function TransitionSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const { ui } = useEditor();
  const selection = useUi(ui, (s) => s.selection);
  const clip = transitionClip(doc, selection);
  if (!clip) return null;
  const t = clip.transitionIn;
  return (
    <section data-testid="transition-panel">
      <h2>Transition in</h2>
      <p className={styles.muted}>From the clip before (or the background) into this one.</p>
      <div className={styles.field}>
        <label htmlFor="transition-kind">Kind</label>
        <select
          id="transition-kind"
          value={t?.kind ?? ''}
          onChange={(e) =>
            apply(
              transitionOp(
                clip,
                e.target.value === '' ? null : (e.target.value as Transition['kind']),
              ),
            )
          }
        >
          <option value="">None</option>
          {(Object.keys(TRANSITION_LABELS) as Transition['kind'][]).map((kind) => (
            <option key={kind} value={kind}>
              {TRANSITION_LABELS[kind]}
            </option>
          ))}
        </select>
        <span />
      </div>
      {t ? (
        <>
          <div className={styles.field}>
            <label htmlFor="transition-length">Length</label>
            <select
              id="transition-length"
              value={TRANSITION_LENGTHS_US.includes(t.durationUs as never) ? t.durationUs : ''}
              onChange={(e) =>
                apply(transitionOp(clip, t.kind, { durationUs: Number(e.target.value) }))
              }
            >
              {TRANSITION_LENGTHS_US.includes(t.durationUs as never) ? null : (
                <option value="">{seconds(t.durationUs)}</option>
              )}
              {TRANSITION_LENGTHS_US.map((us) => (
                <option key={us} value={us}>
                  {seconds(us)}
                </option>
              ))}
            </select>
            <span />
          </div>
          {t.kind === 'fade-color' ? (
            <div className={styles.field}>
              <span>Colour</span>
              <input
                type="color"
                aria-label="Transition colour"
                value={(t.color ?? '#000000').slice(0, 7)}
                onChange={(e) => apply(transitionOp(clip, t.kind, { color: e.target.value }))}
              />
              <span />
            </div>
          ) : null}
          {t.kind === 'slide' ? (
            <div className={styles.field}>
              <label htmlFor="transition-direction">Moves</label>
              <select
                id="transition-direction"
                value={t.direction ?? 'left'}
                onChange={(e) =>
                  apply(
                    transitionOp(clip, t.kind, {
                      direction: e.target.value as NonNullable<Transition['direction']>,
                    }),
                  )
                }
              >
                <option value="left">Left (in from the right)</option>
                <option value="right">Right (in from the left)</option>
                <option value="up">Up (in from below)</option>
                <option value="down">Down (in from above)</option>
              </select>
              <span />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Markers and chapters (R2.20). */
export function MarkersSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const { ui, playback } = useEditor();
  const playheadUs = useUi(ui, (s) => s.playheadUs);
  const fps = doc.timeline.frameRate;
  const markers = doc.timeline.markers ?? [];
  return (
    <section data-testid="markers-panel">
      <h2>Markers</h2>
      {markers.length === 0 ? (
        <p className={styles.muted}>
          No markers. Press M to add one at the playhead; chapter markers become chapters in the
          exported MP4.
        </p>
      ) : (
        <ul className={styles.keyframeList} aria-label="Markers" data-testid="marker-list">
          {markers.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={styles.linkButton}
                title="Go to this marker"
                onClick={() => playback.seek(m.tUs)}
              >
                {formatTimecode(m.tUs, fps)}
              </button>
              <input
                type="text"
                aria-label={`Label of the marker at ${formatTimecode(m.tUs, fps)}`}
                placeholder={m.chapter ? 'Chapter title' : 'Label'}
                maxLength={200}
                value={m.label}
                onChange={(e) =>
                  apply({ type: 'updateMarker', markerId: m.id, label: e.target.value })
                }
              />
              <label className={styles.muted} title="Export as an MP4 chapter">
                <input
                  type="checkbox"
                  checked={m.chapter}
                  onChange={(e) =>
                    apply({ type: 'updateMarker', markerId: m.id, chapter: e.target.checked })
                  }
                />
                Chapter
              </label>
              <button
                type="button"
                aria-label={`Delete marker at ${formatTimecode(m.tUs, fps)}`}
                onClick={() => apply({ type: 'removeMarker', markerId: m.id })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => apply(addMarkerOp(playheadUs, newId('marker')))}>
        Add marker at playhead
      </button>
    </section>
  );
}
