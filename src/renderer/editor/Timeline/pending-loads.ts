/**
 * Loads waiting for main (R1.44): each is retried after a delay, and all of them at once when
 * main announces that the project's caches are ready. Kept free of DOM types so it is testable
 * from the Node test project.
 */
export class PendingLoads {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** The latest retry per key; an older timer for the same key does nothing. */
  private readonly pending = new Map<string, () => void>();
  private disposed = false;

  constructor(private readonly delayMs: number) {}

  /** Runs `fn` after the delay, or earlier on `retryNow`. */
  retry(key: string, fn: () => void): void {
    if (this.disposed) return;
    this.pending.set(key, fn);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed || this.pending.get(key) !== fn) return;
      this.pending.delete(key);
      fn();
    }, this.delayMs);
    this.timers.add(timer);
  }

  /** Runs every waiting load now. */
  retryNow(): void {
    if (this.disposed) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const fn of due) fn();
  }

  get size(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
  }
}
