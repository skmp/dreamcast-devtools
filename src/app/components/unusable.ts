/**
 * How a button looks that cannot be used for a while and is not `disabled` (it says so with
 * aria-disabled and does nothing): a `disabled` button cannot have the keyboard focus, and one
 * that is put out of use while it has it would leave the focus on the page body.
 */
export const UNUSABLE_SX = { opacity: 0.5, cursor: "default" } as const;
