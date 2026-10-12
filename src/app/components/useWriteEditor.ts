import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

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
