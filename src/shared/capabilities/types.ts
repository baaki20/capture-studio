/**
 * Platform capabilities (§1.4). Main detects them at startup and on request, and sends the
 * `CapabilityReport` to renderers. Features ask for a key and implement the stated fallback when
 * the state is not `available`.
 */
import { z } from 'zod';
import { CAPABILITY_KEYS, type CapabilityKey } from './keys';

export { CAPABILITY_KEYS, type CapabilityKey } from './keys';

export const CapabilityStateSchema = z.enum(['available', 'degraded', 'unavailable']);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

export const CapabilitySchema = z.object({
  state: CapabilityStateSchema,
  /** How the feature is (or would be) provided, e.g. `pw-record`, `portal`, `libx264`. */
  strategy: z.string().nullable(),
  /** Human-readable explanation; for anything but `available` it names the fallback. */
  reason: z.string(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilityMapSchema = z.record(z.enum(CAPABILITY_KEYS), CapabilitySchema);
export type CapabilityMap = Record<CapabilityKey, Capability>;

/** Result of one FFmpeg encoder probe (`encoder-probe.ts`). */
export const FfmpegEncoderProbeSchema = z.object({
  name: z.string(),
  kind: z.enum(['software', 'vaapi', 'nvenc', 'qsv', 'amf', 'videotoolbox']),
  /** Listed by `ffmpeg -encoders`. */
  listed: z.boolean(),
  /** A short test encode succeeded. */
  works: z.boolean(),
  error: z.string().nullable(),
});
export type FfmpegEncoderProbe = z.infer<typeof FfmpegEncoderProbeSchema>;

export const FfmpegEncoderReportSchema = z.object({
  probedAt: z.string(),
  encoders: z.array(FfmpegEncoderProbeSchema),
  /** The verified hardware H.264 encoder to use for export, or null for libx264 only. */
  hardware: z.string().nullable(),
  /** Always libx264 when the bundled build is intact. */
  software: z.string().nullable(),
});
export type FfmpegEncoderReport = z.infer<typeof FfmpegEncoderReportSchema>;

export const CapabilityReportSchema = z.object({
  generatedAt: z.string(),
  platform: z.string(),
  session: z.object({
    /** `XDG_SESSION_TYPE`, or null off Linux. */
    type: z.string().nullable(),
    desktop: z.string().nullable(),
    /** Electron's ozone platform (`wayland` or `x11`) on Linux. */
    ozonePlatform: z.string().nullable(),
  }),
  capabilities: CapabilityMapSchema,
});
export type CapabilityReport = z.infer<typeof CapabilityReportSchema> & {
  capabilities: CapabilityMap;
};

export function unavailable(reason: string, strategy: string | null = null): Capability {
  return { state: 'unavailable', strategy, reason };
}

export function available(strategy: string, reason = ''): Capability {
  return { state: 'available', strategy, reason };
}

export function degraded(strategy: string, reason: string): Capability {
  return { state: 'degraded', strategy, reason };
}
