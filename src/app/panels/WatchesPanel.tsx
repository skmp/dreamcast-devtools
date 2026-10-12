import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Panel } from "../layout/Panel";
import {
  Autocomplete,
  Box,
  Button,
  IconButton,
  List,
  ListItem,
  Stack,
  TextField,
  Typography,
  createFilterOptions,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { useCapability, useRunState } from "../../state/debuggerSelectors";
import { ListFocusKeeper } from "../components/ListFocusKeeper";
import { NoData } from "../components/PanelNotice";
import { UNUSABLE_SX } from "../components/unusable";
import { opensEditor, useFocusReturn, useWriteEditor } from "../components/useWriteEditor";
import { CAPABILITIES, type DeviceNodeDescriptor } from "../../lib/debuggerSchema";
import {
  EDIT_TITLES,
  controlName,
  editability,
  hasWriter,
  indexRegisters,
  isControl,
  watchedRegister,
  type Editability,
} from "./registerPanelModel";

// Component for individual watch item with inline editing
const WatchItem = ({ expression, value, mode, focusKey, onRemove, onEdit, onModifyExpression }: {
  expression: string;
  value: unknown;
  /** names the Remove button of this watch for the keyboard focus (see ListFocusKeeper) */
  focusKey: string;
  /**
   * Whether the value is an editor now, and why not: the server has no register writes, the
   * register of the watch has no writer (or the watch names no described register), or the
   * target runs.
   */
  mode: Editability;
  onRemove: () => void;
  onEdit: (newValue: string) => Promise<void>;
  onModifyExpression: (newExpression: string) => Promise<void>;
}) => {
  const [isEditingExpression, setIsEditingExpression] = useState(false);
  const [editExpression, setEditExpression] = useState("");
  const [hasExpressionError, setHasExpressionError] = useState(false);
  // The editor of the value: open until the server has accepted the write, and one request at
  // a time. Like every editor of a register it is offered while the register can be written;
  // one that is open when the target runs again is put away.
  const valueEditor = useWriteEditor(onEdit);
  const writable = mode === "editable";
  const isEditingValue = valueEditor.text !== undefined && writable;
  const { text: valueDraft, close: closeValueEditor } = valueEditor;
  useEffect(() => {
    if (valueDraft !== undefined && !writable) {
      closeValueEditor();
    }
  }, [valueDraft, writable, closeValueEditor]);
  // The value of a watch on a register this server writes is a control, as in a register
  // panel: the keyboard focus can be on it, Enter, the space bar and F2 open its editor, and it
  // has the focus again when the editor goes.
  const valueElement = useRef<HTMLSpanElement | null>(null);
  const valueBoxFocus = useFocusReturn(isEditingValue, valueElement);

  const handleDoubleClickValue = () => {
    if (!writable) {
      return;
    }
    valueEditor.open(formatWatchValue(value));
  };

  const handleDoubleClickExpression = () => {
    setEditExpression(expression);
    setIsEditingExpression(true);
    setHasExpressionError(false);
  };

  const handleSaveExpression = async () => {
    try {
      await onModifyExpression(editExpression);
      setIsEditingExpression(false);
      setHasExpressionError(false);
    } catch {
      // Flash red border on error - keep edit box open
      setHasExpressionError(true);
      setTimeout(() => setHasExpressionError(false), 500);
    }
  };

  const handleKeyDownValue = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // a refusal keeps the box open, marked, and the notice of the store says why
      valueEditor.submit();
    } else if (e.key === "Escape") {
      valueEditor.close();
    }
  };

  const handleKeyDownExpression = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveExpression().catch((error) => {
        console.error("handleSaveExpression failed:", error);
      });
    } else if (e.key === "Escape") {
      setIsEditingExpression(false);
      setHasExpressionError(false);
    }
  };

  return (
    <ListItem
      sx={{ py: 0.25, px: 1.5 }}
      secondaryAction={
        <IconButton
          edge="end"
          size="small"
          aria-label={`Remove ${expression}`}
          data-focus-key={focusKey}
          onClick={onRemove}
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      }
    >
      {isEditingExpression || isEditingValue ? (
        <Stack direction="row" spacing={1} sx={{ flex: 1, pr: 1 }}>
          {isEditingExpression ? (
            <TextField
              size="small"
              value={editExpression}
              onChange={(e) => setEditExpression(e.target.value)}
              onKeyDown={handleKeyDownExpression}
              onBlur={() => {
                setIsEditingExpression(false);
                setHasExpressionError(false);
              }}
              autoFocus
              error={hasExpressionError}
              sx={{
                flex: 1,
                "& .MuiOutlinedInput-root": {
                  fontSize: "0.813rem",
                  fontFamily: "monospace",
                  height: "24px",
                },
              }}
            />
          ) : (
            <>
              <Typography
                variant="body2"
                onDoubleClick={handleDoubleClickExpression}
                sx={{
                  fontFamily: "monospace",
                  fontSize: "0.813rem",
                  whiteSpace: "nowrap",
                  cursor: "text",
                }}
              >
                {expression}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontFamily: "monospace",
                  fontSize: "0.813rem",
                  whiteSpace: "nowrap",
                }}
              >
                =
              </Typography>
              {isEditingValue ? (
                <TextField
                  size="small"
                  value={valueEditor.text ?? ""}
                  onChange={(e) => valueEditor.change(e.target.value)}
                  onKeyDown={handleKeyDownValue}
                  onFocus={valueBoxFocus.onFocus}
                  onBlur={() => {
                    valueBoxFocus.onBlur();
                    valueEditor.close();
                  }}
                  autoFocus
                  error={valueEditor.refusal !== undefined}
                  slotProps={{
                    htmlInput: {
                      "aria-label": `New value of ${expression}`,
                      "aria-busy": valueEditor.sending || undefined,
                      readOnly: valueEditor.sending,
                      title: valueEditor.refusal,
                    },
                  }}
                  sx={{
                    flex: 1,
                    "& .MuiOutlinedInput-root": {
                      fontSize: "0.813rem",
                      fontFamily: "monospace",
                      height: "24px",
                    },
                  }}
                />
              ) : (
                <Typography
                  variant="body2"
                  onDoubleClick={handleDoubleClickValue}
                  sx={{
                    fontFamily: "monospace",
                    fontSize: "0.813rem",
                    cursor: "text",
                  }}
                >
                  {formatWatchValue(value)}
                </Typography>
              )}
            </>
          )}
        </Stack>
      ) : (
        <Typography
          variant="body2"
          sx={{
            fontFamily: "monospace",
            fontSize: "0.813rem",
            wordBreak: "break-word",
            pr: 1,
          }}
        >
          <Box
            component="span"
            onDoubleClick={handleDoubleClickExpression}
            sx={{ cursor: "text" }}
          >
            {expression}
          </Box>
          {" = "}
          <Box
            component="span"
            ref={valueElement}
            onDoubleClick={handleDoubleClickValue}
            title={EDIT_TITLES[mode]}
            {...(isControl(mode) && {
              role: "button",
              tabIndex: 0,
              "aria-label": controlName(expression, formatWatchValue(value)),
              "aria-disabled": !writable || undefined,
              onKeyDown: (event: React.KeyboardEvent) => {
                if (opensEditor(event.key)) {
                  event.preventDefault();
                  handleDoubleClickValue();
                }
              },
            })}
            sx={{
              cursor: writable ? "text" : "default",
              borderRadius: "3px",
              outline: "none",
              "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: "2px" },
            }}
          >
            {formatWatchValue(value)}
          </Box>
        </Typography>
      )}
    </ListItem>
  );
};

