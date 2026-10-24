import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_NAME_PATTERN,
  formatNamePattern,
  makeFileName,
  sanitizeFileName,
  uniqueName,
} from '../../src/shared/naming/name-pattern';

const now = new Date(2026, 9, 24, 14, 5, 7); // local time 2026-10-24 14:05:07

describe('name pattern (P1 subset)', () => {
  it('expands the default project pattern (R1.25)', () => {
    expect(DEFAULT_PROJECT_NAME_PATTERN).toBe('Lesson %y-%mo-%d %h-%mi');
    expect(formatNamePattern(DEFAULT_PROJECT_NAME_PATTERN, { now }).text).toBe(
      'Lesson 2026-10-24 14-05',
    );
  });

  it('expands every subset token', () => {
    const out = formatNamePattern('%y|%mo|%d|%h|%mi|%s|%i', { now, increment: 7 });
    expect(out).toEqual({ text: '2026|10|24|14|05|07|7', usedIncrement: true });
    expect(formatNamePattern('%y', { now }).usedIncrement).toBe(false);
  });

  it('pads single digits', () => {
    const early = new Date(2026, 0, 2, 3, 4, 5);
    expect(formatNamePattern('%mo-%d %h:%mi:%s', { now: early }).text).toBe('01-02 03:04:05');
  });

  it('generates random alphanumerics with {N} repetition', () => {
    let i = 0;
    const random = () => (i++ % 62) / 62;
    expect(formatNamePattern('%ra', { now, random }).text).toBe('0');
    expect(formatNamePattern('x%ra{5}y', { now, random }).text).toBe('x12345y');
    const long = formatNamePattern('%ra{999}', { now }).text;
    expect(long).toHaveLength(100);
    expect(long).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('keeps unknown tokens and stray percent signs verbatim', () => {
    expect(formatNamePattern('100% %t %pn %x', { now }).text).toBe('100% %t %pn %x');
    expect(formatNamePattern('%ra{abc}', { now, random: () => 0 }).text).toBe('0{abc}');
  });
});

describe('sanitizeFileName', () => {
  it('replaces characters invalid on any supported OS', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('tab\there\u0001')).toBe('tab_here_');
    expect(sanitizeFileName('many   spaces')).toBe('many spaces');
  });

  it('trims, removes trailing dots and handles empty or reserved names', () => {
    expect(sanitizeFileName('  name.  ')).toBe('name');
    expect(sanitizeFileName('...')).toBe('Untitled');
    expect(sanitizeFileName('')).toBe('Untitled');
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('nul.txt')).toBe('_nul.txt');
  });

  it('limits length to 100 without splitting surrogate pairs', () => {
    expect(sanitizeFileName('x'.repeat(150))).toHaveLength(100);
    const emoji = 'a' + '😀'.repeat(60);
    const out = sanitizeFileName(emoji);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('\ud83d')).toBe(false);
  });

  it('makeFileName formats and sanitizes', () => {
    expect(makeFileName('Lesson %h:%mi', { now }).text).toBe('Lesson 14_05');
  });
});

describe('uniqueName', () => {
  it('appends (2), (3), … before the extension', () => {
    const taken = new Set(['Lesson.cstudio', 'Lesson (2).cstudio']);
    expect(uniqueName('Lesson', '.cstudio', (c) => taken.has(c))).toBe('Lesson (3).cstudio');
    expect(uniqueName('Fresh', '.cstudio', () => false)).toBe('Fresh.cstudio');
  });

  it('keeps the whole name within the length limit', () => {
    const base = 'y'.repeat(100);
    const name = uniqueName(base, '.cstudio', (c) => c === base.slice(0, 92) + '.cstudio');
    expect(name).toHaveLength(100);
    expect(name.endsWith(' (2).cstudio')).toBe(true);
  });
});
