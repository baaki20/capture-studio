/**
 * Name patterns for projects and exports. Phase 1 implements the subset
 * `%y %mo %d %h %mi %s %ra{N} %i` (§2.10, R1.25); the full token set arrives in Phase 4.
 * Unknown tokens are kept verbatim so a pattern written for a later version still yields a name.
 */

export const DEFAULT_PROJECT_NAME_PATTERN = 'Lesson %y-%mo-%d %h-%mi';
export const MAX_NAME_LENGTH = 100;

export interface NameContext {
  /** Time used for date tokens, read in the local time zone. */
  now: Date;
  /** Value substituted for `%i` (the persisted increment counter). */
  increment?: number;
  /** Uniform random number in [0, 1); defaults to Math.random. */
  random?: () => number;
}

export interface FormattedName {
  text: string;
  /** True when the pattern used `%i`, so the caller should advance the persisted counter. */
  usedIncrement: boolean;
}

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_REPEAT = MAX_NAME_LENGTH;

type TokenName = 'y' | 'mo' | 'd' | 'h' | 'mi' | 's' | 'ra' | 'i';
/** Longest first, so two-letter tokens win over any one-letter prefix. */
const TOKENS: readonly TokenName[] = ['mo', 'mi', 'ra', 'y', 'd', 'h', 's', 'i'];
export const P1_NAME_TOKENS = TOKENS.map((t) => `%${t}`);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function randomAlphanumeric(count: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += ALPHANUMERIC.charAt(Math.floor(random() * ALPHANUMERIC.length) % ALPHANUMERIC.length);
  }
  return out;
}

export function formatNamePattern(pattern: string, ctx: NameContext): FormattedName {
  const random = ctx.random ?? Math.random;
  const { now } = ctx;
  let usedIncrement = false;
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch !== '%') {
      out += ch;
      i += 1;
      continue;
    }
    const token = TOKENS.find((t) => pattern.startsWith(t, i + 1));
    if (!token) {
      out += ch;
      i += 1;
      continue;
    }
    i += 1 + token.length;

    switch (token) {
      case 'y':
        out += String(now.getFullYear()).padStart(4, '0');
        break;
      case 'mo':
        out += pad2(now.getMonth() + 1);
        break;
      case 'd':
        out += pad2(now.getDate());
        break;
      case 'h':
        out += pad2(now.getHours());
        break;
      case 'mi':
        out += pad2(now.getMinutes());
        break;
      case 's':
        out += pad2(now.getSeconds());
        break;
      case 'i':
        out += String(ctx.increment ?? 0);
        usedIncrement = true;
        break;
      case 'ra': {
        const repeat = /^\{(\d{1,3})\}/.exec(pattern.slice(i));
        let count = 1;
        if (repeat?.[1] !== undefined) {
          count = Math.min(Number(repeat[1]), MAX_REPEAT);
          i += repeat[0].length;
        }
        out += randomAlphanumeric(count, random);
        break;
      }
    }
  }

  return { text: out, usedIncrement };
}

// Characters that are invalid in file names on at least one supported OS, plus control chars.
// eslint-disable-next-line no-control-regex
const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Truncates to `max` UTF-16 units without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Makes a string safe as a file or folder name on Linux, Windows and macOS: invalid characters
 * become `_`, whitespace runs collapse, trailing dots and spaces go, reserved device names are
 * prefixed, and the result is at most `maxLength` long.
 */
export function sanitizeFileName(name: string, maxLength = MAX_NAME_LENGTH): string {
  let out = name.replace(INVALID_FILE_CHARS, '_').replace(/\s+/g, ' ').trim();
  out = truncate(out, maxLength).replace(/[. ]+$/, '');
  if (out === '' || /^\.+$/.test(out)) out = 'Untitled';
  if (WINDOWS_RESERVED.test(out)) out = truncate(`_${out}`, maxLength);
  return out;
}

/**
 * Returns `base + ext`, or the first free `base (n) + ext` for n = 2, 3, … (§6: unique-name
 * suffix). The base is shortened when needed so the whole name stays within `maxLength`.
 */
export function uniqueName(
  base: string,
  ext: string,
  exists: (candidate: string) => boolean,
  maxLength = MAX_NAME_LENGTH,
): string {
  const fit = (suffix: string): string =>
    truncate(base, Math.max(1, maxLength - suffix.length - ext.length)).replace(/[. ]+$/, '') +
    suffix +
    ext;

  const first = fit('');
  if (!exists(first)) return first;
  for (let n = 2; n < 10_000; n++) {
    const candidate = fit(` (${String(n)})`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`no free name for "${base}${ext}"`);
}

/** Formats and sanitizes a pattern into a file-system name (without the unique suffix). */
export function makeFileName(pattern: string, ctx: NameContext): FormattedName {
  const formatted = formatNamePattern(pattern, ctx);
  return { text: sanitizeFileName(formatted.text), usedIncrement: formatted.usedIncrement };
}
