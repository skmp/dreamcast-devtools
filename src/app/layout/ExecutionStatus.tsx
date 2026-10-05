import { Box, Typography } from "@mui/material";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { describeStopReason } from "../../state/stopReasons";
import { describeBreakpoint } from "../../state/targets";

/**
 * From this width on the toolbar has room for the status between the run controls in its
 * middle and the buttons on its right: 240 px, which the longest state lines fill in two or
 * three lines. A narrower window shows the status in a line of its own under the toolbar.
 */
const ROOM_BESIDE = "@media (min-width: 1280px)";

interface ExecutionStatusProps {
  /**
   * Where this one is: "beside" the run controls, or "below" the toolbar. The layout renders
   * both, and the width of the window decides which of them is shown.
   */
  placement: "beside" | "below";
}

/**
 * The run state as the last tick reported it, next to the run controls: running, or why the
 * target is stopped and which stop it is; below it, the notice of the server when it has one
 * (a fallback engine or forced DSP timing is in use).
 */
export const ExecutionStatus = ({ placement }: ExecutionStatusProps) => {
  const execution = useDebuggerDataStore((state) => state.executionState);
  const breakpoints = useDebuggerDataStore((state) => state.breakpoints);
  const shape = useDebuggerDataStore((state) => state.shape);

  if (!execution) {
    return null;
  }

  const parts: string[] = [execution.state === "paused" ? "Paused" : "Running"];
  if (execution.state === "paused") {
    if (execution.reason !== undefined) {
      const breakpoint =
        execution.breakpointId !== undefined ? breakpoints.find((candidate) => candidate.id === execution.breakpointId) : undefined;
      const reason = describeStopReason(execution.reason);
      parts.push(breakpoint ? `${reason} ${describeBreakpoint(shape, breakpoint)}` : reason);
    }
    if (execution.stopId !== undefined) {
      parts.push(`stop ${execution.stopId}`);
    }
  }
  const notice = execution.notice?.split("\n").filter((line) => line.length > 0) ?? [];

  const state = parts.join(" · ");
  const beside = placement === "beside";

  return (
    <Box
      sx={
        beside
          ? {
              // To the right of the run controls and out of the flow, so that they stay where they are.
              display: "none",
              [ROOM_BESIDE]: { display: "flex" },
              position: "absolute",
              left: "100%",
              top: "50%",
              transform: "translateY(-50%)",
              ml: 1.5,
              flexDirection: "column",
              width: "max-content",
              // what is left between the run controls in the middle and the buttons on the right
              maxWidth: "min(460px, calc(50vw - 400px))",
              // and no more than the toolbar is high: what does not fit is in the title
              maxHeight: 64,
              overflow: "hidden",
            }
          : {
              display: "flex",
              [ROOM_BESIDE]: { display: "none" },
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
              px: 2,
              pb: 0.75,
            }
      }
    >
      {/* It wraps: the reason of a stop names the breakpoint, and is longer than the room beside
          the controls of a window that is not wide. The title has all of it in any case. */}
      <Typography
        variant="caption"
        role="status"
        aria-label="Execution state"
        title={state}
        sx={{ lineHeight: 1.3, overflowWrap: "anywhere" }}
      >
        {state}
      </Typography>
      {notice.length > 0 && (
        <Typography
          variant="caption"
          noWrap={beside}
          role="status"
          aria-label="Notice from the server"
          title={notice.join("\n")}
          color="warning.main"
          sx={{ lineHeight: 1.3, display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}
        >
          <WarningAmberIcon sx={{ fontSize: 14, flexShrink: 0 }} />
          <Box component="span" sx={beside ? { overflow: "hidden", textOverflow: "ellipsis" } : { overflowWrap: "anywhere" }}>
            {notice.join(" · ")}
          </Box>
        </Typography>
      )}
    </Box>
  );
};
