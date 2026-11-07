/**
 * Audio panels of the inspector (R2.12–R2.17): the selected audio clips' gain and fades; each
 * audio track's noise reduction, ducking and volume keyframes; loudness normalization of the
 * export; and "Find pauses", a list of proposed cuts the user ticks before anything is cut (each
 * cut its own undo step). Operations come from `audio-ops.ts`.
 */
import { useState } from 'react';
import {
  EASINGS,
  type AudioTrack,
  type Easing,
  type Project,
} from '../../../shared/project/schema';
import type { UsRange } from '../../../shared/project/silence';
import { formatTimecode } from '../../../shared/time';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { useUi } from '../ui-store';
import {
  audioTracks,
  CLIP_GAIN_MAX_DB,
  CLIP_GAIN_MIN_DB,
  cleanupOp,
  clipAudioOp,
  DEFAULT_DUCK,
  FADE_LENGTHS_US,
  findPauses,
  normalizeOps,
  normalizes,
  PAUSE_MIN_US,
  PAUSE_THRESHOLDS_DB,
  pauseCutOps,
  selectedAudioClips,
  volumeAt,
  volumeKeyOp,
} from './audio-ops';
import { useApply, useGesture } from './hooks';
import { EASING_LABELS } from './inspector-ops';

const seconds = (us: number) => (us === 0 ? 'None' : `${String(us / 1_000_000)} s`);
const db = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;

/** The selected audio clips' own gain and fades (R2.12). */
export function ClipAudioSection({ doc }: { doc: Project }) {
  const apply = useApply();
  const gesture = useGesture();
  const { ui } = useEditor();
  const selection = useUi(ui, (s) => s.selection);
  const clips = selectedAudioClips(doc, selection);
  const first = clips[0];
  if (!first) return null;
  const gain = first.gainDb ?? 0;
  return (
    <section data-testid="clip-audio-panel">
      <h2>{clips.length > 1 ? `${String(clips.length)} audio clips` : 'Audio clip'}</h2>
      <div className={styles.field}>
        <label htmlFor="clip-gain">Gain</label>
        <input
          id="clip-gain"
          type="range"
          min={CLIP_GAIN_MIN_DB}
          max={CLIP_GAIN_MAX_DB}
          step={0.5}
          value={gain}
          title="Double-click for 0 dB"
          onChange={(e) => apply(clipAudioOp(clips, { gainDb: Number(e.target.value) }))}
          onDoubleClick={() => apply(clipAudioOp(clips, { gainDb: null }))}
          {...gesture}
        />
        <span className={styles.muted}>{db(gain)}</span>
      </div>
      <div className={styles.field}>
        <span>Fade</span>
        <span className={styles.group}>
          <select
            aria-label="Audio fade in"
            value={FADE_LENGTHS_US.includes(first.fadeInUs as never) ? (first.fadeInUs ?? 0) : ''}
            onChange={(e) => apply(clipAudioOp(clips, { fadeInUs: Number(e.target.value) }))}
          >
            {FADE_LENGTHS_US.includes((first.fadeInUs ?? 0) as never) ? null : (
              <option value="">{`In: ${seconds(first.fadeInUs ?? 0)}`}</option>
            )}
            {FADE_LENGTHS_US.map((us) => (
              <option key={us} value={us}>{`In: ${seconds(us)}`}</option>
            ))}
          </select>
          <select
            aria-label="Audio fade out"
            value={
              FADE_LENGTHS_US.includes((first.fadeOutUs ?? 0) as never)
                ? (first.fadeOutUs ?? 0)
                : ''
            }
            onChange={(e) => apply(clipAudioOp(clips, { fadeOutUs: Number(e.target.value) }))}
          >
            {FADE_LENGTHS_US.includes((first.fadeOutUs ?? 0) as never) ? null : (
              <option value="">{`Out: ${seconds(first.fadeOutUs ?? 0)}`}</option>
            )}
            {FADE_LENGTHS_US.map((us) => (
              <option key={us} value={us}>{`Out: ${seconds(us)}`}</option>
            ))}
          </select>
        </span>
        <span />
      </div>
    </section>
  );
}

