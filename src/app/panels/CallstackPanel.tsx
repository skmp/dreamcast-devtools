import { memo, useCallback, useMemo } from "react";
import { Panel } from "../layout/Panel";
import { Box, List, ListItem, ListItemText, Stack, Typography } from "@mui/material";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { CAPABILITIES, type CallstackFrame } from "../../lib/debuggerSchema";
import { disassemblyNavigationService } from "../../state/disassemblyNavigationService";
import { useCapability, useRunState, useTarget } from "../../state/debuggerSelectors";
import { formatAddress, type TargetInfo } from "../../state/targets";
import { NoData, PanelNotice } from "../components/PanelNotice";

interface CallstackPanelProps {
  target: "sh4" | "arm7";
  showTitle?: boolean;
}

interface CallstackFrameItemProps {
  frame: CallstackFrame;
  target: TargetInfo;
  onNavigate: (address: number) => void;
}

/**
 * How the unwinder found a frame (`location` of a v3 server): frame 0 is the program counter
 * and has none, "pr" / "lr" is the link register, "stack+0x.." a value found on the stack.
 */
const locationTitle = (location: string): string | undefined => {
  if (location === "pr" || location === "lr") {
    return `The link register (${location.toUpperCase()}). In a function that has made a call it points into that function, not to its caller.`;
  }
  if (location.startsWith("stack+")) {
    return "A value on the stack that looks like a return address: the instruction before it is a call.";
  }
  return undefined;
};

const CallstackFrameItem = memo(({ frame, target, onNavigate }: CallstackFrameItemProps) => {
  const addressHex = formatAddress(target, frame.pc);

  const handleClick = useCallback(() => {
    onNavigate(frame.pc);
  }, [frame.pc, onNavigate]);

  return (
    <ListItem disablePadding sx={{ py: 0 }}>
      <ListItemText
        sx={{ my: 0 }}
        primary={
          <Stack direction="row" spacing={1} alignItems="baseline" sx={{ flexWrap: "wrap" }}>
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 28 }}>
              #{frame.index}
            </Typography>
            <Typography
              variant="body2"
              onClick={handleClick}
              sx={{
                fontFamily: "monospace",
                cursor: "pointer",
                "&:hover": {
                  textDecoration: "underline",
                  color: "primary.main",
                },
              }}
            >
              {addressHex}
            </Typography>
            {frame.symbol && (
              <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                {frame.symbol}
              </Typography>
            )}
            {frame.location && (
              <Typography variant="body2" color="text.secondary" title={locationTitle(frame.location)} sx={{ fontFamily: "monospace" }}>
                {frame.location}
              </Typography>
            )}
          </Stack>
        }
      />
    </ListItem>
  );
});

CallstackFrameItem.displayName = "CallstackFrameItem";

const EMPTY_FRAMES: never[] = [];

const CallstackPanel = ({ target, showTitle = false }: CallstackPanelProps) => {
  const initialized = useDebuggerDataStore((s) => s.initialized);
  const callstacks = useDebuggerDataStore((s) => s.callstacks);
  const frames = useMemo(() => callstacks[target] ?? EMPTY_FRAMES, [callstacks, target]);
  const info = useTarget(target);
  const supported = useCapability(CAPABILITIES.CALLSTACK);
  const running = useRunState() === "running";

  const title = target === "sh4" ? "SH4: Callstack" : "ARM7: Callstack";

  const handleNavigate = useCallback((address: number) => {
    disassemblyNavigationService.navigateToAddress(target, address);
  }, [target]);

  return (
    <Panel title={showTitle ? title : undefined}>
      {!info.supported || !supported ? (
        // what the server cannot do is said for as long as it is the server of this page, connected or not
        <PanelNotice>
          {info.supported ? "This server has no callstack." : `This server does not support the ${info.label} target.`}
        </PanelNotice>
      ) : !initialized ? (
        <NoData />
      ) : frames.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          Empty callstack.{running ? " The target is running." : ""}
        </Typography>
      ) : (
        <Box sx={{ p: 1 }}>
          <List dense disablePadding>
            {frames.map((f) => (
              <CallstackFrameItem key={f.index} frame={f} target={info} onNavigate={handleNavigate} />
            ))}
          </List>
          {/* the frames are found by rules of thumb, not by unwind information: say so */}
          <Typography variant="caption" color="text.secondary" role="note" sx={{ display: "block", mt: 1, px: 0.5 }}>
            Heuristic unwind. #0 is the program counter and #1 the link register ({target === "sh4" ? "PR" : "LR"}), which is
            not always the caller; the frames after it are return addresses found on the stack and can be stale.
          </Typography>
        </Box>
      )}
    </Panel>
  );
};

export default CallstackPanel;


