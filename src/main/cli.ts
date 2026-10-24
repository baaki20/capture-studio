/**
 * Command-line handling (R1.2, R1.4): `capture-studio --action <name>` parsing, and the exact
 * command line Diagnostics shows for a GNOME custom shortcut.
 */
import { CLI_ACTION_ALIASES, CLI_ACTIONS, type CliAction } from '../shared/ipc/actions';

export interface ParsedCli {
  action: CliAction | null;
  /** Set when `--action` was present but unusable; the action is then null. */
  error: string | null;
}

const ACTION_FLAG = '--action';

export function normalizeCliAction(value: string): CliAction | null {
  const name = value.trim().toLowerCase();
  if ((CLI_ACTIONS as readonly string[]).includes(name)) return name as CliAction;
  return CLI_ACTION_ALIASES[name] ?? null;
}

/**
 * Finds `--action <name>` or `--action=<name>` anywhere in `argv` (Electron and Chromium add
 * their own arguments around ours). The last occurrence wins.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCli {
  let raw: string | null = null;
  let missingValue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === ACTION_FLAG) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        missingValue = true;
        raw = null;
      } else {
        raw = next;
        missingValue = false;
        i += 1;
      }
    } else if (arg.startsWith(`${ACTION_FLAG}=`)) {
      raw = arg.slice(ACTION_FLAG.length + 1);
      missingValue = raw === '';
    }
  }

  if (missingValue) return { action: null, error: '--action needs a value' };
  if (raw === null) return { action: null, error: null };
  const action = normalizeCliAction(raw);
  if (!action) {
    return {
      action: null,
      error: `unknown action "${raw}" (expected one of: ${CLI_ACTIONS.join(', ')})`,
    };
  }
  return { action, error: null };
}

export interface LaunchCommandContext {
  isPackaged: boolean;
  /** `process.execPath`. */
  execPath: string;
  /** `app.getAppPath()`; needed in development, where Electron runs the project folder. */
  appPath: string;
  /** `process.env.APPIMAGE` when running from an AppImage. */
  appImage?: string | undefined;
}

/** POSIX shell quoting, only when needed. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The program part of the shortcut command: the AppImage, the installed binary, or dev Electron. */
export function launchCommandPrefix(context: LaunchCommandContext): string[] {
  if (context.appImage) return [context.appImage];
  if (context.isPackaged) return [context.execPath];
  return [context.execPath, context.appPath];
}

/** The command to bind in GNOME Settings → Keyboard → Custom Shortcuts (R1.4). */
export function buildActionCommand(action: CliAction, context: LaunchCommandContext): string {
  return [...launchCommandPrefix(context), ACTION_FLAG, action].map(shellQuote).join(' ');
}
