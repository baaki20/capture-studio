/**
 * App actions (R1.2–R1.4). The same names are used by `capture-studio --action <name>`, the tray
 * menu and the recorder UI; main dispatches them on its action bus.
 */
import { z } from 'zod';

/** Recording actions accepted on the command line (R1.2), in the order Diagnostics lists them. */
export const CLI_ACTIONS = [
  'new-recording',
  'toggle-recording',
  'stop-recording',
  'toggle-pause',
  'pause-recording',
  'resume-recording',
  'abort-recording',
] as const;

export type CliAction = (typeof CLI_ACTIONS)[number];

/** Short spellings accepted on the command line as well. */
export const CLI_ACTION_ALIASES: Readonly<Record<string, CliAction>> = {
  start: 'new-recording',
  record: 'new-recording',
  toggle: 'toggle-recording',
  stop: 'stop-recording',
  pause: 'pause-recording',
  resume: 'resume-recording',
  abort: 'abort-recording',
};

export const CliActionSchema = z.enum(CLI_ACTIONS);

/** Actions that only the app itself raises (tray, windows), never the command line. */
export const APP_ACTIONS = ['open-library', 'quit', 'restart-recording'] as const;
export type AppOnlyAction = (typeof APP_ACTIONS)[number];

export type AppActionType = CliAction | AppOnlyAction;
export type ActionSource = 'cli' | 'tray' | 'ui' | 'hotkey';

export interface AppAction {
  type: AppActionType;
  source: ActionSource;
}

/** Human labels for Diagnostics and menus. */
export const CLI_ACTION_LABELS: Readonly<Record<CliAction, string>> = {
  'new-recording': 'New recording',
  'toggle-recording': 'Start or stop recording',
  'stop-recording': 'Stop recording',
  'toggle-pause': 'Pause or resume',
  'pause-recording': 'Pause',
  'resume-recording': 'Resume',
  'abort-recording': 'Abort recording',
};

/** Data passed from a second instance through `requestSingleInstanceLock(additionalData)`. */
export const SecondInstanceDataSchema = z.object({
  action: CliActionSchema.nullable(),
});
export type SecondInstanceData = z.infer<typeof SecondInstanceDataSchema>;
