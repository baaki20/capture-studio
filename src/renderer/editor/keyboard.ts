/**
 * The editor's keyboard map (R1.34–R1.44). `commandForKey` turns a key event into an editor
 * command; `commands.ts` runs it. Keys typed into text fields, sliders and selects are left to
 * them (`isTextEntryTarget`).
 *
 * | Keys                       | Command                       |
 * |----------------------------|-------------------------------|
 * | Space                      | play / pause                  |
 * | J, K, L                    | shuttle −2×, pause, +2×       |
 * | ←, →                       | previous / next frame         |
 * | Home, End                  | start / end of the timeline   |
 * | S                          | split                         |
 * | Delete, Backspace          | delete (leave a gap)          |
 * | Shift+Delete               | ripple delete                 |
 * | I, O                       | mark in / out                 |
 * | Ctrl+Shift+X               | cut range [In, Out)           |
 * | Alt+X                      | clear marks                   |
 * | N                          | snapping on / off             |
 * | Ctrl+Z                     | undo                          |
 * | Ctrl+Shift+Z, Ctrl+Y       | redo                          |
 * | Shift+Z                    | zoom to fit                   |
 * | Ctrl+=, Ctrl+-             | zoom in / out                 |
 * | Esc                        | clear the selection           |
 *
 * Cmd works like Ctrl (macOS, Phase 3).
 */
export type EditorCommand =
  | 'play-toggle'
  | 'shuttle-reverse'
  | 'shuttle-pause'
  | 'shuttle-forward'
  | 'frame-back'
  | 'frame-forward'
  | 'go-start'
  | 'go-end'
  | 'split'
  | 'delete'
  | 'ripple-delete'
  | 'mark-in'
  | 'mark-out'
  | 'cut-range'
  | 'clear-marks'
  | 'toggle-snap'
  | 'undo'
  | 'redo'
  | 'zoom-fit'
  | 'zoom-in'
  | 'zoom-out'
  | 'deselect';

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function commandForKey(event: KeyInput): EditorCommand | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const ctrl = event.ctrlKey || event.metaKey;
  const { shiftKey: shift, altKey: alt } = event;
  const plain = !ctrl && !shift && !alt;

  if (ctrl && !alt) {
    if (key === 'z') return shift ? 'redo' : 'undo';
    if (key === 'y' && !shift) return 'redo';
    if (key === 'x' && shift) return 'cut-range';
    if (key === '=' || key === '+') return 'zoom-in';
    if (key === '-' || key === '_') return 'zoom-out';
    return null;
  }
  if (alt && !ctrl && !shift && key === 'x') return 'clear-marks';
  if (shift && !ctrl && !alt) {
    if (key === 'z') return 'zoom-fit';
    if (key === 'Delete' || key === 'Backspace') return 'ripple-delete';
    return null;
  }
  if (!plain) return null;
  switch (key) {
    case ' ':
      return 'play-toggle';
    case 'j':
      return 'shuttle-reverse';
    case 'k':
      return 'shuttle-pause';
    case 'l':
      return 'shuttle-forward';
    case 'ArrowLeft':
      return 'frame-back';
    case 'ArrowRight':
      return 'frame-forward';
    case 'Home':
      return 'go-start';
    case 'End':
      return 'go-end';
    case 's':
      return 'split';
    case 'Delete':
    case 'Backspace':
      return 'delete';
    case 'i':
      return 'mark-in';
    case 'o':
      return 'mark-out';
    case 'n':
      return 'toggle-snap';
    case 'Escape':
      return 'deselect';
    default:
      return null;
  }
}

/** Elements whose own keyboard handling wins (text, numbers, sliders, selects, editable). */
export function isTextEntryTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el.type ?? 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
}
