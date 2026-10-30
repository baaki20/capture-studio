/**
 * IPC of the in-app screen-source picker (R1.53, D-6; `main/windows/source-picker.ts`). It has
 * its own small channel set, outside the app contract, because only that one window uses it.
 * Main validates every payload (zod, in the window module, so the preload bundles no zod) and
 * accepts calls only from the picker window.
 */

export const SOURCE_PICKER_CHANNELS = {
  /** Page → main: the sources to show and the one to start on. */
  load: 'sourcePicker.load',
  /** Page → main: the user chose this source (`{id}`). */
  choose: 'sourcePicker.choose',
  /** Page → main: the user cancelled (Esc, Cancel). */
  cancel: 'sourcePicker.cancel',
} as const;

export interface SourcePickerItem {
  id: string;
  name: string;
  /** A `data:image/png` URL, or null when the system gave no thumbnail. */
  thumbnail: string | null;
}

export interface SourcePickerLoad {
  sources: SourcePickerItem[];
  /** The source highlighted first: the last one chosen when it is still listed. */
  initialId: string | null;
}

/** `window.csSourcePicker`, exposed by `preload/source-picker.ts`. */
export interface SourcePickerPreloadApi {
  load(): Promise<SourcePickerLoad>;
  choose(id: string): Promise<void>;
  cancel(): Promise<void>;
}
