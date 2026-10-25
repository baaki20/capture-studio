/**
 * ffprobe wrapper (§4.3.5 step 2) and the FFmpeg version probe (§1.10) used to pick
 * version-dependent flags.
 */
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function run(
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<Result<string, { message: string; stderr: string }>> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) resolve(err({ message: error.message, stderr }));
        else resolve(ok(stdout));
      },
    );
  });
}

/** Seconds as a decimal string → integer µs (null for absent or "N/A"). */
function secondsToUs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : null;
}

/** "30000/1001" → 29.97; null for "0/0" or malformed. */
function parseRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (num === undefined || !Number.isFinite(num)) return null;
  if (den === undefined) return num;
  return den > 0 && Number.isFinite(den) ? num / den : null;
}

const RawStreamSchema = z.looseObject({
  index: z.int(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.int().optional(),
  height: z.int().optional(),
  sample_rate: z.string().optional(),
  channels: z.int().optional(),
  duration: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  color_space: z.string().optional(),
  color_range: z.string().optional(),
});

const RawProbeSchema = z.looseObject({
  streams: z.array(RawStreamSchema).default([]),
  format: z
    .looseObject({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      nb_streams: z.int().optional(),
    })
    .optional(),
});

export interface ProbeStream {
  index: number;
  codecType: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown';
  codecName: string | null;
  durationUs: number | null;
  width?: number;
  height?: number;
  frameRate?: number | null;
  /** Video: ffprobe `color_space` and `color_range` (e.g. `smpte170m`, `tv`), null if untagged. */
  colorSpace?: string | null;
  colorRange?: string | null;
  sampleRate?: number;
  channels?: number;
}

export interface ProbeResult {
  formatName: string | null;
  durationUs: number | null;
  streams: ProbeStream[];
}

const CODEC_TYPES = new Set(['video', 'audio', 'subtitle', 'data', 'attachment']);

export async function probeMedia(
  ffprobePath: string,
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<Result<ProbeResult>> {
  const output = await run(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', filePath],
    options.signal,
  );
  if (!output.ok) {
    return err(new Error(`ffprobe failed: ${output.error.stderr.trim() || output.error.message}`));
  }

  let parsed: z.infer<typeof RawProbeSchema>;
  try {
    parsed = RawProbeSchema.parse(JSON.parse(output.value));
  } catch (error) {
    return err(new Error(`ffprobe returned unexpected output: ${String(error)}`));
  }

  return ok({
    formatName: parsed.format?.format_name ?? null,
    durationUs: secondsToUs(parsed.format?.duration),
    streams: parsed.streams.map((s): ProbeStream => {
      const codecType = (
        CODEC_TYPES.has(s.codec_type ?? '') ? s.codec_type : 'unknown'
      ) as ProbeStream['codecType'];
      const stream: ProbeStream = {
        index: s.index,
        codecType,
        codecName: s.codec_name ?? null,
        durationUs: secondsToUs(s.duration),
      };
      if (codecType === 'video') {
        if (s.width !== undefined) stream.width = s.width;
        if (s.height !== undefined) stream.height = s.height;
        stream.frameRate = parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate);
        stream.colorSpace = s.color_space && s.color_space !== 'unknown' ? s.color_space : null;
        stream.colorRange = s.color_range && s.color_range !== 'unknown' ? s.color_range : null;
      }
      if (codecType === 'audio') {
        const sampleRate = s.sample_rate ? Number.parseInt(s.sample_rate, 10) : NaN;
        if (Number.isFinite(sampleRate)) stream.sampleRate = sampleRate;
        if (s.channels !== undefined) stream.channels = s.channels;
      }
      return stream;
    }),
  });
}

export interface FfmpegVersion {
  /** The version token, e.g. `n9.0.2-35-g9a9b70bb8c-20261023` or `N-127957-g935f29eaae`. */
  version: string;
  /** Release major/minor parsed from the token; null for git master builds. */
  release: { major: number; minor: number } | null;
  /** The first line of `-version`. */
  banner: string;
}

export function parseFfmpegVersion(firstLine: string): FfmpegVersion | null {
  const m = /^ff(?:mpeg|probe) version (\S+)/.exec(firstLine.trim());
  if (!m?.[1]) return null;
  const version = m[1];
  const rel = /^n?(\d+)\.(\d+)/.exec(version);
  return {
    version,
    release: rel ? { major: Number(rel[1]), minor: Number(rel[2]) } : null,
    banner: firstLine.trim(),
  };
}

export async function probeFfmpegVersion(binaryPath: string): Promise<Result<FfmpegVersion>> {
  const output = await run(binaryPath, ['-hide_banner', '-version']);
  if (!output.ok) return err(new Error(`${binaryPath} -version failed: ${output.error.message}`));
  const parsed = parseFfmpegVersion(output.value.split('\n')[0] ?? '');
  return parsed ? ok(parsed) : err(new Error(`unrecognised version output from ${binaryPath}`));
}
