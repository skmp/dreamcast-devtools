import { useCallback } from "react";
import { Stack } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import { HideOnHoverTooltip as Tooltip } from "../components";
import { RunControlButton } from "../components/RunControlButton";
import { useSessionStore } from "../../state/sessionStore";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { canResume } from "../../state/stopReasons";

/**
 * The run controls of a workspace page, in its toolbar.
 *
 * The server answers a control request as soon as it is armed; the ticks report what then
 * happens. A refusal (no game loaded, stopped in the emulator's window, ...) is shown by the
 * store.
 */
export const RunControls = () => {
  const connected = useSessionStore((state) => state.connectionState === "connected");
  const execution = useDebuggerDataStore((state) => state.executionState);
  const control = useDebuggerDataStore((state) => state.control);

  const handleRun = useCallback(() => void control("run"), [control]);
  const handlePause = useCallback(() => void control("pause", "sh4"), [control]);

  const runState = connected ? execution?.state : undefined;
  const resumable = runState === "paused" && canResume(execution?.reason);

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      {/* The tooltip is on the button itself: its title is the button's name. (A button
          that cannot be used is not `disabled`, so it needs no element around it to
          carry the tooltip.) */}
      <Tooltip title="Run">
        <RunControlButton size="small" color="success" disabled={!resumable} onClick={handleRun}>
          <PlayArrowIcon />
        </RunControlButton>
      </Tooltip>
      <Tooltip title="Pause">
        <RunControlButton size="small" color="warning" disabled={runState !== "running"} onClick={handlePause}>
          <PauseIcon />
        </RunControlButton>
      </Tooltip>
      <Tooltip title="Run to next breakpoint">
        <RunControlButton size="small" color="primary" disabled={!resumable} onClick={handleRun}>
          <SkipNextIcon />
        </RunControlButton>
      </Tooltip>
    </Stack>
  );
};
