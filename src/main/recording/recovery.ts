/**
 * Recovery of interrupted recordings (§4.3.6, R1.21).
 *
 * At startup the projects folder is scanned one level deep. A project is a candidate when its
 * `project.json` says it is still `recording` or `finalizing` (or cannot be read while the
 * session log exists) and its `session.lock` is stale: missing, held by a dead process, or with
 * a heartbeat older than 15 s.
 *
 * - **Recover** runs the finalize steps on whatever stream files are readable (FFmpeg's remux
 *   tolerates a truncated last fragment), takes durations from the probed media, fits drift,
 *   rebuilds the timeline from the session log's manifest and writes the project with
 *   `recording.state = "recovered"`.
 * - **Discard** moves the folder to the OS trash, or leaves it (it is not offered again in this
 *   run).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import type { RecoveryCandidateSchema, StreamKind } from '../../shared/ipc/contract';
import { STREAM_KINDS } from '../../shared/ipc/contract';
import type { FinalizedStream } from '../../shared/ipc/media-utility';
import { newId } from '../../shared/ids';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import {
  projectFromRecording,
  RECORDING_MANIFEST_VERSION,
  type RecordedStream,
  type RecordingManifest,
} from '../../shared/project/from-recording';
import {
  FRAME_RATES,
  type FrameRate,
  type ProjectV1,
  type RecordingInfo,
} from '../../shared/project/schema';
import type { ProjectStore } from '../projects/project-store';
import { isProjectFolderName } from '../projects/project-store';
import {
  expectedStreams,
  finalFileName,
  fitDrift,
  generateCaches,
  isLockStale,
  isVideoKind,
  MEDIA_DIR,
  readLock,
  readSessionLog,
  recFileName,
  recordedStream,
  removeLock,
  sessionDurationUs,
  shiftCheckpoints,
  streamMetaFromLog,
  withState,
  writeSessionLog,
  type JobRunner,
  type SessionLog,
  type StreamMeta,
} from './assemble';

export type RecoveryCandidate = z.infer<typeof RecoveryCandidateSchema>;

export interface RecoveryDeps {
  store: ProjectStore;
  utility: JobRunner;
  projectsDir: () => string;
  /** `shell.trashItem`. */
  trashItem: (fullPath: string) => Promise<void>;
  appVersion: string;
  /** Used only when the session log is missing. */
  platform: () => RecordingInfo['platform'];
  /** The folder of the recording in progress in this run (never a candidate). */
  activeRoot?: () => string | null;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  hostname?: string;
  logger?: Logger;
}

interface Found extends RecoveryCandidate {
  root: string;
  doc: ProjectV1 | null;
  log: SessionLog | null;
}

const RECOVERABLE_STATES = new Set(['recording', 'finalizing']);

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(full);
    else if (entry.isFile()) total += (await fs.stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}

function asFrameRate(value: number | undefined): FrameRate {
  return FRAME_RATES.find((r) => r === value) ?? 30;
}

export class RecoveryService {
  private readonly dismissed = new Set<string>();
  private readonly found = new Map<string, Found>();
  private readonly logger: Logger;

  constructor(private readonly deps: RecoveryDeps) {
    this.logger = deps.logger ?? silentLogger;
  }

  /** `recovery.list`: interrupted recordings with a stale lock. */
  async list(): Promise<RecoveryCandidate[]> {
    this.found.clear();
    const dir = this.deps.projectsDir();
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const active = this.deps.activeRoot?.();
    const now = (this.deps.now ?? (() => new Date()))();

    for (const name of names.filter(isProjectFolderName)) {
      const root = path.join(dir, name);
      if (active && path.resolve(active) === path.resolve(root)) continue;
      const stat = await fs.stat(root).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const loaded = await this.deps.store.read(root);
      const log = await readSessionLog(root);
      const state = loaded?.doc.recording?.state ?? (log ? 'recording' : null);
      if (!state || !RECOVERABLE_STATES.has(state)) continue;
      const lock = await readLock(root);
      const stale = isLockStale(lock, {
        now,
        ownPid: process.pid,
        ...(this.deps.isAlive ? { isAlive: this.deps.isAlive } : {}),
        hostname: this.deps.hostname ?? os.hostname(),
      });
      if (!stale) continue;

      const id = loaded?.doc.id ?? log?.manifest.projectId;
      if (!id || this.dismissed.has(id)) continue;
      const candidate: Found = {
        id,
        name: loaded?.doc.name ?? log?.manifest.name ?? name,
        startedAt: loaded?.doc.recording?.startedAt ?? log?.manifest.recording.startedAt ?? null,
        state,
        sizeBytes: await folderSize(path.join(root, MEDIA_DIR)),
        root,
        doc: loaded?.doc ?? null,
        log,
      };
      this.found.set(id, candidate);
      this.deps.store.register(id, root);
    }
    return [...this.found.values()].map(({ id, name, startedAt, state, sizeBytes }) => ({
      id,
      name,
      startedAt,
      state,
      sizeBytes,
    }));
  }

