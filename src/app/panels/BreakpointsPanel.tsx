import { Panel } from "../layout/Panel";
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { isCategoryActive, type BreakpointCategory } from "../../state/breakpointCategoryState";
import { useCapability, useTarget } from "../../state/debuggerSelectors";
import { breakpointCategory, describeBreakpoint, parseAddress } from "../../state/targets";
import { NoData, PanelNotice } from "../components/PanelNotice";
import { UNUSABLE_SX } from "../components/unusable";
import { useCallback, useMemo, useState } from "react";
import { CAPABILITIES, type BreakpointDescriptor, type TargetProcessor } from "../../lib/debuggerSchema";

interface BreakpointsViewProps {
  /** "event": event breakpoints, and the list of every breakpoint by category; otherwise the code breakpoints of a target */
  mode: "event" | TargetProcessor;
}

const CategoryControls = ({
  onMuteToggle,
  onSoloToggle,
  muted,
  soloed,
}: {
  onMuteToggle: () => void;
  onSoloToggle: () => void;
  muted: boolean;
  soloed: boolean;
}) => {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Tooltip title={muted ? "Unmute category" : "Mute category"}>
        <IconButton size="small" onClick={onMuteToggle} color={muted ? "warning" : "default"}>
          {muted ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Tooltip title={soloed ? "Unsolo category" : "Solo category"}>
        <IconButton size="small" onClick={onSoloToggle} color={soloed ? "primary" : "default"}>
          {soloed ? <RadioButtonCheckedIcon fontSize="small" /> : <RadioButtonUncheckedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Stack>
  );
};

interface BreakpointRowProps {
  breakpoint: BreakpointDescriptor;
  /** the breakpoint as the list prints it */
  text: string;
  /** its category is muted, or another one is soloed */
  dimmed?: boolean;
  onRemove: (id: number) => Promise<void>;
  onToggle: (id: number, enabled: boolean) => Promise<void>;
}

const BreakpointRow = ({ breakpoint, text, dimmed = false, onRemove, onToggle }: BreakpointRowProps) => {
  return (
    <ListItem
      sx={dimmed ? { opacity: 0.4 } : undefined}
      secondaryAction={
        <Tooltip title="Remove breakpoint">
          <IconButton
            edge="end"
            size="small"
            onClick={() => {
              void onRemove(breakpoint.id);
            }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      }
    >
      <ListItemText
        primary={
          <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
            {text}
          </Typography>
        }
        secondary={
          <Typography variant="caption" color="text.secondary" sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <Chip label={breakpoint.kind} size="small" color="primary" variant="outlined" />
            <Switch
              size="small"
              checked={breakpoint.enabled}
              onChange={(e) => {
                void onToggle(breakpoint.id, e.target.checked);
              }}
            />
          </Typography>
        }
      />
    </ListItem>
  );
};

const BreakpointsView = ({ mode }: BreakpointsViewProps) => {
  const addMode = mode;
  const showCategoryControls = mode === "event";
  const breakpoints = useDebuggerDataStore((state) => state.breakpoints);
  const availableEvents = useDebuggerDataStore((state) => state.availableEvents);
  const shape = useDebuggerDataStore((state) => state.shape);
  const initialized = useDebuggerDataStore((state) => state.initialized);
  // mute and solo are the server's state: every tick carries them, whoever changed them
  const categoryStates = useDebuggerDataStore((state) => state.categories);
  const removeBreakpoint = useDebuggerDataStore((state) => state.removeBreakpoint);
  const addBreakpoint = useDebuggerDataStore((state) => state.addBreakpoint);
  const toggleBreakpoint = useDebuggerDataStore((state) => state.toggleBreakpoint);
  const toggleCategoryMute = useDebuggerDataStore((state) => state.toggleCategoryMute);
  const toggleCategorySolo = useDebuggerDataStore((state) => state.toggleCategorySolo);
  // address format and breakpoint event of the target, as debugger.describe said
  const target = useTarget(mode === "event" ? "sh4" : mode);
  const eventBreakpoints = useCapability(CAPABILITIES.EVENT_BREAKPOINTS);
  const [newBreakpoint, setNewBreakpoint] = useState("");

  // the panel of a target lists the code breakpoints of that target
  const filteredBreakpoints = useMemo(
    () => (mode === "event" ? breakpoints : breakpoints.filter((bp) => breakpointCategory(shape, bp) === mode)),
    [breakpoints, mode, shape],
  );
  const formatBreakpointDisplay = useCallback((bp: BreakpointDescriptor) => describeBreakpoint(shape, bp), [shape]);
  const categorizeBreakpoint = useCallback((bp: BreakpointDescriptor) => breakpointCategory(shape, bp), [shape]);

  // What the server cannot do is said, in place of the box that would ask for it. It is the
  // server's to say, so it stays said while the connection is away (a page that has not had a
  // server yet has every target, and the box).
  const unsupported =
    mode === "event"
      ? eventBreakpoints
        ? undefined
        : "This server has no event breakpoints."
      : !target.supported
        ? `This server does not support the ${target.label} target.`
        : !target.stepping
          ? `This server cannot set code breakpoints on the ${target.label}.`
          : undefined;

  const handleRemove = useCallback(
    async (id: number) => {
      await removeBreakpoint(id);
    },
    [removeBreakpoint],
  );

  const handleToggle = useCallback(
    async (id: number, enabled: boolean) => {
      await toggleBreakpoint(id, enabled);
    },
    [toggleBreakpoint],
  );

  const handleMuteToggle = useCallback(
    (category: BreakpointCategory) => {
      void toggleCategoryMute(category);
    },
    [toggleCategoryMute],
  );

  const handleSoloToggle = useCallback(
    (category: BreakpointCategory) => {
      void toggleCategorySolo(category);
    },
    [toggleCategorySolo],
  );

  const handleAdd = useCallback(async () => {
    const trimmed = newBreakpoint.trim();
    // Without a server there is nothing to add to. The box stays, with what is in it: it is
    // there to be sent when the connection is back.
    if (!trimmed || !initialized) {
      return;
    }

    let event: string;
    let address: number | undefined;
    let kind: BreakpointDescriptor["kind"];

    if (addMode === "event") {
      event = trimmed;
      address = undefined;
      kind = "event";
    } else {
      // In the radix of the target, as its disassembly view prints addresses (DSP steps are
      // decimal); hex after "0x" for every target
      const parsed = parseAddress(target, trimmed);
      if (parsed === undefined) {
        return;
      }
      event = target.breakpointEvent;
      address = parsed;
      kind = "code";
    }

    await addBreakpoint(event, address, kind);
    setNewBreakpoint("");
  }, [newBreakpoint, addBreakpoint, addMode, target, initialized]);

  const placeholder =
    addMode === "event"
      ? "Event name (e.g., dc.aica.channel[0].step)"
      : addMode === "dsp"
        ? "Step value (e.g., 0, 5, 0x10)"
        : `Address (e.g., 0x8C0000A0)`;

  // Group breakpoints by category for the all-categories view
  const categorizedBreakpoints: Partial<Record<BreakpointCategory, BreakpointDescriptor[]>> = showCategoryControls
    ? filteredBreakpoints.reduce(
        (acc, bp) => {
          const category = categorizeBreakpoint(bp);
          if (!acc[category]) {
            acc[category] = [];
          }
          acc[category].push(bp);
          return acc;
        },
        {} as Record<BreakpointCategory, BreakpointDescriptor[]>,
      )
    : {};

  const categoryLabels: Record<BreakpointCategory, string> = {
    events: "Events",
    sh4: "SH4",
    arm7: "ARM7",
    dsp: "DSP",
  };

  return (
    <Panel>
      {unsupported !== undefined ? (
        <Box sx={{ borderBottom: "1px solid", borderColor: "divider" }}>
          <PanelNotice>{unsupported}</PanelNotice>
        </Box>
      ) : (
      <Box sx={{ p: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
        <Stack direction="row" spacing={1}>
          {addMode === "event" ? (
            <Autocomplete
              size="small"
              fullWidth
              freeSolo
              options={availableEvents}
              value={newBreakpoint}
              onChange={(_, newValue) => setNewBreakpoint(newValue ?? "")}
              onInputChange={(_, newValue) => setNewBreakpoint(newValue)}
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder={placeholder}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAdd();
                    }
                  }}
                  sx={{ "& .MuiOutlinedInput-root": { fontSize: "0.875rem", fontFamily: "monospace" } }}
                />
              )}
            />
          ) : (
            <TextField
              size="small"
              fullWidth
              placeholder={placeholder}
              value={newBreakpoint}
              onChange={(e) => setNewBreakpoint(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleAdd();
                }
              }}
              sx={{ "& .MuiOutlinedInput-root": { fontSize: "0.875rem", fontFamily: "monospace" } }}
            />
          )}
          {/* without a connection it cannot be used, and is not `disabled`: that would take the keyboard focus away from it */}
          <Button
            size="small"
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => void handleAdd()}
            disabled={!newBreakpoint.trim()}
            aria-disabled={!initialized || undefined}
            sx={[!initialized && UNUSABLE_SX]}
          >
            Add
          </Button>
        </Stack>
      </Box>
      )}

      {!initialized ? (
        // the breakpoints are the server's: without a connection there is no list
        <NoData />
      ) : showCategoryControls ? (
        // Show grouped view with category controls
        <Box sx={{ overflowY: "auto", flex: 1 }}>
          {(["sh4", "arm7", "dsp", "events"] as BreakpointCategory[]).map((category) => {
            const categoryBps: BreakpointDescriptor[] = categorizedBreakpoints[category] || [];
            if (categoryBps.length === 0) return null;

            const state = categoryStates[category];
            const isActive = isCategoryActive(categoryStates, category);

            return (
              <Box key={category}>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    px: 1.5,
                    py: 1,
                    bgcolor: "action.hover",
                    borderBottom: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Typography variant="subtitle2" sx={{ fontWeight: 600, opacity: isActive ? 1 : 0.5 }}>
                    {categoryLabels[category]}
                  </Typography>
                  <CategoryControls
                    onMuteToggle={() => handleMuteToggle(category)}
                    onSoloToggle={() => handleSoloToggle(category)}
                    muted={state.muted}
                    soloed={state.soloed}
                  />
                </Box>
                <List dense disablePadding>
                  {categoryBps.map((bp: BreakpointDescriptor) => (
                    <BreakpointRow
                      key={bp.id}
                      breakpoint={bp}
                      text={formatBreakpointDisplay(bp)}
                      dimmed={!isActive}
                      onRemove={handleRemove}
                      onToggle={handleToggle}
                    />
                  ))}
                </List>
              </Box>
            );
          })}
          {filteredBreakpoints.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              No breakpoints defined.
            </Typography>
          )}
        </Box>
      ) : (
        // Regular single-category view
        <>
          {filteredBreakpoints.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              No breakpoints defined.
            </Typography>
          ) : (
            <List dense disablePadding sx={{ overflowY: "auto", flex: 1 }}>
              {filteredBreakpoints.map((bp) => (
                <BreakpointRow
                  key={bp.id}
                  breakpoint={bp}
                  text={formatBreakpointDisplay(bp)}
                  onRemove={handleRemove}
                  onToggle={handleToggle}
                />
              ))}
            </List>
          )}
        </>
      )}
    </Panel>
  );
};

export const EventsBreakpointsPanel = () => <BreakpointsView mode="event" />;

export const Sh4BreakpointsPanel = () => <BreakpointsView mode="sh4" />;

export const Arm7BreakpointsPanel = () => <BreakpointsView mode="arm7" />;

export const DspBreakpointsPanel = () => <BreakpointsView mode="dsp" />;
