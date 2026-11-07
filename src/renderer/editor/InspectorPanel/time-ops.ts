/**
 * Speed, freeze frames, transitions and markers in the inspector (R2.10, R2.18–R2.20): intents →
 * timeline operations. Pure, so the mapping is unit-tested; `TimeSections.tsx` renders the
 * controls.
 *
 * Speed applies to a range of every unlocked track (so face, voice and screen stay together): the
 * In–Out marks when set, else the span of the selected clips.
 */
import { findClip, type TimelineOp, type Transition } from '../../../shared/project/timeline-ops';
import { clipEndUs } from '../../../shared/project/timeline-ops';
import type { Clip, Project } from '../../../shared/project/schema';

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const FREEZE_LENGTHS_US = [1_000_000, 2_000_000, 3_000_000, 5_000_000] as const;
export const TRANSITION_LENGTHS_US = [300_000, 500_000, 1_000_000, 1_500_000] as const;
export const TRANSITION_LABELS: Record<Transition['kind'], string> = {
  dissolve: 'Dissolve',
  'fade-color': 'Fade through colour',
  slide: 'Slide',
};

/** Where a speed change applies: the In–Out marks, else the selected clips' span, else null. */
export function speedRange(
  doc: Project,
  selection: readonly string[],
): { inUs: number; outUs: number; source: 'marks' | 'selection' } | null {
  const { inUs, outUs } = doc.timeline.marks;
  if (inUs !== null && outUs !== null && outUs > inUs) return { inUs, outUs, source: 'marks' };
  const clips = selection.flatMap((id) => {
    const found = findClip(doc, id);
    return found ? [found.clip] : [];
  });
  if (clips.length === 0) return null;
  return {
    inUs: Math.min(...clips.map((c) => c.timelineStartUs)),
    outUs: Math.max(...clips.map(clipEndUs)),
    source: 'selection',
  };
}

/** The speed of the clips in a range when they share one (freeze frames aside), else null. */
export function speedIn(doc: Project, range: { inUs: number; outUs: number }): number | null {
  let speed: number | null = null;
  for (const track of doc.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.freeze || clipEndUs(clip) <= range.inUs || clip.timelineStartUs >= range.outUs) {
        continue;
      }
      const s = clip.speed ?? 1;
      if (speed !== null && speed !== s) return null;
      speed = s;
    }
  }
  return speed;
}

export function speedOp(range: { inUs: number; outUs: number }, speed: number): TimelineOp {
  return { type: 'setSpeed', inUs: range.inUs, outUs: range.outUs, speed };
}

export function freezeOp(atUs: number, durationUs: number): TimelineOp {
  return { type: 'freezeFrame', atUs, durationUs };
}

/** The selected clip a transition applies to: the first selected video clip. */
export function transitionClip(doc: Project, selection: readonly string[]): Clip | null {
  for (const id of selection) {
    const found = findClip(doc, id);
    if (found && doc.timeline.tracks[found.trackIndex]?.type === 'video') return found.clip;
  }
  return null;
}

/** A transition of `kind` (null: none), keeping the clip's other transition settings. */
export function transitionOp(
  clip: Clip,
  kind: Transition['kind'] | null,
  change: Partial<Omit<Transition, 'kind'>> = {},
): TimelineOp {
  if (kind === null) return { type: 'setTransition', clipId: clip.id, transition: null };
  const current = clip.transitionIn;
  const durationUs = Math.min(
    change.durationUs ?? current?.durationUs ?? 500_000,
    clipEndUs(clip) - clip.timelineStartUs,
  );
  const transition: Transition = { kind, durationUs };
  const color = change.color ?? current?.color;
  const direction = change.direction ?? current?.direction;
  if (kind === 'fade-color' && color) transition.color = color;
  if (kind === 'slide') transition.direction = direction ?? 'left';
  return { type: 'setTransition', clipId: clip.id, transition };
}

export function addMarkerOp(atUs: number, id: string): TimelineOp {
  return { type: 'addMarker', marker: { id, tUs: atUs, label: '', chapter: false } };
}
