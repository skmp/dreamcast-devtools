import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * The keys that open the editor of a value that has the keyboard focus: Enter and the space
 * bar, as for every button, and F2. (With the pointer it is a double click.)
 */
export const opensEditor = (key: string): boolean => key === "Enter" || key === " " || key === "F2";

/** What the box of an editor reports of the keyboard focus (`useFocusReturn`). */
export interface BoxFocus {
  /** the focus is in the box */
  onFocus(): void;
  /** the focus has left the box by itself: Tab, a click somewhere else, another window */
  onBlur(): void;
}

/**
 * Gives the keyboard focus back to the value an editor was opened from, when the box of the
 * editor goes with the focus in it: the write was accepted, Escape was pressed, the target runs
 * again. The focus would be on the page body then, and somebody writing with the keyboard would
 * start from the top of the page after every write.
 *
 * A focus that left the box by itself is where the user put it, and is not taken from there:
 * also not when that is nowhere (a click on something that takes no focus), because a focus
 * that came back would name this panel, and its target, as the one last used.
 *
 * `shown`: the box of the editor is on screen. `opener`: what gets the focus, if it is there.
 * The result is for the box, which says where the focus is.
 */
export const useFocusReturn = (shown: boolean, opener: RefObject<HTMLElement | null>): BoxFocus => {
  const wasShown = useRef(shown);
  const inBox = useRef(false);
  useLayoutEffect(() => {
    const gone = wasShown.current && !shown;
    wasShown.current = shown;
    if (!gone) {
      return;
    }
    // A box that is taken out of the document with the focus in it has not said that the
    // focus left it, and the focus is on the body now.
    const held = inBox.current;
    inBox.current = false;
    if (held && (document.activeElement === null || document.activeElement === document.body)) {
      // without scrolling: the value is where the box was
      opener.current?.focus({ preventScroll: true });
    }
  }, [shown, opener]);
  return useMemo(
    () => ({
      onFocus: () => {
        inBox.current = true;
      },
      onBlur: () => {
        inBox.current = false;
      },
    }),
    [],
  );
};

/**
 * The state of an editor that writes to the target what is typed into it: the value of a
 * register, a run of bytes in memory. What it holds is the same for all of them:
 *
 * - The editor closes when the server has accepted the write, and not before: what the row
 *   then shows is the tick's (or the bytes that are read again), not what was typed.
 * - A write that is refused, or not answered, leaves the editor open with what was typed, and
 *   the editor says why (the notice of the store says it too).
 * - While a request is out nothing more is sent: a server under load answers late, and a
 *   second Enter in the meantime would write twice.
 * - An answer that arrives when its editor is gone (closed with Escape, or the target runs
 *   again) is no longer this editor's: it does not close the one that was opened since, and
 *   its refusal is not put into it.
 */
export interface WriteEditor {
  /** what is typed; undefined while the editor is closed */
  readonly text: string | undefined;
  /** why the last attempt was not accepted; undefined when there was none, and once the text is changed */
  readonly refusal: string | undefined;
  /** a request is out and has not been answered */
  readonly sending: boolean;
  open(text: string): void;
  change(text: string): void;
  close(): void;
  /** Sends what is typed, unless a request is out. */
  submit(): void;
}

/** `write`: sends the text; rejects with why when it was not accepted. */
export const useWriteEditor = (write: (text: string) => Promise<void>): WriteEditor => {
  const [text, setText] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  // What a callback that runs later than its render reads: the editor as it is then.
  const session = useRef(0);
  const out = useRef(false);
  const latest = useRef({ text, write });
  useLayoutEffect(() => {
    latest.current = { text, write };
  });

  const open = useCallback((initial: string) => {
    session.current++;
    out.current = false;
    setText(initial);
    setRefusal(undefined);
    setSending(false);
  }, []);

  const close = useCallback(() => {
    session.current++;
    out.current = false;
    setText(undefined);
    setRefusal(undefined);
    setSending(false);
  }, []);

  const change = useCallback((next: string) => {
    setText(next);
    setRefusal(undefined);
  }, []);

  const submit = useCallback(() => {
    const typed = latest.current.text;
    if (typed === undefined || out.current) {
      return;
    }
    const mine = session.current;
    out.current = true;
    setSending(true);
    setRefusal(undefined);
    latest.current.write(typed).then(
      () => {
        if (session.current === mine) {
          close();
        }
      },
      (error: unknown) => {
        if (session.current === mine) {
          out.current = false;
          setSending(false);
          setRefusal(error instanceof Error && error.message ? error.message : String(error));
        }
      },
    );
  }, [close]);

  return useMemo(() => ({ text, refusal, sending, open, change, close, submit }), [text, refusal, sending, open, change, close, submit]);
};
