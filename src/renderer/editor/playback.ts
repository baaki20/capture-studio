/**
 * Transport (R1.34): play/pause, J/K/L shuttle, seeking, frame steps, Home/End.
 *
 * The clock is the audio scheduler (`audio/scheduler.ts`): the playhead follows the timeline
 * time being heard, and each animation frame asks the preview to draw it. Reverse shuttle runs
 * the same clock without audio. While paused, every playhead change (scrub, step, seek) renders
 * that frame once.
 */
import { frameToUs, usToFrame } from '../../shared/time';
import { timelineDurationUs } from '../../shared/project/timeline-ops';
import type { DocumentStore } from './store/document-store';
import type { UiStore } from './ui-store';

/** What drives time: the audio scheduler in the app, a fake in tests. */
export interface PlaybackClock {
  start(fromUs: number, rate: number): unknown;
  stop(): void;
  /** Timeline time heard now, or null when stopped. */
  heardTimeUs(): number | null;
}

export interface PreviewSink {
  render(tUs: number, playing: boolean): void;
}

export interface PlaybackDeps {
  docStore: DocumentStore;
  ui: UiStore;
  clock: PlaybackClock;
  preview: PreviewSink | null;
  /** `requestAnimationFrame` / `cancelAnimationFrame` (injected; fakes in tests). */
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
}

export const SHUTTLE_RATE = 2;

export class Playback {
  private frame: number | null = null;
  private readonly unsubscribe: () => void;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(private readonly deps: PlaybackDeps) {
    this.requestFrame = deps.requestFrame;
    this.cancelFrame = deps.cancelFrame;
    this.unsubscribe = deps.ui.subscribe((state, previous) => {
      if (!state.playing && state.playheadUs !== previous.playheadUs) {
        deps.preview?.render(state.playheadUs, false);
      }
    });
  }

  get playing(): boolean {
    return this.deps.ui.getState().playing;
  }

  durationUs(): number {
    const doc = this.deps.docStore.getState().doc;
    return doc ? timelineDurationUs(doc) : 0;
  }

  /** Starts playing at `rate` from the playhead (from the start when at the end). */
  play(rate = 1): void {
    const ui = this.deps.ui.getState();
    const duration = this.durationUs();
    if (duration <= 0) return;
    let from = ui.playheadUs;
    if (rate > 0 && from >= duration) from = 0;
    if (rate < 0 && from <= 0) return;
    ui.setPlayhead(from);
    this.deps.clock.start(from, rate);
    ui.setTransport(true, rate);
    this.schedule();
  }

  pause(): void {
    const ui = this.deps.ui.getState();
    if (!ui.playing) return;
    const heard = this.deps.clock.heardTimeUs();
    this.deps.clock.stop();
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    ui.setTransport(false, 1);
    const t = this.clamp(heard ?? ui.playheadUs);
    ui.setPlayhead(t);
    this.deps.preview?.render(t, false);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play(1);
  }

  /** J/K/L: −2×, pause, +2× (R1.34). */
  shuttle(direction: -1 | 0 | 1): void {
    if (direction === 0) {
      this.pause();
      return;
    }
    const rate = direction * SHUTTLE_RATE;
    if (this.playing) this.pause();
    this.play(rate);
  }

  /** Moves the playhead; playback continues from there. */
  seek(tUs: number): void {
    const t = this.clamp(tUs);
    const ui = this.deps.ui.getState();
    if (ui.playing) {
      this.deps.clock.start(t, ui.rate);
      ui.setPlayhead(t);
      this.deps.preview?.render(t, true);
    } else {
      ui.setPlayhead(t);
    }
  }

  /** ←/→: one frame at the timeline frame rate, from the frame the playhead is in. */
  step(frames: number): void {
    const doc = this.deps.docStore.getState().doc;
    if (!doc) return;
    if (this.playing) this.pause();
    const fps = doc.timeline.frameRate;
    const index = usToFrame(this.deps.ui.getState().playheadUs, fps);
    this.seek(frameToUs(Math.max(0, index + frames), fps));
  }

  home(): void {
    this.seek(0);
  }

  end(): void {
    if (this.playing) this.pause();
    this.seek(this.durationUs());
  }

  /** Renders the current playhead (after an edit while paused). */
  refresh(): void {
    const ui = this.deps.ui.getState();
    if (!ui.playing) this.deps.preview?.render(ui.playheadUs, false);
  }

  /** One animation frame of playback (exported for tests through `tick`). */
  tick(): void {
    this.frame = null;
    const ui = this.deps.ui.getState();
    if (!ui.playing) return;
    const heard = this.deps.clock.heardTimeUs();
    if (heard === null) return;
    const duration = this.durationUs();
    if ((ui.rate > 0 && heard >= duration) || (ui.rate < 0 && heard <= 0)) {
      this.pause();
      this.seek(ui.rate > 0 ? duration : 0);
      return;
    }
    const t = this.clamp(heard);
    ui.setPlayhead(t);
    this.deps.preview?.render(t, true);
    this.schedule();
  }

  dispose(): void {
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.deps.clock.stop();
    this.unsubscribe();
  }

  private schedule(): void {
    this.frame ??= this.requestFrame(() => this.tick());
  }

  private clamp(tUs: number): number {
    return Math.min(Math.max(0, Math.round(tUs)), this.durationUs());
  }
}
