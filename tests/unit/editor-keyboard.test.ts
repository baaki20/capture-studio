/**
 * Keyboard map and editor commands (steps 16–17; R1.34–R1.39, R1.43, R1.44) against the real
 * document and UI stores with a fake transport.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCommand, type CommandContext } from '../../src/renderer/editor/commands';
import {
  commandForKey,
  isTextEntryTarget,
  type KeyInput,
} from '../../src/renderer/editor/keyboard';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import { createUiStore } from '../../src/renderer/editor/ui-store';
import { clipEndUs, timelineDurationUs } from '../../src/shared/project/timeline-ops';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;

const key = (k: string, mods: Partial<Omit<KeyInput, 'key'>> = {}): KeyInput => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('keyboard map', () => {
  it('maps the spec shortcuts', () => {
    const cases: [KeyInput, string | null][] = [
      [key(' '), 'play-toggle'],
      [key('j'), 'shuttle-reverse'],
      [key('k'), 'shuttle-pause'],
      [key('L'), 'shuttle-forward'],
      [key('ArrowLeft'), 'frame-back'],
      [key('ArrowRight'), 'frame-forward'],
      [key('Home'), 'go-start'],
      [key('End'), 'go-end'],
      [key('s'), 'split'],
      [key('Delete'), 'delete'],
      [key('Backspace'), 'delete'],
      [key('Delete', { shiftKey: true }), 'ripple-delete'],
      [key('i'), 'mark-in'],
      [key('o'), 'mark-out'],
      [key('X', { ctrlKey: true, shiftKey: true }), 'cut-range'],
      [key('x', { altKey: true }), 'clear-marks'],
      [key('n'), 'toggle-snap'],
      [key('z', { ctrlKey: true }), 'undo'],
      [key('Z', { ctrlKey: true, shiftKey: true }), 'redo'],
      [key('y', { ctrlKey: true }), 'redo'],
      [key('z', { metaKey: true }), 'undo'],
      [key('Z', { shiftKey: true }), 'zoom-fit'],
      [key('=', { ctrlKey: true }), 'zoom-in'],
      [key('-', { ctrlKey: true }), 'zoom-out'],
      [key('Escape'), 'deselect'],
      // Not editor shortcuts.
      [key('s', { ctrlKey: true }), null],
      [key('x', { ctrlKey: true }), null],
      [key('a'), null],
      [key('s', { altKey: true }), null],
    ];
    for (const [input, command] of cases)
      expect(commandForKey(input), JSON.stringify(input)).toBe(command);
  });

  it('leaves typing in fields alone', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'input' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'INPUT', type: 'range' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

function setup() {
  const docStore = createDocumentStore({ opOptions: { generateId: counterIds('K') } });
  docStore.getState().load({ doc: recordedProject(), revision: 0, mediaUrls: {}, readOnly: false });
  const ui = createUiStore();
  const transport = {
    toggle: vi.fn(),
    shuttle: vi.fn(),
    step: vi.fn(),
    home: vi.fn(),
    end: vi.fn(),
  };
  const ctx: CommandContext = { docStore, ui, transport, timelineWidth: () => 1000 };
  const doc = () => docStore.getState().doc!;
  return { docStore, ui, transport, ctx, doc };
}

describe('editor commands', () => {
  it('routes transport keys to the transport', () => {
    const { ctx, transport } = setup();
    runCommand('play-toggle', ctx);
    runCommand('shuttle-reverse', ctx);
    runCommand('shuttle-pause', ctx);
    runCommand('shuttle-forward', ctx);
    runCommand('frame-forward', ctx);
    runCommand('frame-back', ctx);
    runCommand('go-start', ctx);
    runCommand('go-end', ctx);
    expect(transport.toggle).toHaveBeenCalledOnce();
    expect(transport.shuttle.mock.calls).toEqual([[-1], [0], [1]]);
    expect(transport.step.mock.calls).toEqual([[1], [-1]]);
    expect(transport.home).toHaveBeenCalledOnce();
    expect(transport.end).toHaveBeenCalledOnce();
  });

  it('splits every clip under the playhead (nothing selected), or only the selection', () => {
    const { ctx, ui, doc } = setup();
    ui.getState().setPlayhead(10 * S);
    runCommand('split', ctx);
    expect(trackByName(doc(), 'Screen').clips).toHaveLength(3);
    expect(trackByName(doc(), 'Voice').clips).toHaveLength(3);
    const system = trackByName(doc(), 'System audio').clips[0]!;
    ui.getState().setPlayhead(5 * S);
    ui.getState().select([system.id]);
    runCommand('split', ctx);
    expect(trackByName(doc(), 'System audio').clips).toHaveLength(4);
    expect(trackByName(doc(), 'Screen').clips).toHaveLength(3);
    ui.getState().select([]);
    ui.getState().setPlayhead(timelineDurationUs(doc()) + S);
    runCommand('split', ctx);
    expect(ui.getState().status).toBe('Nothing to split at the playhead.');
  });

  it('deletes with a gap, ripple deletes, and undo/redo restore (one step each)', () => {
    const { ctx, ui, doc, docStore } = setup();
    const original = doc();
    const face = trackByName(doc(), 'Face').clips[0]!;
    runCommand('delete', ctx);
    expect(ui.getState().status).toBe('Select clips to delete.');
    ui.getState().select([face.id]);
    runCommand('delete', ctx);
    expect(trackByName(doc(), 'Face').clips).toHaveLength(1);
    expect(trackByName(doc(), 'Voice').clips).toHaveLength(1); // linked partner
    expect(ui.getState().selection).toEqual([]);
    runCommand('undo', ctx);
    expect(doc()).toEqual(original);
    runCommand('redo', ctx);
    expect(trackByName(doc(), 'Face').clips).toHaveLength(1);
    runCommand('undo', ctx);

    const screen = trackByName(doc(), 'Screen').clips[0]!;
    const removed = clipEndUs(screen) - screen.timelineStartUs;
    ui.getState().select([screen.id]);
    runCommand('ripple-delete', ctx);
    expect(timelineDurationUs(doc())).toBeLessThanOrEqual(
      timelineDurationUs(original) - removed + 100_000,
    );
    expect(docStore.getState().undoLabel).toBe('Ripple delete');
    runCommand('undo', ctx);
    expect(doc()).toEqual(original);
    runCommand('undo', ctx);
    expect(ui.getState().status).toBe('Nothing to undo.');
  });

  it('sets marks with I and O and cuts the range with sync preserved', () => {
    const { ctx, ui, doc } = setup();
    ui.getState().setPlayhead(5 * S);
    runCommand('mark-in', ctx);
    ui.getState().setPlayhead(8 * S);
    runCommand('mark-out', ctx);
    expect(doc().timeline.marks).toEqual({ inUs: 5 * S, outUs: 8 * S });
    ui.getState().setPlayhead(2 * S);
    runCommand('mark-out', ctx); // before In: In is dropped
    expect(doc().timeline.marks).toEqual({ inUs: null, outUs: 2 * S });
    runCommand('cut-range', ctx);
    expect(ui.getState().status).toMatch(/In and an Out/);
    ui.getState().setPlayhead(1 * S);
    runCommand('mark-in', ctx);
    const before = timelineDurationUs(doc());
    runCommand('cut-range', ctx);
    expect(timelineDurationUs(doc())).toBe(before - 1 * S);
    expect(ui.getState().playheadUs).toBe(1 * S);
    runCommand('clear-marks', ctx);
    expect(doc().timeline.marks).toEqual({ inUs: null, outUs: null });
  });

  it('toggles snapping, zooms, fits and deselects', () => {
    const { ctx, ui, doc } = setup();
    runCommand('toggle-snap', ctx);
    expect(ui.getState().snapping).toBe(false);
    runCommand('toggle-snap', ctx);
    expect(ui.getState().snapping).toBe(true);
    runCommand('zoom-fit', ctx);
    const fit = ui.getState().view;
    expect((timelineDurationUs(doc()) / S) * fit.pxPerSec).toBeLessThanOrEqual(1000);
    runCommand('zoom-in', ctx);
    expect(ui.getState().view.pxPerSec).toBeCloseTo(fit.pxPerSec * 1.5, 6);
    runCommand('zoom-out', ctx);
    expect(ui.getState().view.pxPerSec).toBeCloseTo(fit.pxPerSec, 6);
    ui.getState().select(['clp_x']);
    ui.getState().setOverlaySelected(true);
    runCommand('deselect', ctx);
    expect(ui.getState()).toMatchObject({ selection: [], overlaySelected: false });
  });

  it('reports a locked track instead of editing it', () => {
    const { ctx, ui, doc, docStore } = setup();
    const screen = trackByName(doc(), 'Screen');
    docStore.getState().apply({ type: 'setLocked', trackId: screen.id, locked: true });
    ui.getState().select([screen.clips[0]!.id]);
    runCommand('delete', ctx);
    expect(ui.getState().status).toBe('That clip is on a locked track.');
  });
});
