/**
 * Everything one editor window runs for its project, created once per window and shared with
 * the components through `EditorContext`: the document store with autosave, UI state, waveform
 * and thumbnail assets, the audio scheduler (master clock), the transport and the preview hub
 * the preview pane attaches its worker to.
 */
import { ProxyUrls } from './preview/proxy-urls';
import { AudioRenders } from './audio/audio-renders';
import type { EditorPreloadApi } from '../../shared/ipc/preload-api';
import type { Project } from '../../shared/project/schema';
import { openAudioSource } from './audio/audio-source';
import { AudioScheduler } from './audio/scheduler';
import { Playback, type PreviewSink } from './playback';
import type { PreviewClient } from './preview/preview-client';
import { startAutosave, type Autosave } from './store/autosave';
import { createDocumentStore, type DocumentStore } from './store/document-store';
import { MediaAssets } from './Timeline/media-assets';
import { createUiStore, type UiStore } from './ui-store';

/** Forwards the document and render requests to the preview worker once its pane exists. */
export class PreviewHub implements PreviewSink {
  private client: PreviewClient | null = null;
  private doc: { doc: Project; mediaUrls: Record<string, string> } | null = null;

  get current(): PreviewClient | null {
    return this.client;
  }

  attach(client: PreviewClient | null): void {
    this.client = client;
    if (client && this.doc) client.setDoc(this.doc.doc, this.doc.mediaUrls);
  }

  setDoc(doc: Project, mediaUrls: Record<string, string>): void {
    this.doc = { doc, mediaUrls };
    this.client?.setDoc(doc, mediaUrls);
  }

  render(tUs: number, playing: boolean): void {
    this.client?.render(tUs, playing);
  }

  leadUs(): number {
    return this.client?.leadUs() ?? 0;
  }
}

export interface EditorServices {
  projectId: string;
  api: EditorPreloadApi;
  docStore: DocumentStore;
  ui: UiStore;
  assets: MediaAssets;
  preview: PreviewHub;
  scheduler: AudioScheduler;
  playback: Playback;
  autosave: Autosave;
  /** The media URLs the preview decodes (proxies in place of large videos). */
  previewUrls(): Record<string, string>;
  dispose(): void;
}

export function createEditorServices(api: EditorPreloadApi, projectId: string): EditorServices {
  const docStore = createDocumentStore();
  const ui = createUiStore();
  const assets = new MediaAssets(api.media, projectId);
  const preview = new PreviewHub();
  const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48_000 });
  const scheduler = new AudioScheduler(context, {
    openSource: openAudioSource,
    peaksOf: (mediaId) => assets.peaks.get(mediaId) ?? null,
  });
  // Ducking follows the voice's peaks: recompute envelopes when they load.
  const offAssetsForEnvelopes = assets.onChange(() => scheduler.refreshEnvelopes());
  const renders = new AudioRenders(api.media, projectId);
  // The preview decodes proxies of large videos once they are ready (the export never does).
  const proxies = new ProxyUrls(api.media, projectId);
  const previewUrls = () => ({ ...docStore.getState().mediaUrls, ...proxies.urls });
  const offProxies = proxies.onChange(() => {
    const doc = docStore.getState().doc;
    if (doc) preview.setDoc(doc, previewUrls());
  });
  const offRenders = renders.onChange((ready) => scheduler.setRenders(ready));
  const playback = new Playback({
    docStore,
    ui,
    preview,
    requestFrame: (callback) => requestAnimationFrame(() => callback()),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    clock: {
      start: (from, rate) => {
        void context.resume();
        return scheduler.start(from, rate);
      },
      stop: () => scheduler.stop(),
      heardTimeUs: () => scheduler.heardTimeUs(),
    },
  });
  const autosave = startAutosave(docStore, api.project);

  const unsubscribe = docStore.subscribe((state, previous) => {
    if (!state.doc) return;
    if (state.doc === previous.doc && state.mediaUrls === previous.mediaUrls) return;
    scheduler.setDoc(state.doc, state.mediaUrls);
    preview.setDoc(state.doc, previewUrls());
    proxies.load(state.doc);
    assets.load(state.doc);
    renders.load(state.doc);
    playback.refresh();
  });

  return {
    projectId,
    api,
    docStore,
    ui,
    assets,
    preview,
    scheduler,
    playback,
    autosave,
    previewUrls,
    dispose() {
      unsubscribe();
      playback.dispose();
      scheduler.dispose();
      void context.close();
      assets.dispose();
      offRenders();
      offProxies();
      proxies.dispose();
      offAssetsForEnvelopes();
      renders.dispose();
      void autosave.flush().finally(() => autosave.dispose());
    },
  };
}
