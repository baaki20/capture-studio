/**
 * Opening documents from the file manager (plan D9, R3.20–R3.23): a `.cstudiopack` (a packed
 * project) is unpacked into the library and opened; a `.cstudio` project folder (a document
 * package on macOS) is added to the library where it is and opened.
 *
 * Paths arrive as launch arguments on Windows and Linux (the first launch, or `second-instance`
 * for a running app) and through `open-file` on macOS, which can fire before the app is ready;
 * requests are queued until `ready()` and then opened one at a time.
 */
import path from 'node:path';
import type { Logger } from '../shared/logger';
import { PROJECT_EXTENSION } from '../shared/project/schema';

export const PACK_EXTENSION = '.cstudiopack';

export type DocumentKind = 'pack' | 'project';

/** What a path is by its name: a pack, a project folder, or neither. */
export function documentKind(file: string): DocumentKind | null {
  const name = file.replace(/[\\/]+$/, '').toLowerCase();
  if (name.endsWith(PACK_EXTENSION) || name.endsWith('.zip')) return 'pack';
  if (name.endsWith(PROJECT_EXTENSION)) return 'project';
  return null;
}

/**
 * Documents among launch arguments: arguments that are not switches and name a pack or a project
 * folder (`.zip` only counts when passed through `open-file`, never from argv). Relative paths
 * are resolved against `cwd`.
 */
export function documentArgs(argv: readonly string[], cwd: string): string[] {
  return argv
    .filter((arg) => !arg.startsWith('-'))
    .filter((arg) => {
      const lower = arg.replace(/[\\/]+$/, '').toLowerCase();
      return lower.endsWith(PACK_EXTENSION) || lower.endsWith(PROJECT_EXTENSION);
    })
    .map((arg) => path.resolve(cwd, arg));
}

export interface DocumentOpenerDeps {
  /** Unpacks a pack into the library; resolves with the new project's id. */
  unpack(file: string): Promise<{ id: string }>;
  /** Adds a project folder to the library (or finds it there); resolves with its id. */
  importFolder(folder: string): Promise<{ id: string }>;
  openEditor(projectId: string): void;
  /** Tells the user why a document could not be opened. */
  showError(title: string, message: string): void;
  logger: Logger;
}

export class DocumentOpener {
  private readonly waiting: string[] = [];
  private isReady = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DocumentOpenerDeps) {}

  /** Opens `files` now, or once `ready()` was called. */
  open(files: readonly string[]): void {
    if (!this.isReady) {
      this.waiting.push(...files);
      return;
    }
    for (const file of files) {
      this.chain = this.chain.then(() => this.openOne(file));
    }
  }

  /** The library and editor can be used now: opens what was queued. */
  ready(): void {
    this.isReady = true;
    this.open(this.waiting.splice(0));
  }

  /** Resolves when every document asked for so far has been handled (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private async openOne(file: string): Promise<void> {
    const kind = documentKind(file);
    if (!kind) return;
    try {
      const entry =
        kind === 'pack' ? await this.deps.unpack(file) : await this.deps.importFolder(file);
      this.deps.logger.info(`open: ${kind} ${path.basename(file)} as ${entry.id}`);
      this.deps.openEditor(entry.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(`open: ${path.basename(file)} failed`, error);
      this.deps.showError(
        kind === 'pack' ? 'The pack could not be opened' : 'The project could not be opened',
        `${path.basename(file)}: ${message}`,
      );
    }
  }
}
