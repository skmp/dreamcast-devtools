import { useCallback, useMemo, type ReactNode } from "react";
import { Divider, Stack, Typography, type IconButtonProps } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { HideOnHoverTooltip as Tooltip } from "../components";
import { RunControlButton } from "../components/RunControlButton";
import { CAPABILITIES } from "../../lib/debuggerSchema";
import { useSessionStore } from "../../state/sessionStore";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { useCapability, useTarget } from "../../state/debuggerSelectors";
import { useFocusedTarget } from "../../state/focusedTarget";
import {
  arm7Held,
  runControlsOff,
  RUN_CONTROL_ARIA_KEYS,
  RUN_CONTROL_KEYS,
  RUN_CONTROL_NAMES,
  type RunControlId,
} from "../../state/runControls";
import { useRunHotkeys } from "./useRunHotkeys";

interface ControlButtonProps {
  id: RunControlId;
  /** why the control cannot be used; undefined when it can */
  off: string | undefined;
  color?: IconButtonProps["color"];
  onPress: (id: RunControlId) => void;
  children: ReactNode;
}

/**
 * One button of the toolbar. Its name is what it does ("Step Over"), whatever state it is in:
 * that is what it is found and announced by. Its tooltip, which is also its description, adds
 * the key, or why the button is off ("Step Over: the ARM7 is held in reset").
 */
const ControlButton = ({ id, off, color, onPress, children }: ControlButtonProps) => {
  const name = RUN_CONTROL_NAMES[id];
  const key = RUN_CONTROL_KEYS[id];
  const title = off !== undefined ? `${name}: ${off}` : key !== undefined ? `${name} (${key})` : name;
  return (
    <Tooltip title={title} describeChild={title !== name}>
      <RunControlButton
        size="small"
        color={color}
        aria-label={name}
        aria-keyshortcuts={RUN_CONTROL_ARIA_KEYS[id]}
        disabled={off !== undefined}
        onClick={() => onPress(id)}
      >
        {children}
      </RunControlButton>
    </Tooltip>
  );
};

interface RunControlsProps {
  /** the workspace page the controls are on: its own target is the focused one at first */
  workspaceId: string;
}

/**
 * The run controls of a workspace page, in its toolbar: Run and Pause, the three steps of the
 * focused target with the name of that target in front of them, and Reset. The function keys
 * do what the buttons do (`useRunHotkeys`), and nothing a button would not: a control that is
 * off sends nothing, by button or by key.
 *
 * The server answers a control request as soon as it is armed; the ticks report what then
 * happens. A refusal is shown by the store.
 */
export const RunControls = ({ workspaceId }: RunControlsProps) => {
  const connected = useSessionStore((state) => state.connectionState === "connected");
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const execution = useDebuggerDataStore((state) => state.executionState);
  const control = useDebuggerDataStore((state) => state.control);
  const canReset = useCapability(CAPABILITIES.RESET);
  const target = useTarget(useFocusedTarget(workspaceId));
  const held = useDebuggerDataStore((state) => target.id === "arm7" && arm7Held(state.registersByPath, target));

  const off = useMemo(
    () => runControlsOff({ connected, initialized, execution, target, held, canReset }),
    [connected, initialized, execution, target, held, canReset],
  );

  const press = useCallback(
    (id: RunControlId) => {
      if (off[id] !== undefined) {
        return;
      }
      // Run and Reset are the machine's, and name no target. Pause is the machine's too (there
      // is one run state, and a server ignores the target of a pause): it names the focused
      // target when the server lists it, and none otherwise, so that nothing is asked of a
      // server about a target it does not have. The steps are off for such a target.
      const named = id === "run" || id === "reset" || (id === "pause" && !target.supported) ? undefined : target.id;
      void control(id, named);
    },
    [off, control, target.id, target.supported],
  );
  useRunHotkeys(press);

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" role="group" aria-label="Run controls" sx={{ flexShrink: 0 }}>
      <ControlButton id="run" off={off.run} color="success" onPress={press}>
        <PlayArrowIcon />
      </ControlButton>
      <ControlButton id="pause" off={off.pause} color="warning" onPress={press}>
        <PauseIcon />
      </ControlButton>
      {/* which target the three buttons behind it step: the toolbar is one, the targets are three */}
      <Typography
        variant="caption"
        role="status"
        aria-label="Focused target"
        title={`The step buttons and the keys F10, F11 and Shift+F11 act on the ${target.label}: the target of the panel that last had the focus.`}
        sx={{
          px: 0.75,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          fontWeight: 600,
          lineHeight: 1.6,
          whiteSpace: "nowrap",
          userSelect: "none",
        }}
      >
        {target.label}
      </Typography>
      <ControlButton id="step" off={off.step} color="primary" onPress={press}>
        <ArrowDownwardRoundedIcon />
      </ControlButton>
      <ControlButton id="stepOver" off={off.stepOver} color="primary" onPress={press}>
        <SubdirectoryArrowRightIcon />
      </ControlButton>
      <ControlButton id="stepOut" off={off.stepOut} color="primary" onPress={press}>
        <ArrowUpwardRoundedIcon />
      </ControlButton>
      <Divider orientation="vertical" flexItem />
      {/* no question is asked: a reset is one click, like the button on the console */}
      <ControlButton id="reset" off={off.reset} color="error" onPress={press}>
        <RestartAltIcon />
      </ControlButton>
    </Stack>
  );
};
