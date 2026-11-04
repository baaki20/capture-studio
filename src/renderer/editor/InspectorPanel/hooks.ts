/** Hooks the inspector's panels share. */
import type { TimelineOp } from '../../../shared/project/timeline-ops';
import { errorText } from '../commands';
import { useEditor } from '../EditorContext';

/** Applies an operation and reports a refusal in the status line. */
export function useApply(): (op: TimelineOp | null) => void {
  const { docStore, ui } = useEditor();
  return (op) => {
    if (!op) return;
    const result = docStore.getState().apply(op);
    ui.getState().setStatus(result.ok ? null : errorText(result.error));
  };
}

/** Pointer handlers that make a slider drag one undo step (R1.43). */
export function useGesture() {
  const { docStore } = useEditor();
  return {
    onPointerDown: () => docStore.getState().beginGesture(),
    onPointerUp: () => docStore.getState().endGesture(),
    onPointerCancel: () => docStore.getState().endGesture(),
  };
}
