import { useEffect, useRef } from "react";
import { hotkeyControl, type RunControlId } from "../../state/runControls";

/** A code editor, with everything it puts into the document for itself. */
const MONACO = ".monaco-editor";

/**
 * Whether a key press is somebody else's. Monaco has uses of its own for the function keys,
 * and what is typed into an editor is the editor's. A dialog that is open is in front of the
 * page: what is behind it is not operated while it is up (the browser's own meaning of the
 * key, F5 to reload, is the one that is left).
 *
 * A dialog is open when it is on screen. One that is kept in the document while it is closed
 * is hidden, and not open. A widget of a code editor is no dialog of the page, whatever role
 * it gives itself: Monaco's Find box is a `dialog` that stays in its editor from the first
 * Ctrl+F on, moved out of sight when it is closed, and in front of nothing but that editor
 * when it is open. What is typed into it is the editor's by the first rule.
 */
const belongsElsewhere = (event: KeyboardEvent): boolean => {
  const target = event.target;
  if (target instanceof Element && target.closest(MONACO) !== null) {
    return true;
  }
  return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some(
    (dialog) => dialog.closest(MONACO) === null && dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== "hidden",
  );
};

/**
 * The function keys of a workspace page: F5 run, F6 pause, F10 step over, F11 step into,
 * Shift+F11 step out (F8 and Shift+F8 for the last two). `press` is called for the control of
 * a key; whether the control can be used is the caller's to say, as it is for its button.
 *
 * They work wherever the focus is: on the page, in a panel, in an address box, in the editor
 * of a value. Not "outside an input": F5 in an address box would reload the page, and the box
 * is where the focus is after every `Go`. The two exceptions are Monaco and an open dialog.
 *
 * The browser's meaning of the key is put away for every press that is taken, the repeats of
 * a key that is held down included: a held F5 must not reload the page. The control is used
 * once per press all the same: a key that is held down is not repeated.
 */
export const useRunHotkeys = (press: (control: RunControlId) => void): void => {
  const latest = useRef(press);
  useEffect(() => {
    latest.current = press;
  }, [press]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const control = hotkeyControl(event);
      if (control === undefined || belongsElsewhere(event)) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        latest.current(control);
      }
    };
    // On the way down, so that no control in between can keep a key from getting here. The
    // controls of the page have other keys (Enter, the space bar, F2, the arrows).
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
};