/** Noise reduction, ducking and volume keyframes per audio track; normalization (R2.13–R2.16). */
export function AudioCleanupSection({ doc }: { doc: Project }) {
  const { docStore, ui } = useEditor();
  const tracks = audioTracks(doc);
  if (tracks.length === 0) return null;
  const normalized = normalizes(doc);
  return (
    <section data-testid="audio-cleanup-panel">
      <h2>Audio</h2>
      <div className={styles.field}>
        <label htmlFor="audio-normalize">Normalize</label>
        <input
          id="audio-normalize"
          type="checkbox"
          checked={normalized}
          onChange={(e) => {
            const result = docStore
              .getState()
              .applyBatch(normalizeOps(doc, e.target.checked), { label: 'Normalize loudness' });
            if (!result.ok) ui.getState().setStatus('Could not change normalization.');
          }}
        />
        <span className={styles.muted}>Export at −16 LUFS</span>
      </div>
      {tracks.map((track) => (
        <TrackAudio
          key={track.id}
          doc={doc}
          track={track}
          others={tracks.filter((t) => t !== track)}
        />
      ))}
    </section>
  );
}

function TrackAudio(props: { doc: Project; track: AudioTrack; others: AudioTrack[] }) {
  const { doc, track, others } = props;
  const apply = useApply();
  const gesture = useGesture();
  const { ui, playback } = useEditor();
  const playheadUs = useUi(ui, (s) => s.playheadUs);
  const noise = track.cleanup?.noise ?? 'off';
  const duck = track.cleanup?.duck;
  const keys = track.volumeKeyframes ?? [];
  const fps = doc.timeline.frameRate;
  const id = (name: string) => `${name}-${track.id}`;
  return (
    <div data-testid={`audio-track-${track.name}`}>
      <h3 className={styles.muted}>{track.name}</h3>
      <div className={styles.field}>
        <span>Noise</span>
        <span
          className={styles.group}
          role="radiogroup"
          aria-label={`${track.name} noise reduction`}
        >
          {(['off', 'light', 'strong'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={noise === mode}
              aria-pressed={noise === mode}
              onClick={() => apply(cleanupOp(track, { noise: mode }))}
            >
              {mode === 'off' ? 'Off' : mode === 'light' ? 'Light' : 'Strong'}
            </button>
          ))}
        </span>
        <span />
      </div>
      {others.length > 0 ? (
        <div className={styles.field}>
          <label htmlFor={id('duck')}>Duck under</label>
          <select
            id={id('duck')}
            value={duck?.byTrackId ?? ''}
            onChange={(e) =>
              apply(
                cleanupOp(track, {
                  duck:
                    e.target.value === ''
                      ? null
                      : { ...DEFAULT_DUCK, ...duck, byTrackId: e.target.value },
                }),
              )
            }
          >
            <option value="">Nothing</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <span />
        </div>
      ) : null}
      {duck ? (
        <div className={styles.field}>
          <label htmlFor={id('duck-amount')}>Down by</label>
          <input
            id={id('duck-amount')}
            type="range"
            min={-40}
            max={0}
            step={1}
            value={duck.amountDb}
            onChange={(e) =>
              apply(cleanupOp(track, { duck: { ...duck, amountDb: Number(e.target.value) } }))
            }
            {...gesture}
          />
          <span className={styles.muted}>{db(duck.amountDb)}</span>
        </div>
      ) : null}
      {keys.length > 0 ? (
        <ul
          className={styles.keyframeList}
          aria-label={`${track.name} volume keyframes`}
          data-testid={`volume-keys-${track.name}`}
        >
          {keys.map((k) => (
            <li key={k.tUs}>
              <button
                type="button"
                className={styles.linkButton}
                title="Go to this keyframe"
                onClick={() => playback.seek(k.tUs)}
              >
                {formatTimecode(k.tUs, fps)}
              </button>
              <input
                type="number"
                step={0.5}
                min={-60}
                max={12}
                aria-label={`Volume at ${formatTimecode(k.tUs, fps)} (dB)`}
                value={k.gainDb}
                onChange={(e) => {
                  if (e.target.value.trim() !== '' && e.target.value !== '-') {
                    apply(volumeKeyOp(track, k.tUs, Number(e.target.value)));
                  }
                }}
              />
              <select
                aria-label={`Volume change after ${formatTimecode(k.tUs, fps)}`}
                value={k.easing}
                onChange={(e) =>
                  apply({
                    type: 'setVolumeKeyframe',
                    trackId: track.id,
                    tUs: k.tUs,
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
                aria-label={`Delete volume keyframe at ${formatTimecode(k.tUs, fps)}`}
                onClick={() =>
                  apply({ type: 'removeVolumeKeyframe', trackId: track.id, tUs: k.tUs })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" onClick={() => apply(volumeKeyOp(track, playheadUs))}>
        {`Volume keyframe at playhead (${db(volumeAt(track, playheadUs))})`}
      </button>
    </div>
  );
}

/** Find pauses and cut the chosen ones (R2.17): nothing is cut until the user says which. */
export function PausesSection({ doc }: { doc: Project }) {
  const { docStore, ui, assets, playback } = useEditor();
  const [thresholdDb, setThresholdDb] = useState<number>(-45);
  const [minUs, setMinUs] = useState<number>(PAUSE_MIN_US[1]);
  const [found, setFound] = useState<{ pauses: UsRange[]; chosen: boolean[]; doc: Project } | null>(
    null,
  );
  const [note, setNote] = useState<string | null>(null);
  const fps = doc.timeline.frameRate;
  // A list found for another version of the document is stale.
  const list = found?.doc === doc ? found : null;
  const find = () => {
    const result = findPauses(doc, assets.peaks, { thresholdDb, minDurationUs: minUs });
    if (result.waiting > 0) {
      setFound(null);
      setNote('Waveforms are still loading; try again in a moment.');
      return;
    }
    setNote(result.pauses.length === 0 ? 'No pauses that long.' : null);
    setFound({ pauses: result.pauses, chosen: result.pauses.map(() => true), doc });
  };
  const cut = () => {
    if (!list) return;
    const chosen = list.pauses.filter((_, i) => list.chosen[i]);
    let cuts = 0;
    for (const op of pauseCutOps(chosen)) {
      // Each its own undo step (coalescing off), so any one can be undone.
      const result = docStore.getState().apply(op, { coalesceKey: null, label: 'Cut pause' });
      if (result.ok) cuts += 1;
    }
    setFound(null);
    ui.getState().setStatus(`Cut ${String(cuts)} pause${cuts === 1 ? '' : 's'}.`);
  };
  const total = list
    ? list.pauses.reduce((sum, p, i) => sum + (list.chosen[i] ? p.endUs - p.startUs : 0), 0)
    : 0;
  return (
    <section data-testid="pauses-panel">
      <h2>Pauses</h2>
      <div className={styles.field}>
        <span>Find</span>
        <span className={styles.group}>
          <select
            aria-label="Quieter than"
            value={thresholdDb}
            onChange={(e) => setThresholdDb(Number(e.target.value))}
          >
            {PAUSE_THRESHOLDS_DB.map((t) => (
              <option key={t} value={t}>{`Quieter than ${String(t)} dB`}</option>
            ))}
          </select>
          <select
            aria-label="At least"
            value={minUs}
            onChange={(e) => setMinUs(Number(e.target.value))}
          >
            {PAUSE_MIN_US.map((us) => (
              <option key={us} value={us}>{`At least ${String(us / 1_000_000)} s`}</option>
            ))}
          </select>
        </span>
        <button type="button" onClick={find}>
          Find pauses
        </button>
      </div>
      {note ? <p className={styles.muted}>{note}</p> : null}
      {list && list.pauses.length > 0 ? (
        <>
          <ul className={styles.keyframeList} aria-label="Pauses found" data-testid="pause-list">
            {list.pauses.map((p, i) => (
              <li key={p.startUs}>
                <input
                  type="checkbox"
                  aria-label={`Cut the pause at ${formatTimecode(p.startUs, fps)}`}
                  checked={list.chosen[i] ?? false}
                  onChange={(e) =>
                    setFound({
                      ...list,
                      chosen: list.chosen.map((c, j) => (j === i ? e.target.checked : c)),
                    })
                  }
                />
                <button
                  type="button"
                  className={styles.linkButton}
                  title="Go to this pause"
                  onClick={() => playback.seek(p.startUs)}
                >
                  {formatTimecode(p.startUs, fps)}
                </button>
                <span
                  className={styles.muted}
                >{`${((p.endUs - p.startUs) / 1e6).toFixed(1)} s`}</span>
                <span />
              </li>
            ))}
          </ul>
          <button type="button" disabled={total === 0} onClick={cut}>
            {`Cut ${String(list.chosen.filter(Boolean).length)} pauses (${(total / 1e6).toFixed(1)} s)`}
          </button>
        </>
      ) : null}
    </section>
  );
}
