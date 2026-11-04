/**
 * Screen beautify settings (v2, R2.11): the default the editor and automation start from, and how
 * a partial change merges into the current setting. `setBeautify` stores the result (clamped);
 * `scene.ts` lays the screen out with it and the compositor draws the background.
 */
import type { Beautify, Shadow } from './schema';

/** The screen's shadow when the background is styled. */
export const DEFAULT_SCREEN_SHADOW: Shadow = {
  blur: 0.03,
  offsetX: 0,
  offsetY: 0.012,
  color: '#00000066',
};

export const DEFAULT_BEAUTIFY: Beautify = {
  background: { type: 'gradient', from: '#4F46E5', to: '#DB2777', angleDeg: 135 },
  padding: 0.06,
  cornerRadius: 0.02,
  shadow: DEFAULT_SCREEN_SHADOW,
};

/** Fields a change sets; `shadow: null` removes the shadow. */
export type BeautifyChange = Partial<Omit<Beautify, 'shadow'>> & { shadow?: Shadow | null };

/** `change` applied to the current setting, or to `DEFAULT_BEAUTIFY` when there is none. */
export function mergeBeautify(current: Beautify | undefined, change: BeautifyChange): Beautify {
  const { shadow, ...rest } = change;
  const next: Beautify = { ...(current ?? DEFAULT_BEAUTIFY), ...rest };
  if (shadow === null) delete next.shadow;
  else if (shadow !== undefined) next.shadow = shadow;
  return next;
}