// The suggestion popup is not virtualised: with every register of a real machine as an
// option it would mount thousands of rows. Show the best matches and let typing narrow them.
const MAX_SUGGESTIONS = 50;
const filterSuggestions = createFilterOptions<string>({ limit: MAX_SUGGESTIONS });

// Helper to collect all register paths from device tree
const collectRegisterPaths = (nodes: DeviceNodeDescriptor[]): string[] => {
  const paths: string[] = [];
  for (const node of nodes) {
    // Add register paths - node.path already contains the full path. Watch expressions use
    // the lower-case register name, like the "+" button of the device tree.
    if (node.registers) {
      for (const reg of node.registers) {
        paths.push(`${node.path}.${reg.name.toLowerCase()}`);
      }
    }

    // Recursively collect from children
    if (node.children) {
      paths.push(...collectRegisterPaths(node.children));
    }
  }
  return paths;
};

/**
 * The expression box and its button. A component of its own, and memoised: the panel renders
 * again with every tick (the watch values), and a render of an open MUI Autocomplete drops
 * the suggestion that the arrow keys highlighted. A running server sends five ticks a second.
 */
const AddWatchForm = memo(() => {
  const deviceTree = useDebuggerDataStore((state) => state.deviceTree);
  const addWatch = useDebuggerDataStore((state) => state.addWatch);
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const [newWatch, setNewWatch] = useState("");

  // Collect all available register paths from device tree
  const availablePaths = useMemo(() => collectRegisterPaths(deviceTree), [deviceTree]);

  const handleAdd = useCallback(async () => {
    const trimmed = newWatch.trim();
    // Without a server nothing can be watched. The box stays, with what is in it: it is there
    // to be sent when the connection is back.
    if (!trimmed || !initialized) {
      return;
    }
    await addWatch(trimmed);
    setNewWatch("");
  }, [newWatch, addWatch, initialized]);

  return (
    <Stack direction="row" spacing={1}>
      <Autocomplete
        size="small"
        fullWidth
        freeSolo
        options={availablePaths}
        filterOptions={filterSuggestions}
        // The typed text is the input value, not a selected option: bound to `value`,
        // MUI treats it as the selection and stops filtering the suggestions by it.
        value={null}
        inputValue={newWatch}
        onInputChange={(_, newValue) => setNewWatch(newValue)}
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder="Enter expression"
            onKeyDown={(e) => {
              // Enter on a highlighted suggestion completes the text (MUI does that)
              const suggestionHighlighted = (e.target as HTMLElement).hasAttribute("aria-activedescendant");
              if (e.key === "Enter" && !suggestionHighlighted) {
                e.preventDefault();
                void handleAdd();
              }
            }}
            sx={{ "& .MuiOutlinedInput-root": { fontSize: "0.875rem", fontFamily: "monospace" } }}
          />
        )}
      />
      {/* not `disabled` while it cannot be used: that would take the keyboard focus away from it */}
      <Button
        size="small"
        variant="contained"
        onClick={handleAdd}
        aria-disabled={!initialized || undefined}
        sx={[{ minWidth: 85 }, !initialized && UNUSABLE_SX]}
      >
        Add Watch
      </Button>
    </Stack>
  );
});
AddWatchForm.displayName = "AddWatchForm";

