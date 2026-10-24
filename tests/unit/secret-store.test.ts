import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateSafeStorage,
  SecretStore,
  UNREADABLE_SECRET_MESSAGE,
  type SafeStorageLike,
} from '../../src/main/secrets/secret-store';

/** A fake safeStorage: reversible "encryption" with a key, so tests can see ciphertext ≠ plaintext. */
function mockSafeStorage(
  options: { backend?: string; available?: boolean; key?: number; rotate?: boolean } = {},
) {
  const key = options.key ?? 7;
  const prefix = `enc:${String(key)}:`;
  const mock = {
    encryptCalls: 0,
    isAsyncEncryptionAvailable: () => Promise.resolve(options.available ?? true),
    getSelectedStorageBackend: (): string => options.backend ?? 'gnome_libsecret',
    encryptStringAsync(plain: string): Promise<Buffer> {
      mock.encryptCalls += 1;
      return Promise.resolve(Buffer.from(prefix + Buffer.from(plain).toString('hex')));
    },
    decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
      const text = encrypted.toString();
      if (!text.startsWith(prefix)) {
        return Promise.reject(
          new Error('Error while decrypting the ciphertext provided to safeStorage.'),
        );
      }
      const result = Buffer.from(text.slice(prefix.length), 'hex').toString();
      return Promise.resolve({ result, shouldReEncrypt: options.rotate ?? false });
    },
  } satisfies SafeStorageLike & { encryptCalls: number };
  return mock;
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-secrets-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('evaluateSafeStorage (R1.51)', () => {
  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'allows Linux backend %s',
    async (backend) => {
      expect(await evaluateSafeStorage(mockSafeStorage({ backend }), 'linux')).toEqual({
        persistent: true,
        backend,
        reason: null,
      });
    },
  );

  it.each(['basic_text', 'unknown', 'something_new'])(
    'refuses Linux backend %s',
    async (backend) => {
      const status = await evaluateSafeStorage(mockSafeStorage({ backend }), 'linux');
      expect(status.persistent).toBe(false);
      expect(status.backend).toBe(backend);
      expect(status.reason).toBeTruthy();
    },
  );

  it('refuses when encryption is unavailable or the backend cannot be queried', async () => {
    const unavailable = await evaluateSafeStorage(mockSafeStorage({ available: false }), 'linux');
    expect(unavailable.persistent).toBe(false);
    const noBackendFn: SafeStorageLike = {
      ...mockSafeStorage(),
      getSelectedStorageBackend: undefined,
    };
    expect(await evaluateSafeStorage(noBackendFn, 'linux')).toMatchObject({
      persistent: false,
      backend: 'unknown',
    });
    const throwing: SafeStorageLike = {
      ...mockSafeStorage(),
      getSelectedStorageBackend: () => {
        throw new Error('not ready');
      },
    };
    expect((await evaluateSafeStorage(throwing, 'linux')).persistent).toBe(false);
  });

  it('uses the OS keystore on Windows and macOS', async () => {
    expect(await evaluateSafeStorage(mockSafeStorage(), 'win32')).toMatchObject({
      persistent: true,
      backend: 'dpapi',
    });
    expect(await evaluateSafeStorage(mockSafeStorage(), 'darwin')).toMatchObject({
      persistent: true,
      backend: 'keychain',
    });
    const unavailable = await evaluateSafeStorage(mockSafeStorage({ available: false }), 'darwin');
    expect(unavailable.persistent).toBe(false);
  });
});

