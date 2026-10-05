import { Box, Typography } from "@mui/material";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { describeStopReason } from "../../state/stopReasons";
import { describeBreakpoint } from "../../state/targets";

/**
 * The run state as the last tick reported it, next to the run controls: running, or why the
 * target is stopped and which stop it is; below it, the notice of the server when it has one
 * (a fallback engine or forced DSP timing is in use).
 */
export const ExecutionStatus = () => {
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

  // To the right of the run controls and out of the flow, so that they stay where they are.
  return (
    <Box
      sx={{
        position: "absolute",
        left: "100%",
        top: "50%",
        transform: "translateY(-50%)",
        ml: 1.5,
        display: "flex",
        flexDirection: "column",
        width: "max-content",
        // what is left between the run controls in the middle and the buttons on the right
        maxWidth: "max(0px, min(460px, calc(50vw - 400px)))",
        overflow: "hidden",
      }}
    >
      <Typography variant="caption" noWrap role="status" aria-label="Execution state" sx={{ lineHeight: 1.3 }}>
        {parts.join(" · ")}
      </Typography>
      {notice.length > 0 && (
        <Typography
          variant="caption"
          noWrap
          role="status"
          aria-label="Notice from the server"
          title={notice.join("\n")}
          color="warning.main"
          sx={{ lineHeight: 1.3, display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}
        >
          <WarningAmberIcon sx={{ fontSize: 14, flexShrink: 0 }} />
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {notice.join(" · ")}
          </Box>
        </Typography>
      )}
    </Box>
  );
};
