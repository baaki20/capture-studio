/**
 * The fonts text objects use (R2.5, plan risk 2): four open-licence families (SIL OFL 1.1, from
 * Fontsource) inlined into the bundle and registered with the `FontFace` API, so the preview
 * worker and the export's render window draw the same glyphs on every machine, with no network
 * or system fonts involved. Latin and Latin Extended, regular and bold; italics are slanted by
 * the browser, the same way in both.
 *
 * Inter (sans), Source Serif 4 (serif), JetBrains Mono (mono), Caveat (handwriting).
 */
import inter_latin_400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?inline';
import inter_latin_700 from '@fontsource/inter/files/inter-latin-700-normal.woff2?inline';
import inter_latin_ext_400 from '@fontsource/inter/files/inter-latin-ext-400-normal.woff2?inline';
import inter_latin_ext_700 from '@fontsource/inter/files/inter-latin-ext-700-normal.woff2?inline';
import source_serif_four_latin_400 from '@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2?inline';
import source_serif_four_latin_700 from '@fontsource/source-serif-4/files/source-serif-4-latin-700-normal.woff2?inline';
import source_serif_four_latin_ext_400 from '@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-normal.woff2?inline';
import source_serif_four_latin_ext_700 from '@fontsource/source-serif-4/files/source-serif-4-latin-ext-700-normal.woff2?inline';
import jetbrains_mono_latin_400 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?inline';
import jetbrains_mono_latin_700 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?inline';
import jetbrains_mono_latin_ext_400 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-400-normal.woff2?inline';
import jetbrains_mono_latin_ext_700 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-700-normal.woff2?inline';
import caveat_latin_400 from '@fontsource/caveat/files/caveat-latin-400-normal.woff2?inline';
import caveat_latin_700 from '@fontsource/caveat/files/caveat-latin-700-normal.woff2?inline';
import caveat_latin_ext_400 from '@fontsource/caveat/files/caveat-latin-ext-400-normal.woff2?inline';
import caveat_latin_ext_700 from '@fontsource/caveat/files/caveat-latin-ext-700-normal.woff2?inline';
import type { TextStyle } from '../../../shared/project/objects';

/** The CSS family name of each object font. */
export const FONT_FAMILIES: Record<TextStyle['font'], string> = {
  sans: 'CS Sans',
  serif: 'CS Serif',
  mono: 'CS Mono',
  handwriting: 'CS Handwriting',
};

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

const FACES: { font: TextStyle['font']; weight: string; range: string; data: string }[] = [
  { font: 'sans', weight: '400', range: LATIN, data: inter_latin_400 },
  { font: 'sans', weight: '700', range: LATIN, data: inter_latin_700 },
  { font: 'sans', weight: '400', range: LATIN_EXT, data: inter_latin_ext_400 },
  { font: 'sans', weight: '700', range: LATIN_EXT, data: inter_latin_ext_700 },
  { font: 'serif', weight: '400', range: LATIN, data: source_serif_four_latin_400 },
  { font: 'serif', weight: '700', range: LATIN, data: source_serif_four_latin_700 },
  { font: 'serif', weight: '400', range: LATIN_EXT, data: source_serif_four_latin_ext_400 },
  { font: 'serif', weight: '700', range: LATIN_EXT, data: source_serif_four_latin_ext_700 },
  { font: 'mono', weight: '400', range: LATIN, data: jetbrains_mono_latin_400 },
  { font: 'mono', weight: '700', range: LATIN, data: jetbrains_mono_latin_700 },
  { font: 'mono', weight: '400', range: LATIN_EXT, data: jetbrains_mono_latin_ext_400 },
  { font: 'mono', weight: '700', range: LATIN_EXT, data: jetbrains_mono_latin_ext_700 },
  { font: 'handwriting', weight: '400', range: LATIN, data: caveat_latin_400 },
  { font: 'handwriting', weight: '700', range: LATIN, data: caveat_latin_700 },
  { font: 'handwriting', weight: '400', range: LATIN_EXT, data: caveat_latin_ext_400 },
  { font: 'handwriting', weight: '700', range: LATIN_EXT, data: caveat_latin_ext_700 },
];

/** A `data:` URL's bytes (FontFace from bytes needs no fetch, so no CSP or file access). */
function bytesOf(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

interface FontHost {
  fonts: FontFaceSet;
}

/** The font set of this window (`document.fonts`) or worker (`self.fonts`). */
function defaultHost(): FontHost {
  const scope = globalThis as { document?: FontHost } & Partial<FontHost>;
  if (scope.document) return scope.document;
  if (scope.fonts) return { fonts: scope.fonts };
  throw new Error('no font set in this context');
}

let loading: Promise<void> | null = null;
let loaded = false;

/** Registers and loads every object font in this window or worker (once). */
export function loadObjectFonts(host: FontHost = defaultHost()): Promise<void> {
  loading ??= Promise.all(
    FACES.map(async (face) => {
      const font = new FontFace(FONT_FAMILIES[face.font], bytesOf(face.data), {
        weight: face.weight,
        unicodeRange: face.range,
      });
      await font.load();
      host.fonts.add(font);
    }),
  ).then(() => {
    loaded = true;
  });
  return loading;
}

/** Whether `loadObjectFonts` has finished (text is drawn only then). */
export function objectFontsLoaded(): boolean {
  return loaded;
}
