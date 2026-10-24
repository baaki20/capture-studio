import { describe, expect, it } from 'vitest';
import { defineMigrations, migrate } from '../../src/shared/migrate';

const registry = defineMigrations({
  versionKey: 'schemaVersion',
  currentVersion: 3,
  migrations: [
    {
      from: 1,
      description: 'rename colour to color',
      up: ({ colour, ...rest }) => ({ ...rest, color: colour }),
    },
    { from: 2, description: 'add theme', up: (doc) => ({ ...doc, theme: 'system' }) },
  ],
});

describe('migrations', () => {
  it('runs every step from the document version to the current one', () => {
    const input = { schemaVersion: 1, colour: 'red' };
    const out = migrate(input, registry);
    expect(out).toEqual({
      status: 'migrated',
      doc: { schemaVersion: 3, color: 'red', theme: 'system' },
      fromVersion: 1,
      version: 3,
      applied: ['rename colour to color', 'add theme'],
    });
    expect(input).toEqual({ schemaVersion: 1, colour: 'red' }); // pure: input untouched
  });

  it('starts from the middle of the chain', () => {
    const out = migrate({ schemaVersion: 2, color: 'blue' }, registry);
    expect(out.status === 'migrated' && out.applied).toEqual(['add theme']);
  });

  it('passes current documents through and flags newer ones', () => {
    expect(migrate({ schemaVersion: 3 }, registry).status).toBe('current');
    const newer = migrate({ schemaVersion: 4, extra: true }, registry);
    expect(newer).toEqual({ status: 'newer', doc: { schemaVersion: 4, extra: true }, version: 4 });
  });

  it('rejects documents without a usable version', () => {
    for (const bad of [
      null,
      [],
      'x',
      {},
      { schemaVersion: '1' },
      { schemaVersion: 0 },
      { schemaVersion: 1.5 },
    ]) {
      expect(migrate(bad, registry).status).toBe('invalid');
    }
  });

  it('refuses broken chains at definition time', () => {
    expect(() =>
      defineMigrations({
        versionKey: 'v',
        currentVersion: 3,
        migrations: [{ from: 1, description: 'a', up: (d) => d }],
      }),
    ).toThrow(/ends at 2/);
    expect(() =>
      defineMigrations({
        versionKey: 'v',
        currentVersion: 4,
        migrations: [
          { from: 1, description: 'a', up: (d) => d },
          { from: 3, description: 'b', up: (d) => d },
        ],
      }),
    ).toThrow(/gap/);
  });

  it('accepts an empty chain for a first version', () => {
    const v1 = defineMigrations({ versionKey: 'formatVersion', currentVersion: 1 });
    expect(migrate({ formatVersion: 1 }, v1).status).toBe('current');
  });
});
