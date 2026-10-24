/**
 * Secret store over Electron `safeStorage` (§1.8, R1.51).
 *
 * Settings hold `secretRef` IDs only; `secrets.json` maps each ref to an encrypted value. When
 * the OS keyring is not usable (Linux backend `basic_text` or `unknown`, or encryption is
 * unavailable) secrets are never written to disk: they live in memory for the session and
 * `status.persistent` is false so the UI can show a banner.
 *
 * Uses the asynchronous safeStorage API; the synchronous one is deprecated in Electron 45.
 * Phase 1 stores no secrets; the module exists so later phases build on a tested foundation.
 */
import path from 'node:path';
import { z } from 'zod';
import { newId, isId } from '../../shared/ids';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import { err, ok, type Result } from '../../shared/result';
import { quarantineFile, readFileWithFallback, writeFileAtomic } from '../settings/atomic-file';

export const SECRETS_FILE_NAME = 'secrets.json';
const SECRETS_SCHEMA_VERSION = 1;

/** The part of Electron's `safeStorage` this module uses (injectable for tests). */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  /** Linux only in Electron. */
  getSelectedStorageBackend?(): string;
}

/** Linux keyring backends that actually encrypt with a user secret. */
export const PERSISTENT_LINUX_BACKENDS: readonly string[] = [
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
];

export interface SecretStoreStatus {
  persistent: boolean;
  /** The safeStorage backend name (Linux), or the platform's keystore. */
  backend: string;
  /** Why secrets are session-only; null when persistent. */
  reason: string | null;
}

/** Decides whether secrets may be written to disk with this safeStorage. Call after `ready`. */
export async function evaluateSafeStorage(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
): Promise<SecretStoreStatus> {
  let available: boolean;
  try {
    available = await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    available = false;
  }

  if (platform === 'linux') {
    let backend: string;
    try {
      backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    } catch {
      backend = 'unknown';
    }
    if (!available) {
      return { persistent: false, backend, reason: 'OS encryption is not available' };
    }
    if (!PERSISTENT_LINUX_BACKENDS.includes(backend)) {
      return {
        persistent: false,
        backend,
        reason:
          backend === 'basic_text'
            ? 'No keyring is available (backend "basic_text" would store secrets with a fixed, public key)'
            : `Keyring backend "${backend}" is not recognised as secure`,
      };
    }
    return { persistent: true, backend, reason: null };
  }

  const backend = platform === 'win32' ? 'dpapi' : platform === 'darwin' ? 'keychain' : 'unknown';
  if (!available) return { persistent: false, backend, reason: 'OS encryption is not available' };
  if (backend === 'unknown') {
    return {
      persistent: false,
      backend,
      reason: `Platform "${platform}" has no supported keystore`,
    };
  }
  return { persistent: true, backend, reason: null };
}

const SecretEntrySchema = z.object({
  ciphertext: z.base64(),
  label: z.string(),
  createdAt: z.iso.datetime(),
});

const SecretsFileSchema = z.object({
  schemaVersion: z.literal(SECRETS_SCHEMA_VERSION),
  secrets: z.record(
    z.string().refine((ref) => isId('secret', ref), 'invalid secretRef'),
    SecretEntrySchema,
  ),
});

type SecretsFile = z.infer<typeof SecretsFileSchema>;

export interface SecretInfo {
  ref: string;
  label: string;
  createdAt: string;
}

export type SecretReadError =
  | { kind: 'not-found'; message: string }
  /** Never turned into an empty value (§1.8): the user must re-enter the credential. */
  | { kind: 'unreadable'; message: string };

export const UNREADABLE_SECRET_MESSAGE = 'Credential unreadable, please re-enter it.';

type StoredSecret =
  | { label: string; createdAt: string; ciphertext: Buffer }
  | { label: string; createdAt: string; plaintext: string };

export interface SecretStoreOptions {
  /** Usually `app.getPath('userData')`. */
  dir: string;
  safeStorage: SafeStorageLike;
  platform?: NodeJS.Platform;
  now?: () => Date;
  logger?: Logger;
}

export class SecretStore {
  readonly filePath: string;
  readonly status: SecretStoreStatus;

