/**
 * Prefixed ULIDs (`prj_01JB…`). ULIDs sort by creation time, which keeps folder listings and logs
 * in a sensible order, and the prefix tells a reader what kind of object an ID names.
 */

export const ID_PREFIXES = {
  project: 'prj',
  session: 'ses',
  media: 'med',
  component: 'cmp',
  track: 'trk',
  clip: 'clp',
  link: 'lnk',
  secret: 'sec',
  job: 'job',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

/** Crockford base32, the ULID alphabet (no I, L, O, U). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const TIME_MAX = 2 ** 48 - 1;

export const ULID_PATTERN = '[0-9A-HJKMNP-TV-Z]{26}';
const ULID_RE = new RegExp(`^${ULID_PATTERN}$`);

export type RandomSource = (bytes: Uint8Array) => void;

interface CryptoLike {
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

/** Web Crypto exists in every runtime we target (Node ≥ 19, Chromium, workers). */
function defaultRandom(bytes: Uint8Array): void {
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!crypto) throw new Error('No Web Crypto random source available');
  crypto.getRandomValues(bytes);
}

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > TIME_MAX) {
    throw new RangeError(`ULID time out of range: ${String(ms)}`);
  }
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function randomChars(random: RandomSource): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  random(bytes);
  // 5 bits per character; masking a full byte keeps the distribution uniform.
  return Array.from(bytes, (b) => b & 31);
}

/** Adds one to a base32 digit array. Returns false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i] ?? 0;
    if (d < 31) {
      digits[i] = d + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

export interface UlidFactoryOptions {
  now?: () => number;
  random?: RandomSource;
}

/**
 * Returns a ULID generator. IDs from one generator are strictly increasing, even when several are
 * created within the same millisecond or the clock steps backwards.
 */
export function createUlidFactory(options: UlidFactoryOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultRandom;
  let lastTime = -1;
  let lastRandom: number[] = [];

  return () => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      const next = [...lastRandom];
      if (!increment(next))
        throw new Error('ULID random component overflowed within one millisecond');
      lastRandom = next;
    } else {
      lastTime = time;
      lastRandom = randomChars(random);
    }
    return encodeTime(time) + lastRandom.map((d) => ENCODING.charAt(d)).join('');
  };
}

const defaultUlid = createUlidFactory();

export function ulid(): string {
  return defaultUlid();
}

export function newId(kind: IdKind, generate: () => string = defaultUlid): string {
  return `${ID_PREFIXES[kind]}_${generate()}`;
}

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/** True when `value` is `<prefix>_<ULID>` for the given kind. */
export function isId(kind: IdKind, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && isUlid(value.slice(prefix.length));
}

/** Milliseconds since the epoch encoded in a ULID, or null if it is not a ULID. */
export function ulidTime(value: string): number | null {
  if (!isUlid(value)) return null;
  let ms = 0;
  for (const ch of value.slice(0, TIME_LEN)) ms = ms * 32 + ENCODING.indexOf(ch);
  return ms;
}
