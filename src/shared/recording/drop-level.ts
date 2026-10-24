/**
 * The dropped-frame indicator colours (R1.12): amber above 1 %, red above 5 %. Used by the
 * engine's dropped-frame accounting and by the recorder UI.
 */
export type DropLevel = 'ok' | 'amber' | 'red';

export const DROP_AMBER_RATIO = 0.01;
export const DROP_RED_RATIO = 0.05;

export function dropLevelFor(droppedRatio: number): DropLevel {
  if (droppedRatio > DROP_RED_RATIO) return 'red';
  if (droppedRatio > DROP_AMBER_RATIO) return 'amber';
  return 'ok';
}

/** The worse of several levels (screen and camera share one indicator). */
export function worstDropLevel(levels: readonly DropLevel[]): DropLevel {
  if (levels.includes('red')) return 'red';
  if (levels.includes('amber')) return 'amber';
  return 'ok';
}
