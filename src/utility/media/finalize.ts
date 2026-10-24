/**
 * Finalize (§4.3.5 steps 1–4), also used by recovery (§4.3.6). For each `<kind>.rec.mp4`:
 *
 * 1. remux `-c copy -movflags +faststart` to `<kind>.mp4` (a truncated last fragment is fine);
 * 2. ffprobe the result: duration > 0 and the expected stream counts;
 * 3. read `<kind>.sync.json` for the drift fit (the fit itself runs in main with
 *    `shared/recording/drift.ts`);
 * 4. delete the `.rec` file only when 1–3 succeeded.
 *
 * A stream that fails keeps its `.rec` file and reports why; the others still finalize.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StreamKind } from '../../shared/ipc/contract';
import {
  SyncCheckpointsSchema,
  type FinalizedStream,
  type SyncCheckpoints,
} from '../../shared/ipc/media-utility';
import { fileSize } from './fs-utils';
import { runFfmpeg } from './ffmpeg-runner';
import { probeMedia, type ProbeResult } from './probe';
import { recordingFileName } from './stream-writer';

export interface FinalizeStreamSpec {
  kind: StreamKind;
  expect: { video: number; audio: number };
}

export interface FinalizeOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** The project's `media/` folder. */
  dir: string;
  streams: readonly FinalizeStreamSpec[];
  /** Recovery: an unreadable sync file is ignored instead of blocking the delete. */
  recovering?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export function finalFileName(kind: StreamKind): string {
  return `${kind}.mp4`;
}

export function syncFileName(kind: StreamKind): string {
  return `${kind}.sync.json`;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

function validate(probe: ProbeResult, expect: FinalizeStreamSpec['expect']): string | null {
  if (!probe.durationUs || probe.durationUs <= 0) return 'remuxed file has no duration';
  const video = probe.streams.filter((s) => s.codecType === 'video').length;
  const audio = probe.streams.filter((s) => s.codecType === 'audio').length;
  if (video !== expect.video || audio !== expect.audio) {
    return `expected ${String(expect.video)} video + ${String(expect.audio)} audio streams, found ${String(video)} + ${String(audio)}`;
  }
  return null;
}

async function readSync(
  file: string,
  recovering: boolean,
): Promise<{ ok: true; value: SyncCheckpoints | null } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { ok: true, value: null };
  }
  try {
    return { ok: true, value: SyncCheckpointsSchema.parse(JSON.parse(text)) };
  } catch (error) {
    if (recovering) return { ok: true, value: null };
    return { ok: false, error: `unreadable ${path.basename(file)}: ${String(error)}` };
  }
}

async function finalizeOne(
  options: FinalizeOptions,
  spec: FinalizeStreamSpec,
): Promise<FinalizedStream> {
  const result = await remuxAndCheck(options, spec);
  // A failed check must not leave a half-trusted output next to the kept .rec file.
  if (!result.ok && !result.recDeleted) {
    const rec = path.join(options.dir, recordingFileName(spec.kind));
    if (await exists(rec)) await fs.rm(result.path, { force: true });
  }
  return result;
}

async function remuxAndCheck(
  options: FinalizeOptions,
  spec: FinalizeStreamSpec,
): Promise<FinalizedStream> {
  const rec = path.join(options.dir, recordingFileName(spec.kind));
  const out = path.join(options.dir, finalFileName(spec.kind));
  const result: FinalizedStream = {
    kind: spec.kind,
    path: out,
    ok: false,
    error: null,
    durationUs: null,
    sizeBytes: 0,
    video: null,
    audio: null,
    sync: null,
    recDeleted: false,
  };

  const hasRec = await exists(rec);
  if (hasRec) {
    const remux = await runFfmpeg({
      ffmpegPath: options.ffmpegPath,
      args: [
        '-i',
        rec,
        '-map',
        '0',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        '-y',
        out,
      ],
      removeOnFailure: [out],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!remux.ok) {
      result.error =
        remux.error.kind === 'failed'
          ? `remux failed: ${remux.error.stderrTail.trim().split('\n').slice(-3).join(' ')}`
          : `remux ${remux.error.kind}`;
      return result;
    }
  } else if (!(await exists(out))) {
    // Neither file: the stream never produced data.
    result.error = `${path.basename(rec)} is missing`;
    return result;
  }
  // Without a .rec file, a previous run already remuxed (and possibly crashed before the delete).

  const probe = await probeMedia(
    options.ffprobePath,
    out,
    options.signal ? { signal: options.signal } : {},
  );
  if (!probe.ok) {
    result.error = probe.error.message;
    return result;
  }
  const invalid = validate(probe.value, spec.expect);
  if (invalid) {
    result.error = invalid;
    return result;
  }
  result.durationUs = probe.value.durationUs;
  result.sizeBytes = await fileSize(out);
  const video = probe.value.streams.find((s) => s.codecType === 'video');
  if (video?.width && video.height) {
    result.video = {
      codec: video.codecName,
      width: video.width,
      height: video.height,
      frameRate: video.frameRate ?? null,
    };
  }
  const audio = probe.value.streams.find((s) => s.codecType === 'audio');
  if (audio?.sampleRate && audio.channels) {
    result.audio = {
      codec: audio.codecName,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
    };
  }

  const sync = await readSync(
    path.join(options.dir, syncFileName(spec.kind)),
    options.recovering ?? false,
  );
  if (!sync.ok) {
    result.error = sync.error;
    return result;
  }
  result.sync = sync.value;

  if (hasRec) await fs.rm(rec, { force: true });
  result.recDeleted = true;
  result.ok = true;
  return result;
}

export async function finalizeRecording(options: FinalizeOptions): Promise<FinalizedStream[]> {
  const results: FinalizedStream[] = [];
  for (const [index, spec] of options.streams.entries()) {
    if (options.signal?.aborted) break;
    results.push(await finalizeOne(options, spec));
    options.onProgress?.((index + 1) / options.streams.length);
  }
  return results;
}
