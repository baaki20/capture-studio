/**
 * Cursor panel of the inspector (R3.10–R3.12): smoothing, size and hide of the drawn cursor,
 * click rings and a highlight, and auto-zoom on clicks. Without a cursor track the panel only
 * says why (spec §2.5); where the video shows the system cursor, smoothing, size and hide are
 * disabled with the reason. Auto-zoom first lists the zooms it proposes; the user unticks the
 * ones they do not want and adds the rest as one undo step, then edits them in the Zoom panel.
 */
import { useRef, useState } from 'react';
import {
  DEFAULT_AUTO_ZOOM,
  proposeAutoZoom,
  type AutoZoomProposal,
} from '../../../shared/project/auto-zoom';
import { cursorEffectsAvailability } from '../../../shared/project/cursor-effects';
import type { Project } from '../../../shared/project/schema';
import { formatTimecode } from '../../../shared/time';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { CursorTrackStore } from '../preview/cursor-tracks';
import { useApply, useGesture } from './hooks';
import { alphaOf, withAlpha } from './inspector-ops';
import {
  autoZoomOp,
  cursorEffectsOp,
  resetCursorEffectsOp,
  shownCursorEffects,
} from './cursor-ops';
import { Slider } from './ScreenStyleSections';

const percent = (fraction: number) => `${String(Math.round(fraction * 100))} %`;
const ZOOM_LEVELS = [1.5, 2, 2.5, 3] as const;