describe('SecretStore', () => {
  it('persists only ciphertext with a secure backend', async () => {
    const safeStorage = mockSafeStorage();
    const store = await SecretStore.open({ dir, safeStorage, platform: 'linux' });
    const ref = await store.set('Imgur token', 'hunter2');
    expect(ref).toMatch(/^sec_[0-9A-Z]{26}$/);

    const text = await fs.readFile(path.join(dir, 'secrets.json'), 'utf8');
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      secrets: { [ref]: { label: 'Imgur token' } },
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600);
    }

    const reopened = await SecretStore.open({ dir, safeStorage, platform: 'linux' });
    expect(reopened.has(ref)).toBe(true);
    expect(await reopened.get(ref)).toEqual({ ok: true, value: 'hunter2' });
    expect(reopened.list()).toMatchObject([{ ref, label: 'Imgur token' }]);
    expect(Date.parse(reopened.list()[0]!.createdAt)).not.toBeNaN();
  });

  it('never writes a file with basic_text; keeps secrets in memory for the session', async () => {
    const safeStorage = mockSafeStorage({ backend: 'basic_text' });
    const store = await SecretStore.open({ dir, safeStorage, platform: 'linux' });
    expect(store.status.persistent).toBe(false);

    const ref = await store.set('FTP password', 'pa55');
    expect(await store.get(ref)).toEqual({ ok: true, value: 'pa55' });
    expect(safeStorage.encryptCalls).toBe(0);
    await expect(fs.access(path.join(dir, 'secrets.json'))).rejects.toThrow();

    const nextSession = await SecretStore.open({ dir, safeStorage, platform: 'linux' });
    expect(nextSession.has(ref)).toBe(false);
  });

  it('does not read an existing secrets file when the backend became insecure', async () => {
    const secure = await SecretStore.open({
      dir,
      safeStorage: mockSafeStorage(),
      platform: 'linux',
    });
    const ref = await secure.set('token', 'abc');
    const insecure = await SecretStore.open({
      dir,
      safeStorage: mockSafeStorage({ backend: 'basic_text' }),
      platform: 'linux',
    });
    expect(insecure.has(ref)).toBe(false);
    // …and does not overwrite it either.
    expect(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')).toContain(ref);
  });

  it('reports a decryption failure as unreadable, never as an empty value', async () => {
    const store = await SecretStore.open({
      dir,
      safeStorage: mockSafeStorage({ key: 1 }),
      platform: 'linux',
    });
    const ref = await store.set('token', 'secret-value');
    const otherKeyring = await SecretStore.open({
      dir,
      safeStorage: mockSafeStorage({ key: 2 }),
      platform: 'linux',
    });
    expect(await otherKeyring.get(ref)).toEqual({
      ok: false,
      error: { kind: 'unreadable', message: UNREADABLE_SECRET_MESSAGE },
    });
  });

  it('reports unknown refs as not found', async () => {
    const store = await SecretStore.open({
      dir,
      safeStorage: mockSafeStorage(),
      platform: 'linux',
    });
    expect(await store.get('sec_01JBQ4ZJ4X6V3K8N2M7P5R9T0W')).toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    });
  });

  it('replaces and deletes secrets', async () => {
    const store = await SecretStore.open({
      dir,
      safeStorage: mockSafeStorage(),
      platform: 'linux',
    });
    const ref = await store.set('token', 'one');
    await store.set('token', 'two', ref);
    expect(await store.get(ref)).toEqual({ ok: true, value: 'two' });
    expect(await store.delete(ref)).toBe(true);
    expect(await store.delete(ref)).toBe(false);
    const reopened = await SecretStore.open({
      dir,
      safeStorage: mockSafeStorage(),
      platform: 'linux',
    });
    expect(reopened.list()).toEqual([]);
    await expect(store.set('x', 'y', '../etc/passwd')).rejects.toThrow(/secretRef/);
  });

  it('re-encrypts when the keyring rotated its key', async () => {
    const store = await SecretStore.open({
      dir,
      safeStorage: mockSafeStorage(),
      platform: 'linux',
    });
    const ref = await store.set('token', 'value');
    const rotating = mockSafeStorage({ rotate: true });
    const reopened = await SecretStore.open({ dir, safeStorage: rotating, platform: 'linux' });
    expect(await reopened.get(ref)).toEqual({ ok: true, value: 'value' });
    expect(rotating.encryptCalls).toBe(1);
  });

  it('survives a corrupted secrets.json by falling back to .bak', async () => {
    const safeStorage = mockSafeStorage();
    const store = await SecretStore.open({ dir, safeStorage, platform: 'linux' });
    const first = await store.set('a', '1');
    await store.set('b', '2'); // .bak now holds only "a"
    await fs.writeFile(path.join(dir, 'secrets.json'), '{"schemaVersion":1,"secr');
    const reopened = await SecretStore.open({ dir, safeStorage, platform: 'linux' });
    expect(await reopened.get(first)).toEqual({ ok: true, value: '1' });
  });
});
