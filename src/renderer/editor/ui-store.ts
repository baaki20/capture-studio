/**
 * Editor UI state that is not part of the project document: playhead and transport, clip
 * selection, timeline zoom and scroll, snapping, and the preview's face-overlay selection.
 * Zustand (vanilla) like the document store, so the playback loop and keyboard commands use it
 * outside React; components read it with `useUi(store, selector)`.
 */
import { createStore, useStore, type StoreApi } from 'zustand';
import type { TimelineView } from './Timeline/geometry';

export interface UiState {
  playheadUs: number;
  playing: boolean;
  /** Transport rate: 1 normal, ±2 shuttle (R1.34). */
  rate: number;
  /** Selected clip IDs (linked partners are implied, not listed). */
  selection: string[];
  view: TimelineView;
  /** Snapping to playhead, clip edges and marks while dragging (R1.39, toggled with N). */
  snapping: boolean;
  /** The face overlay is selected in the preview (bounding box shown, R1.41). */
  overlaySelected: boolean;
  /** One-line status ("Nothing to split", errors). */
  status: string | null;
}

export interface UiActions {
  setPlayhead(us: number): void;
  setTransport(playing: boolean, rate: number): void;
  select(clipIds: string[]): void;
  toggleSelected(clipId: string): void;
  setView(view: TimelineView): void;
  setSnapping(on: boolean): void;
  setOverlaySelected(on: boolean): void;
  setStatus(status: string | null): void;
}

export type UiStoreState = UiState & UiActions;
export type UiStore = StoreApi<UiStoreState>;

export const DEFAULT_VIEW: TimelineView = { pxPerSec: 40, scrollUs: 0 };

export function createUiStore(initial: Partial<UiState> = {}): UiStore {
  return createStore<UiStoreState>()((set, get) => ({
    playheadUs: 0,
    playing: false,
    rate: 1,
    selection: [],
    view: DEFAULT_VIEW,
    snapping: true,
    overlaySelected: false,
    status: null,
    ...initial,
    setPlayhead: (us) => {
      if (us !== get().playheadUs) set({ playheadUs: Math.max(0, Math.round(us)) });
    },
    setTransport: (playing, rate) => set({ playing, rate }),
    select: (clipIds) => set({ selection: [...new Set(clipIds)] }),
    toggleSelected: (clipId) => {
      const current = get().selection;
      set({
        selection: current.includes(clipId)
          ? current.filter((id) => id !== clipId)
          : [...current, clipId],
      });
    },
    setView: (view) => set({ view }),
    setSnapping: (on) => set({ snapping: on }),
    setOverlaySelected: (on) => set({ overlaySelected: on }),
    setStatus: (status) => set({ status }),
  }));
}

export function useUi<T>(store: UiStore, selector: (state: UiStoreState) => T): T {
  return useStore(store, selector);
}
