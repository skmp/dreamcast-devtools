import { IconButton, type IconButtonProps } from "@mui/material";

/**
 * An icon button of the run controls: Run, Pause, the step buttons.
 *
 * These cannot be used for a moment with every step (the target runs), and for as long as
 * the connection is away. A button with the `disabled` attribute cannot have the focus, so
 * the browser takes it away: somebody stepping with the keyboard would find the focus on the
 * page body after the first step, and after every reconnect. A button here that cannot be
 * used says so (aria-disabled), looks it and does nothing, and stays where the focus is.
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