  private readonly entries = new Map<string, StoredSecret>();
  private readonly logger: Logger;
  private readonly now: () => Date;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: SecretStoreOptions,
    status: SecretStoreStatus,
  ) {
    this.filePath = path.join(options.dir, SECRETS_FILE_NAME);
    this.status = status;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** Must be called after Electron's `ready` event (safeStorage needs it on Linux). */
  static async open(options: SecretStoreOptions): Promise<SecretStore> {
    const status = await evaluateSafeStorage(
      options.safeStorage,
      options.platform ?? process.platform,
    );
    const store = new SecretStore(options, status);
    if (status.persistent) {
      await store.load();
    } else {
      store.logger.warn(`secrets: session-only (${status.backend}): ${status.reason ?? ''}`);
    }
    return store;
  }

  private async load(): Promise<void> {
    const result = await readFileWithFallback(this.filePath, (text) =>
      SecretsFileSchema.parse(JSON.parse(text)),
    );
    if (result.status === 'missing') return;
    if (result.status === 'unreadable') {
      const moved = await quarantineFile(this.filePath, this.now());
      this.logger.error('secrets: secrets.json unreadable; starting empty', {
        moved,
        failures: result.failures,
      });
      return;
    }
    if (result.source !== 'file') {
      this.logger.warn(`secrets: loaded from ${result.source}`);
      await quarantineFile(this.filePath, this.now());
    }
    for (const [ref, entry] of Object.entries(result.value.secrets)) {
      this.entries.set(ref, {
        label: entry.label,
        createdAt: entry.createdAt,
        ciphertext: Buffer.from(entry.ciphertext, 'base64'),
      });
    }
    if (result.source !== 'file') await this.persist();
  }

  has(ref: string): boolean {
    return this.entries.has(ref);
  }

  list(): SecretInfo[] {
    return [...this.entries].map(([ref, e]) => ({ ref, label: e.label, createdAt: e.createdAt }));
  }

  /** Stores a secret and returns its ref. Pass an existing ref to replace that secret. */
  async set(label: string, plaintext: string, ref: string = newId('secret')): Promise<string> {
    if (!isId('secret', ref)) throw new Error('invalid secretRef');
    const createdAt = this.now().toISOString();
    if (this.status.persistent) {
      const ciphertext = await this.options.safeStorage.encryptStringAsync(plaintext);
      this.entries.set(ref, { label, createdAt, ciphertext });
      await this.persist();
    } else {
      this.entries.set(ref, { label, createdAt, plaintext });
    }
    return ref;
  }

  /** Plaintext for main-process use only; never send it to a renderer. */
  async get(ref: string): Promise<Result<string, SecretReadError>> {
    const entry = this.entries.get(ref);
    if (!entry) return err({ kind: 'not-found', message: 'No credential is stored.' });
    if ('plaintext' in entry) return ok(entry.plaintext);

    let decrypted: { result: string; shouldReEncrypt: boolean };
    try {
      decrypted = await this.options.safeStorage.decryptStringAsync(entry.ciphertext);
    } catch (error) {
      this.logger.warn(`secrets: decryption failed for ${ref}`, error);
      return err({ kind: 'unreadable', message: UNREADABLE_SECRET_MESSAGE });
    }

    if (decrypted.shouldReEncrypt) {
      // The keyring rotated its key; store the value under the new key (best effort).
      try {
        const ciphertext = await this.options.safeStorage.encryptStringAsync(decrypted.result);
        this.entries.set(ref, { ...entry, ciphertext });
        await this.persist();
      } catch (error) {
        this.logger.warn(`secrets: re-encryption failed for ${ref}`, error);
      }
    }
    return ok(decrypted.result);
  }

  async delete(ref: string): Promise<boolean> {
    const existed = this.entries.delete(ref);
    if (existed && this.status.persistent) await this.persist();
    return existed;
  }

  private persist(): Promise<void> {
    if (!this.status.persistent) return Promise.resolve();
    const file: SecretsFile = { schemaVersion: SECRETS_SCHEMA_VERSION, secrets: {} };
    for (const [ref, entry] of this.entries) {
      // Only encrypted entries exist in persistent mode.
      if ('ciphertext' in entry) {
        file.secrets[ref] = {
          ciphertext: entry.ciphertext.toString('base64'),
          label: entry.label,
          createdAt: entry.createdAt,
        };
      }
    }
    const text = JSON.stringify(file, null, 2) + '\n';
    const run = (): Promise<void> => writeFileAtomic(this.filePath, text, { mode: 0o600 });
    this.saving = this.saving.then(run, run);
    return this.saving;
  }
}