export const WatchesPanel = () => {
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const watches = useDebuggerDataStore((state) => state.watches);
  const removeWatch = useDebuggerDataStore((state) => state.removeWatch);
  const editWatch = useDebuggerDataStore((state) => state.editWatch);
  const modifyWatchExpression = useDebuggerDataStore((state) => state.modifyWatchExpression);
  // state.editWatch is a register write. A server without them (milestone M1) refuses it
  // (-32004), and so does every server for a register without a writer (-32013): neither is
  // asked for. Which register has one is said in the describe tree and in no tick, and a watch
  // is an expression: its register is the described one the expression names. Like the other
  // editors, this one is offered while the target is paused.
  const registerWrite = useCapability(CAPABILITIES.REGISTER_WRITE);
  const paused = useRunState() === "paused";
  const deviceTree = useDebuggerDataStore((state) => state.deviceTree);
  const described = useMemo(() => indexRegisters(deviceTree), [deviceTree]);
  const modeOf = (expression: string): Editability => {
    const register = watchedRegister(described, expression);
    return editability(register !== undefined && hasWriter(register), { registerWrite, paused });
  };
  const scope = useId();
  const lostFocus = useRef<string | undefined>(undefined);

  const handleRemove = useCallback(
    async (watchId: number) => {
      await removeWatch(watchId);
    },
    [removeWatch],
  );

  const handleEdit = useCallback(
    async (watchId: number, value: string): Promise<void> => {
      await editWatch(watchId, value);
    },
    [editWatch],
  );

  const handleModifyExpression = useCallback(
    async (watchId: number, newExpression: string): Promise<void> => {
      await modifyWatchExpression(watchId, newExpression);
    },
    [modifyWatchExpression],
  );

  return (
    <Panel>
      <Box sx={{ p: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
        <AddWatchForm />
      </Box>
      {initialized && <ListFocusKeeper scope={scope} lost={lostFocus} />}
      {!initialized ? (
        <NoData />
      ) : watches.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No watches subscribed.
        </Typography>
      ) : (
        <List dense disablePadding>
          {watches.map((watch) => (
            <WatchItem
              key={watch.id}
              expression={watch.expression}
              value={watch.value}
              mode={modeOf(watch.expression)}
              // the expression, not the id: it is what the user sees, and it is the same watch after the server was restarted
              focusKey={`${scope}:${watch.expression}:remove`}
              onRemove={() => void handleRemove(watch.id)}
              onEdit={(newValue) => handleEdit(watch.id, newValue)}
              onModifyExpression={(newExpression) => handleModifyExpression(watch.id, newExpression)}
            />
          ))}
        </List>
      )}
    </Panel>
  );
};

const formatWatchValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "number") {
    return `0x${value.toString(16).toUpperCase()}`;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};
