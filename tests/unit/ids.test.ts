import { describe, expect, it } from 'vitest';
import { createUlidFactory, isId, isUlid, newId, ulid, ulidTime } from '../../src/shared/ids';

describe('ids', () => {
  it('creates prefixed ULIDs', () => {
    const id = newId('project');
    expect(id).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isId('project', id)).toBe(true);
    expect(isId('media', id)).toBe(false);
    expect(isId('project', 'prj_short')).toBe(false);
    expect(isId('project', 42)).toBe(false);
  });

  it('encodes the creation time', () => {
    const make = createUlidFactory({ now: () => 1_729_778_712_345, random: (b) => b.fill(0) });
    const value = make();
    expect(value).toHaveLength(26);
    expect(value.slice(10)).toBe('0'.repeat(16));
    expect(isUlid(value)).toBe(true);
    expect(ulidTime(value)).toBe(1_729_778_712_345);
    expect(ulidTime('not-a-ulid')).toBeNull();
  });

  it('is strictly increasing within one millisecond and when the clock steps back', () => {
    let now = 1_000;
    const make = createUlidFactory({ now: () => now, random: (b) => b.fill(0) });
    const a = make();
    const b = make();
    now = 900; // clock went backwards
    const c = make();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(ulidTime(c)).toBe(1_000);
  });

  it('refuses to wrap the random component within one millisecond', () => {
    const make = createUlidFactory({ now: () => 1, random: (b) => b.fill(255) });
    make();
    expect(() => make()).toThrow(/overflowed/);
  });

  it('sorts by time across milliseconds', () => {
    let now = 5_000;
    const make = createUlidFactory({ now: () => now });
    const first = make();
    now += 1;
    expect(first < make()).toBe(true);
  });

  it('produces unique values with the default random source', () => {
    const seen = new Set(Array.from({ length: 10_000 }, () => ulid()));
    expect(seen.size).toBe(10_000);
  });
});
