/**
 * The shared screen, remembered for the app run (P3 step 8, spike S8, R3.19). On Wayland the
 * ScreenCast portal asks on every `desktopCapturer.getSources` call, but opening the same source
 * id again in this process needs no dialog (WebRTC keeps the portal's restore token in memory).
 * So the first recording asks, and later ones reuse the source:
 *
 * - kept in memory only: an id from an earlier launch opens but delivers no frames (S8);
 * - for one capture kind: switching between monitor and window recording asks again;
 * - forgotten when the engine reports it stale (no first frame in time), when the shared screen
 *   ends during a recording (the user stopped sharing in the shell), and on "Choose the screen
 *   again" in Diagnostics.
 */
import type { Logger } from '../shared/logger';
import type { ScreenSource } from './recording/session-manager';

export type ScreenKind = 'screen' | 'window';
export type ForgetReason = 'stale' | 'ended' | 'user';

export class ScreenSourceMemory {
  private kept: { kind: ScreenKind; source: ScreenSource } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly logger: Logger) {}

  /** The remembered source for `kind`, marked as reused; null when there is none. */
  get(kind: ScreenKind): ScreenSource | null {
    if (this.kept?.kind !== kind) return null;
    return { ...this.kept.source, reused: true };
  }

  remember(kind: ScreenKind, source: ScreenSource): void {
    const { reused: _reused, ...plain } = source;
    this.kept = { kind, source: plain };
    this.changed();
  }

  forget(reason: ForgetReason): void {
    if (!this.kept) return;
    this.logger.info(`recording: forgot the shared ${this.kept.kind} (${reason})`);
    this.kept = null;
    this.changed();
  }

  /** What Diagnostics shows: the remembered kind and label, or null. */
  get current(): { kind: ScreenKind; label: string | null } | null {
    return this.kept ? { kind: this.kept.kind, label: this.kept.source.label ?? null } : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * `selectScreen` with the memory in front: a remembered source of the same kind is returned as
 * is; otherwise the portal asks, and its answer is remembered. A kind switch forgets the other.
 */
export async function selectWithMemory(
  memory: ScreenSourceMemory,
  kind: ScreenKind,
  select: (kind: ScreenKind) => Promise<ScreenSource | null>,
): Promise<ScreenSource | null> {
  const kept = memory.get(kind);
  if (kept) return kept;
  const source = await select(kind);
  if (source) memory.remember(kind, source);
  return source;
}