export function CursorSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const gesture = useGesture();
  const { docStore, ui } = useEditor();
  const tracks = useRef(new CursorTrackStore());
  const [zoom, setZoom] = useState<number>(DEFAULT_AUTO_ZOOM.zoom);
  const [proposals, setProposals] = useState<AutoZoomProposal[] | null>(null);
  const [kept, setKept] = useState<boolean[]>([]);
  const availability = cursorEffectsAvailability(doc);
  const effects = shownCursorEffects(doc);
  const fps = doc.timeline.frameRate;
  const short = Math.min(doc.timeline.canvas.width, doc.timeline.canvas.height);
  const px = (fraction: number) => `${String(Math.round(fraction * short))} px`;

  if (!availability.available) {
    return (
      <section data-testid="cursor-panel">
        <h2>Cursor</h2>
        <p className={styles.muted} data-testid="cursor-unavailable">
          {availability.reason}
        </p>
      </section>
    );
  }

  const findClicks = async () => {
    const store = tracks.current;
    await store.load(doc, docStore.getState().mediaUrls);
    if (store.failed.size > 0) {
      ui.getState().setStatus('The cursor track could not be read.');
      return;
    }
    const { inUs, outUs } = doc.timeline.marks;
    const range = inUs !== null && outUs !== null && outUs > inUs ? { inUs, outUs } : undefined;
    const found = proposeAutoZoom(doc, store.tracks, { zoom, ...(range ? { range } : {}) });
    setProposals(found);
    setKept(found.map(() => true));
    if (found.length === 0) {
      ui.getState().setStatus('No clicks to zoom in on (or they already have zoom keyframes).');
    }
  };
  const addZooms = () => {
    const chosen = (proposals ?? []).filter((_, i) => kept[i]);
    apply(autoZoomOp(chosen));
    setProposals(null);
  };
  const drawnOff = !availability.drawn;
  const { clickRings: rings, highlight } = effects;

  return (
    <section data-testid="cursor-panel">
      <h2>Cursor</h2>
      {drawnOff ? (
        <p className={styles.muted} data-testid="cursor-drawn-reason">
          {availability.drawnReason}
        </p>
      ) : null}
      <Slider
        id="cursor-smoothing"
        label="Smoothing"
        min={0}
        max={1}
        step={0.05}
        value={effects.smoothing}
        shown={percent(effects.smoothing)}
        disabled={drawnOff}
        onChange={(smoothing) => apply(cursorEffectsOp(doc, { smoothing }))}
        gesture={gesture}
      />
      <Slider
        id="cursor-size"
        label="Size"
        min={0.5}
        max={3}
        step={0.1}
        value={effects.size}
        shown={`${effects.size.toFixed(1)}×`}
        disabled={drawnOff}
        onChange={(size) => apply(cursorEffectsOp(doc, { size }))}
        gesture={gesture}
      />
      <div className={styles.field}>
        <label htmlFor="cursor-hide">Hide cursor</label>
        <input
          id="cursor-hide"
          type="checkbox"
          checked={effects.hide}
          disabled={drawnOff}
          onChange={(e) => apply(cursorEffectsOp(doc, { hide: e.target.checked }))}
        />
        <span />
      </div>
      <div className={styles.field}>
        <label htmlFor="cursor-rings">Click rings</label>
        <input
          id="cursor-rings"
          type="checkbox"
          checked={rings.enabled}
          onChange={(e) =>
            apply(cursorEffectsOp(doc, { clickRings: { enabled: e.target.checked } }))
          }
        />
        <input
          type="color"
          aria-label="Ring colour"
          value={rings.color.slice(0, 7)}
          disabled={!rings.enabled}
          onChange={(e) => apply(cursorEffectsOp(doc, { clickRings: { color: e.target.value } }))}
        />
      </div>
      {rings.enabled ? (
        <>
          <Slider
            id="cursor-ring-size"
            label="Ring size"
            min={0.01}
            max={0.2}
            step={0.005}
            value={rings.size}
            shown={px(rings.size)}
            onChange={(size) => apply(cursorEffectsOp(doc, { clickRings: { size } }))}
            gesture={gesture}
          />
          <Slider
            id="cursor-ring-duration"
            label="Ring time"
            min={100_000}
            max={2_000_000}
            step={50_000}
            value={rings.durationUs}
            shown={`${(rings.durationUs / 1e6).toFixed(2)} s`}
            onChange={(durationUs) => apply(cursorEffectsOp(doc, { clickRings: { durationUs } }))}
            gesture={gesture}
          />
        </>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="cursor-highlight">Highlight</label>
        <input
          id="cursor-highlight"
          type="checkbox"
          checked={highlight.enabled}
          onChange={(e) =>
            apply(cursorEffectsOp(doc, { highlight: { enabled: e.target.checked } }))
          }
        />
        <input
          type="color"
          aria-label="Highlight colour"
          value={highlight.color.slice(0, 7)}
          disabled={!highlight.enabled}
          onChange={(e) =>
            apply(
              cursorEffectsOp(doc, {
                highlight: { color: withAlpha(e.target.value, alphaOf(highlight.color)) },
              }),
            )
          }
        />
      </div>
      {highlight.enabled ? (
        <>
          <Slider
            id="cursor-highlight-radius"
            label="Radius"
            min={0.01}
            max={0.2}
            step={0.005}
            value={highlight.radius}
            shown={px(highlight.radius)}
            onChange={(radius) => apply(cursorEffectsOp(doc, { highlight: { radius } }))}
            gesture={gesture}
          />
          <Slider
            id="cursor-highlight-opacity"
            label="Opacity"
            min={0.05}
            max={1}
            step={0.05}
            value={alphaOf(highlight.color)}
            shown={percent(alphaOf(highlight.color))}
            onChange={(opacity) =>
              apply(
                cursorEffectsOp(doc, { highlight: { color: withAlpha(highlight.color, opacity) } }),
              )
            }
            gesture={gesture}
          />
        </>
      ) : null}
      {doc.timeline.cursorEffects ? (
        <div className={styles.field}>
          <span />
          <button type="button" onClick={() => apply(resetCursorEffectsOp())}>
            Reset effects
          </button>
          <span />
        </div>
      ) : null}

      <h3 className={styles.muted}>Auto-zoom on clicks</h3>
      <div className={styles.field}>
        <label htmlFor="auto-zoom-level">Zoom</label>
        <select
          id="auto-zoom-level"
          value={zoom}
          onChange={(e) => {
            setZoom(Number(e.target.value));
            setProposals(null);
          }}
        >
          {ZOOM_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}×
            </option>
          ))}
        </select>
        <button type="button" data-testid="auto-zoom-find" onClick={() => void findClicks()}>
          {doc.timeline.marks.inUs !== null && doc.timeline.marks.outUs !== null
            ? 'Find clicks in In–Out'
            : 'Find clicks'}
        </button>
      </div>
      {proposals && proposals.length > 0 ? (
        <>
          <ul
            className={styles.keyframeList}
            aria-label="Proposed zooms"
            data-testid="auto-zoom-proposals"
          >
            {proposals.map((p, i) => (
              <li key={`${String(p.startUs)}-${String(p.endUs)}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={kept[i] ?? false}
                    onChange={(e) =>
                      setKept((list) => list.map((v, j) => (j === i ? e.target.checked : v)))
                    }
                  />{' '}
                  {formatTimecode(p.startUs, fps)}–{formatTimecode(p.endUs, fps)},{' '}
                  {String(Math.round(10 / p.rect.width) / 10)}×, {String(p.clicks)} click
                  {p.clicks === 1 ? '' : 's'}
                </label>
              </li>
            ))}
          </ul>
          <div className={styles.field}>
            <span />
            <button
              type="button"
              data-testid="auto-zoom-add"
              disabled={!kept.some(Boolean)}
              onClick={addZooms}
            >
              Add {String(kept.filter(Boolean).length)} zoom
              {kept.filter(Boolean).length === 1 ? '' : 's'}
            </button>
            <button type="button" onClick={() => setProposals(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
