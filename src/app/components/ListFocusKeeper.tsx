import { useLayoutEffect, type MutableRefObject } from "react";

const FOCUSABLE = "button, input, [tabindex]";

interface ListFocusKeeperProps {
  /** the list this one keeps the focus of: what its controls' `data-focus-key` values start with (and a ":") */
  scope: string;
  /** the control that had the focus when the rows went; owned by the panel, which outlives the rows */
  lost: MutableRefObject<string | undefined>;
}

/**
 * Keeps the keyboard focus in the rows of a list that is the server's (breakpoints, watches).
 * The rows go when the connection does, and a control in one of them that had the focus takes
 * it along: it would be on the page body when the same rows are back a second later.
 *
 * It is rendered in front of the rows for as long as the list is that of a connection, and
 * goes with them. On the way out it notes which control had the focus (it is unmounted before
 * the rows are taken out of the document); on the way in it gives the focus back to the control
 * of that name, if nothing else has taken it since. A control is named by `data-focus-key`, on
 * itself or on an element around it, with what it is of — not with where it is in the list.
 */
export const ListFocusKeeper = ({ scope, lost }: ListFocusKeeperProps) => {
  useLayoutEffect(() => {
    const key = lost.current;
    lost.current = undefined;
    // the rows come with the first tick of the connection, a moment after this: the control is
    // looked for during the next frames, for as long as the focus is nowhere
    let frame = 0;
    let framesLeft = 60;
    const restore = () => {
      if (key === undefined || document.activeElement !== document.body) {
        return;
      }
      const named = Array.from(document.querySelectorAll<HTMLElement>("[data-focus-key]")).find(
        (element) => element.dataset.focusKey === key,
      );
      const control = named?.matches(FOCUSABLE) ? named : named?.querySelector<HTMLElement>(FOCUSABLE);
      if (control) {
        control.focus();
      } else if (framesLeft-- > 0) {
        frame = requestAnimationFrame(restore);
      }
    };
    restore();
    return () => {
      cancelAnimationFrame(frame);
      const focused = document.activeElement?.closest<HTMLElement>("[data-focus-key]")?.dataset.focusKey;
      lost.current = focused?.startsWith(`${scope}:`) ? focused : undefined;
    };
  }, [scope, lost]);
  return null;
};
