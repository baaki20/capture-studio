/**
 * Keyboard handling of the source picker (R1.53), kept pure for tests: arrow keys move the
 * highlight through the grid (clamped, no wrap), Home/End jump to the ends, Enter records the
 * highlighted source and Escape cancels.
 */

export type PickerKeyResult =
  | { kind: 'move'; index: number }
  | { kind: 'choose'; index: number }
  | { kind: 'cancel' }
  | { kind: 'none' };

export function pickerKey(
  key: string,
  index: number,
  count: number,
  columns: number,
): PickerKeyResult {
  if (key === 'Escape') return { kind: 'cancel' };
  if (count === 0) return { kind: 'none' };
  const current = Math.min(Math.max(index, 0), count - 1);
  const cols = Math.max(1, Math.floor(columns));
  const clamp = (i: number): number => Math.min(Math.max(i, 0), count - 1);
  switch (key) {
    case 'Enter':
      return { kind: 'choose', index: current };
    case 'ArrowRight':
      return { kind: 'move', index: clamp(current + 1) };
    case 'ArrowLeft':
      return { kind: 'move', index: clamp(current - 1) };
    case 'ArrowDown':
      return { kind: 'move', index: current + cols < count ? current + cols : current };
    case 'ArrowUp':
      return { kind: 'move', index: current - cols >= 0 ? current - cols : current };
    case 'Home':
      return { kind: 'move', index: 0 };
    case 'End':
      return { kind: 'move', index: count - 1 };
    default:
      return { kind: 'none' };
  }
}

/** Index of `id` in `sources`, or 0 when it is absent. */
export function initialIndex(sources: readonly { id: string }[], id: string | null): number {
  const i = sources.findIndex((s) => s.id === id);
  return i === -1 ? 0 : i;
}

/** Grid columns for `count` sources: one row up to 3, then two or three per row. */
export function gridColumns(count: number): number {
  if (count <= 3) return Math.max(1, count);
  return count === 4 ? 2 : 3;
}