  /** `recovery.recover`: finalizes what is readable and writes a `recovered` project. */
  async recover(id: string): Promise<{ projectId: string }> {
    const candidate = await this.candidate(id);
    const { root } = candidate;
    const mediaDir = path.join(root, MEDIA_DIR);
    const base = this.baseManifest(candidate);
    const frameRate = base.frameRate;

    // Streams: from the session log, plus any stream file the log does not mention.
    const metas = new Map<StreamKind, StreamMeta>();
    for (const entry of candidate.log?.streams ?? []) {
      metas.set(entry.kind, streamMetaFromLog(entry, entry.kind === 'screen' ? frameRate : null));
    }
    for (const kind of STREAM_KINDS) {
      if (metas.has(kind)) continue;
      const hasFile =
        (await exists(path.join(mediaDir, recFileName(kind)))) ||
        (await exists(path.join(mediaDir, finalFileName(kind))));
      if (!hasFile) continue;
      metas.set(kind, {
        kind,
        mediaId: newId('media'),
        label: null,
        encoder: null,
        sync: {
          mode: isVideoKind(kind) ? 'shared' : 'arrival-calibrated',
          offsetUs: 0,
          clockHandshakeUs: null,
        },
        startOffsetUs: null,
        endedEarly: false,
        stats: null,
        frameRate: kind === 'screen' ? frameRate : null,
      });
    }
    // Only streams that left a file can be finalized.
    const present: StreamKind[] = [];
    for (const kind of metas.keys()) {
      if (
        (await exists(path.join(mediaDir, recFileName(kind)))) ||
        (await exists(path.join(mediaDir, finalFileName(kind))))
      ) {
        present.push(kind);
      }
    }

    let files: FinalizedStream[] = [];
    if (present.length > 0) {
      const result = await this.deps.utility.runJob({
        kind: 'finalize',
        dir: mediaDir,
        streams: present.map((kind) => ({ kind, expect: expectedStreams(kind) })),
        recovering: true,
      });
      files = result.streams;
    }

    const t0Us = candidate.log?.t0Us ?? null;
    const offsetUs = candidate.log?.utilityClockOffsetUs ?? 0;
    const streams: RecordedStream[] = [];
    for (const meta of metas.values()) {
      const file = files.find((f) => f.kind === meta.kind) ?? null;
      if (file && !file.ok) this.logger.warn(`recovery: ${meta.kind}: ${file.error ?? 'failed'}`);
      let sync = file?.sync ?? null;
      if (sync && meta.kind === 'system') {
        // On the utility clock; without t0 the slope (all the fit needs) is still right.
        sync = shiftCheckpoints(sync, (t0Us ?? 0) + offsetUs);
      }
      const drift = isVideoKind(meta.kind) ? null : fitDrift(sync);
      // A stream that wrote no file at all is left out instead of listed as failed.
      if (!file) continue;
      streams.push(recordedStream(meta, file, drift, true));
    }
    if (!streams.some((s) => s.status === 'recovered')) {
      throw new Error('no stream could be recovered');
    }

    const durationUs = sessionDurationUs(streams, base.recording.durationUs);
    const manifest = withState(
      {
        ...base,
        recording: {
          ...base.recording,
          durationUs,
          pauses: base.recording.pauses.map((p) => ({
            startUs: p.startUs,
            endUs: Math.min(p.endUs, durationUs),
          })),
        },
        streams,
      },
      'recovered',
    );
    const built = projectFromRecording(manifest, {
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    if (!built.ok) {
      throw new Error(`recovered project is invalid: ${built.error.issues.slice(0, 3).join('; ')}`);
    }
    await generateCaches(this.deps.utility, root, built.value.media, this.logger);
    await this.deps.store.write(root, built.value);
    if (candidate.log) {
      await writeSessionLog(root, {
        ...candidate.log,
        updatedAt: new Date().toISOString(),
        manifest,
      }).catch(() => undefined);
    }
    await removeLock(root);
    this.found.delete(id);
    this.logger.info(`recovery: recovered ${root} (${String(streams.length)} streams)`);
    return { projectId: built.value.id };
  }

  /** `recovery.discard`: trash the folder, or leave it alone for this run. */
  async discard(id: string, action: 'trash' | 'leave'): Promise<void> {
    if (action === 'leave') {
      this.dismissed.add(id);
      this.found.delete(id);
      return;
    }
    const candidate = await this.candidate(id);
    await this.deps.trashItem(candidate.root);
    this.deps.store.unregister(id);
    this.found.delete(id);
  }

  private async candidate(id: string): Promise<Found> {
    let found = this.found.get(id);
    if (!found) {
      await this.list();
      found = this.found.get(id);
    }
    if (!found) throw new Error(`no interrupted recording ${id}`);
    return found;
  }

  /** The manifest from the session log, or one rebuilt from the recording-state project. */
  private baseManifest(candidate: Found): RecordingManifest {
    if (candidate.log) return candidate.log.manifest;
    const doc = candidate.doc;
    const now = new Date().toISOString();
    const rec = doc?.recording;
    return {
      version: RECORDING_MANIFEST_VERSION,
      projectId: candidate.id,
      name: candidate.name,
      createdAt: doc?.createdAt ?? now,
      appVersion: this.deps.appVersion,
      recording: {
        state: 'recording',
        sessionId: rec?.sessionId ?? newId('session'),
        startedAt: rec?.startedAt ?? now,
        durationUs: rec?.durationUs ?? 0,
        pauses: rec?.pauses ?? [],
        source: rec?.source ?? {
          kind: 'monitor',
          widthPx: doc?.timeline.canvas.width ?? 1920,
          heightPx: doc?.timeline.canvas.height ?? 1080,
          region: null,
        },
        platform: rec?.platform ?? this.deps.platform(),
      },
      frameRate: asFrameRate(doc?.timeline.frameRate),
      streams: [],
    };
  }
}
