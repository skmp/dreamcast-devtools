import { IconButton, type IconButtonProps } from "@mui/material";

/**
 * An icon button that cannot be used from time to time, and is used again right after: Run,
 * Pause and the step buttons, and Refresh and "Go to current PC" of the views.
 *
 * The run controls cannot be used for a moment with every step (the target runs), Refresh
 * while its view reads, which every use of it starts, and none of them for as long as the
 * connection is away. A button with the `disabled` attribute cannot have the focus, so the
 * browser takes it away: somebody stepping or refreshing with the keyboard would find the
 * focus on the page body after the first press, and after every reconnect. A button here
 * that cannot be used says so (aria-disabled), looks it and does nothing, and stays where
 * the focus is.
 */
export const RunControlButton = ({ disabled = false, color, onClick, sx, ...props }: IconButtonProps) => (
  <IconButton
    {...props}
    color={disabled ? "default" : color}
    aria-disabled={disabled || undefined}
    disableTouchRipple={disabled}
    onClick={disabled ? undefined : onClick}
    sx={[
      disabled && {
        color: "action.disabled",
        cursor: "default",
        "&:hover": { backgroundColor: "transparent" },
      },
      ...(Array.isArray(sx) ? sx : [sx]),
    ]}
  />
);
