import { useEffect, useRef } from "react";
import { hotkeyControl, type RunControlId } from "../../state/runControls";

/** A code editor, with everything it puts into the document for itself. */
const MONACO = ".monaco-editor";

/** What a dialog of the page is, by its role. */
const DIALOG = '[role="dialog"], [role="alertdialog"]';

/**
 * How long a dialog counts as closed behind the Escape that went to it while it is still on
 * screen as it was (see `escapedDialogs`). Longer than a page takes to render the close and
 * start the fade, which then says it by itself (`closing`); short enough that a key pressed
 * after it, in front of a dialog that Escape did not close, is left to the browser.
 */
const ESCAPE_CLOSES_WITHIN_MS = 500;

/**
 * Whether a dialog is on its way out: its exit transition is taking it, or what is around it,
 * to transparent. It stays in the document, on screen, until the transition is over (a dialog
 * of the page fades out in 195 ms), and it is closed all the same: it was closed by a click
 * on its button or beside it, or by Escape. The transition sets the opacity it goes to, 0, on
 * the element it fades, at its start. (Not the opacity on screen, which is somewhere between
 * meanwhile, and is 0 as well at the start of the transition that brings a dialog in.)
 */
const closing = (dialog: Element): boolean => {
  for (let node: Element | null = dialog; node !== null && node !== document.body; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.opacity === "0") {
      return true;
    }
  }
  return false;
};

/** Whether a dialog of the page is open: on screen (also with `aria-hidden`), and not fading out. */
const open = (dialog: Element): boolean =>
  dialog.closest(MONACO) === null && dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== "hidden" && !closing(dialog);

/**
 * The dialogs that an Escape went to, with the time of the key. A dialog closes on Escape, but
 * the page may render that close a little later than the next key: the About dialog is closed
 * by a change of the page's address, which is rendered as a transition, behind the keys that
 * arrive meanwhile. Until then it is on screen as it was, with nothing that says it is closing.
 * So a dialog counts as closed from the Escape that went to it: for as long as it is in the
 * document, and while it is still on screen as it was, for `ESCAPE_CLOSES_WITHIN_MS`.
 *
 * The Escape goes to the dialog that has the focus in it (a dialog of the page keeps the focus
 * inside while it is open), or to the dialog in the box that has it; not to a dialog when the
 * focus is somewhere else, in a menu in front of it, for instance. The dialog's own handler
 * stops the key on its way up, so it is seen here on its way down, before anything else.
 */
const escapedDialogs = (event: KeyboardEvent, escaped: WeakMap<Element, number>): void => {
  // (a key that composes text is the input method's)
  if (event.key !== "Escape" || event.isComposing) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element) || target === document.body || target === document.documentElement) {
    return;
  }
  for (const dialog of Array.from(document.querySelectorAll(DIALOG))) {
    if (open(dialog) && (dialog.contains(target) || target.contains(dialog))) {
      escaped.set(dialog, performance.now());
    }
  }
};

/**
 * Whether a key press is somebody else's. Monaco has uses of its own for the function keys,
 * and what is typed into an editor is the editor's. A dialog that is open is in front of the
 * page: what is behind it is not operated while it is up (the browser's own meaning of the
 * key, F5 to reload, is the one that is left).
 *
 * A dialog is open when it is on screen. One that is kept in the document while it is closed
 * is hidden, and not open; one that is fading out after it was closed (`closing`) is not open
 * either, and one that an Escape went to a moment ago is closed from that Escape on
 * (`escapedDialogs`): F5 right behind Escape is the toolbar's. A widget of a code editor is no
 * dialog of the page, whatever role it gives itself: Monaco's Find box is a `dialog` that stays
 * in its editor from the first Ctrl+F on, moved out of sight when it is closed, and in front of
 * nothing but that editor when it is open. What is typed into it is the editor's by the first
 * rule.
 */
const belongsElsewhere = (event: KeyboardEvent, escaped: WeakMap<Element, number>): boolean => {
  const target = event.target;
  if (target instanceof Element && target.closest(MONACO) !== null) {
    return true;
  }
  return Array.from(document.querySelectorAll(DIALOG)).some((dialog) => {
    const escapedAt = escaped.get(dialog);
    return open(dialog) && !(escapedAt !== undefined && performance.now() - escapedAt <= ESCAPE_CLOSES_WITHIN_MS);
  });
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
    // (held by the dialog: one that has left the document is let go with it)
    const escaped = new WeakMap<Element, number>();
    const handleKeyDown = (event: KeyboardEvent) => {
      escapedDialogs(event, escaped);
      const control = hotkeyControl(event);
      if (control === undefined || belongsElsewhere(event, escaped)) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        latest.current(control);
      }
    };
    // On the way down, so that no control in between can keep a key from getting here (a dialog
    // stops the Escape that closes it on its way up). The controls of the page have other keys
    // (Enter, the space bar, F2, the arrows).
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
};
