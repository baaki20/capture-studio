/**
 * Decoded-frame cache of the preview (§4.3.8): per media, frames sorted by timestamp, kept from
 * about 0.5 s behind to 1.5 s ahead of the playhead, with a memory cap (512 MB) over all media
 * enforced least-recently-used first.
 *
 * Ownership: a frame belongs to the cache from `put` on; the cache closes it **exactly once**,
 * when it is evicted, trimmed, replaced by a duplicate or cleared. Callers may use a frame
 * returned by `frameAt` only synchronously (upload it to a texture) and never close it.
 *
 * Recordings are variable-frame-rate: a static screen may have one frame for several seconds, so
 * the frame shown at time t is the **latest frame with timestamp ≤ t**, however old. Trimming
 * therefore keeps the latest frame at or before the window start.
 */

/** The parts of `VideoFrame` the cache uses (fakes in tests). */
export interface CacheableFrame {
  /** Microseconds, file-local. */
  readonly timestamp: number;
  allocationSize(): number;
  close(): void;
}

export const FRAME_CACHE_MAX_BYTES = 512 * 1024 * 1024;
export const FRAME_CACHE_AHEAD_US = 1_500_000;
export const FRAME_CACHE_BEHIND_US = 500_000;

export interface FrameCacheOptions {
  maxBytes?: number;
  aheadUs?: number;
  behindUs?: number;
}

interface Entry<F> {
  frame: F;
  bytes: number;
  lastUsed: number;
}

export interface FrameCacheStats {
  frames: number;
  bytes: number;
  inserted: number;
  closed: number;
}

export class FrameCache<F extends CacheableFrame = VideoFrame> {
  private readonly media = new Map<string, Entry<F>[]>();
  private bytes = 0;
  private tick = 0;
  private inserted = 0;
  private closed = 0;
  readonly maxBytes: number;
  readonly aheadUs: number;
  readonly behindUs: number;

  constructor(options: FrameCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? FRAME_CACHE_MAX_BYTES;
    this.aheadUs = options.aheadUs ?? FRAME_CACHE_AHEAD_US;
    this.behindUs = options.behindUs ?? FRAME_CACHE_BEHIND_US;
  }

  get stats(): FrameCacheStats {
    let frames = 0;
    for (const list of this.media.values()) frames += list.length;
    return { frames, bytes: this.bytes, inserted: this.inserted, closed: this.closed };
  }

  /** Timestamps cached for a media, ascending (for bookkeeping and tests). */
  timestamps(mediaId: string): number[] {
    return (this.media.get(mediaId) ?? []).map((e) => e.frame.timestamp);
  }

  /**
   * Takes ownership of a decoded frame. A frame with a timestamp already cached is closed
   * (returns false). May evict least-recently-used frames to stay under the memory cap.
   */
  put(mediaId: string, frame: F): boolean {
    this.inserted += 1;
    let list = this.media.get(mediaId);
    if (!list) {
      list = [];
      this.media.set(mediaId, list);
    }
    const index = this.lowerBound(list, frame.timestamp);
    if (list[index]?.frame.timestamp === frame.timestamp) {
      this.closeFrame(frame);
      return false;
    }
    const bytes = Math.max(0, frame.allocationSize());
    list.splice(index, 0, { frame, bytes, lastUsed: ++this.tick });
    this.bytes += bytes;
    this.enforceBudget();
    return true;
  }

  /** The latest cached frame with timestamp ≤ `tUs`, or null; marks it recently used. */
  frameAt(mediaId: string, tUs: number): F | null {
    const list = this.media.get(mediaId);
    if (!list) return null;
    const index = this.upperBound(list, tUs) - 1;
    const entry = list[index];
    if (!entry) return null;
    entry.lastUsed = ++this.tick;
    return entry.frame;
  }

  /** The cached frame closest to `tUs` on either side (a stand-in while decoding). */
  nearest(mediaId: string, tUs: number): F | null {
    const list = this.media.get(mediaId);
    if (!list || list.length === 0) return null;
    const index = this.upperBound(list, tUs);
    const before = list[index - 1];
    const after = list[index];
    const pick =
      before && after
        ? tUs - before.frame.timestamp <= after.frame.timestamp - tUs
          ? before
          : after
        : (before ?? after);
    if (!pick) return null;
    pick.lastUsed = ++this.tick;
    return pick.frame;
  }

  /**
   * Keeps the frames of a media in `[centerUs − behind, centerUs + ahead]`, plus the latest frame
   * at or before the window start (it is what shows at the window start on a VFR file). Closes
   * the rest.
   */
  retainWindow(mediaId: string, centerUs: number): void {
    const list = this.media.get(mediaId);
    if (!list || list.length === 0) return;
    const lo = centerUs - this.behindUs;
    const hi = centerUs + this.aheadUs;
    const anchor = this.upperBound(list, lo) - 1; // latest ≤ lo
    const keep: Entry<F>[] = [];
    list.forEach((entry, i) => {
      const t = entry.frame.timestamp;
      if (i === anchor || (t >= lo && t <= hi)) keep.push(entry);
      else this.drop(entry);
    });
    this.media.set(mediaId, keep);
  }

  /** Closes every frame of a media with a timestamp in `[fromUs, toUs]`. */
  dropRange(mediaId: string, fromUs: number, toUs: number): void {
    const list = this.media.get(mediaId);
    if (!list) return;
    this.media.set(
      mediaId,
      list.filter((entry) => {
        const t = entry.frame.timestamp;
        if (t < fromUs || t > toUs) return true;
        this.drop(entry);
        return false;
      }),
    );
  }

  clearMedia(mediaId: string): void {
    const list = this.media.get(mediaId);
    if (!list) return;
    for (const entry of list) this.drop(entry);
    this.media.delete(mediaId);
  }

  clear(): void {
    for (const id of [...this.media.keys()]) this.clearMedia(id);
  }

  private enforceBudget(): void {
    while (this.bytes > this.maxBytes) {
      let oldestList: Entry<F>[] | null = null;
      let oldestIndex = -1;
      let oldestUsed = Infinity;
      for (const list of this.media.values()) {
        for (let index = 0; index < list.length; index++) {
          const used = list[index]?.lastUsed ?? Infinity;
          if (used < oldestUsed) {
            oldestList = list;
            oldestIndex = index;
            oldestUsed = used;
          }
        }
      }
      const [entry] = oldestList?.splice(oldestIndex, 1) ?? [];
      if (!entry) return;
      this.drop(entry);
    }
  }

  private drop(entry: Entry<F>): void {
    this.bytes -= entry.bytes;
    this.closeFrame(entry.frame);
  }

  private closeFrame(frame: F): void {
    this.closed += 1;
    try {
      frame.close();
    } catch {
      // Already closed by the platform (decoder reset); nothing to free.
    }
  }

  /** First index whose timestamp ≥ t. */
  private lowerBound(list: readonly Entry<F>[], t: number): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid]?.frame.timestamp ?? Infinity) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index whose timestamp > t. */
  private upperBound(list: readonly Entry<F>[], t: number): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid]?.frame.timestamp ?? Infinity) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
