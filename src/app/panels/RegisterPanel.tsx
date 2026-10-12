import { memo, useCallback, useEffect, useMemo } from "react";
import { Box, Typography } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { useShallow } from "zustand/react/shallow";
import { Panel } from "../layout/Panel";
import { PANEL_REGISTRY } from "../layout/panelRegistry";
import { CAPABILITIES, type DeviceNodeDescriptor, type PanelId, type RegisterValue } from "../../lib/debuggerSchema";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { useCapability, useRunState } from "../../state/debuggerSelectors";
import { targetInfo } from "../../state/targets";
import { NO_GAME } from "../../state/tickState";
import { NoData, PanelNotice } from "../components/PanelNotice";
import { useWriteEditor } from "../components/useWriteEditor";
import { WriteEditorInput } from "../components/WriteEditorInput";
import { liveRegisterValues } from "./deviceTreeModel";
import {
  EDIT_TITLES,
  editability,
  panelNode,
  registerRows,
  registerWrite,
  type Editability,
  type RegisterRowModel,
} from "./registerPanelModel";

// The table of the registers of one node of the device tree. A panel is bound to an id, and
// shows the node that offers that id as an action (`panelNode`): nothing in the client says
// which node that is. Twelve ids are bound to it (Sh4RegisterPanels.tsx).
//
// Rows, widths and whether a register can be written are the described ones; the values are
// those of the ticks (registerPanelModel.ts).
//
// Rendering model, as in the device tree: a tick replaces `registersByPath` in the store, so
// nothing here subscribes to it as a whole.
//
// - RegisterPanel renders from what debugger.describe said, and not again for a tick.
// - RegisterRows (memoised) selects the values and the watched flags of its own node, compared
//   element by element: it renders again only when one of its registers changed.
// - RegisterRow (memoised) renders again only when its own value, its watched flag or what
//   can be done with it changed. An open editor is state of its row.
//
// The rows are plain table rows, not components of the UI library: a tree of the emulator has
// some three thousand registers, and a panel of each of the twelve ids can be open.

const STALE_TITLE = "Values of the last stop: the running core does not report its registers";

const NO_REGISTERS: RegisterValue[] = [];

const tableSx = (theme: Theme) => ({
  borderCollapse: "collapse",
  // as wide as its columns: a panel narrower than that scrolls to the side, and cuts nothing
  minWidth: "100%",
  fontFamily: "monospace",
  fontSize: "0.813rem",
  lineHeight: 1.4,
  "& th": {
    position: "sticky",
    top: 0,
    zIndex: 1,
    padding: "4px 8px",
    textAlign: "left",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: theme.palette.text.secondary,
    backgroundColor: theme.palette.background.paper,
    borderBottom: `1px solid ${theme.palette.divider}`,
    whiteSpace: "nowrap",
  },
  "& td": {
    padding: "0 8px",
    height: "24px",
    whiteSpace: "nowrap",
  },
  "& tbody tr:hover": {
    backgroundColor: theme.palette.action.hover,
    "@media (hover: none)": {
      backgroundColor: "transparent",
    },
  },
  // values of the last stop, shown while the running core does not report them
  "& tbody[data-stale]": {
    opacity: 0.45,
  },
  "& .register-bits": {
    textAlign: "right",
    color: theme.palette.text.secondary,
  },
  // the value takes the room that is left, so that the box of an editor has it, and never
  // less than a value of 32 bits and its box need
  "& .register-value": {
    width: "100%",
    minWidth: "14ch",
  },
  "& .register-value [data-editable]": {
    cursor: "text",
  },
  "& .register-editor": {
    font: "inherit",
    color: "inherit",
    boxSizing: "border-box",
    width: "100%",
    minWidth: "12ch",
    height: "22px",
    margin: 0,
    padding: "0 4px",
    // where the text of the value was
    marginLeft: "-5px",
    border: `1px solid ${theme.palette.primary.main}`,
    borderRadius: "3px",
    backgroundColor: theme.palette.background.default,
    outline: "none",
    "&[aria-invalid]": {
      borderColor: theme.palette.error.main,
    },
    "&[aria-busy]": {
      opacity: 0.6,
    },
  },
  "& .register-watch": {
    display: "inline-flex",
    verticalAlign: "middle",
    margin: 0,
    padding: "2px",
    border: 0,
    borderRadius: "50%",
    backgroundColor: "transparent",
    color: theme.palette.primary.main,
    cursor: "pointer",
    "& svg": {
      width: "0.875rem",
      height: "0.875rem",
      fill: "currentColor",
    },
    "&:hover": {
      backgroundColor: alpha(theme.palette.primary.main, theme.palette.action.hoverOpacity),
    },
    "&:focus-visible": {
      outline: "2px solid currentColor",
    },
    "&:disabled": {
      backgroundColor: "transparent",
      color: theme.palette.action.disabled,
      cursor: "default",
    },
  },
});

// the path of @mui/icons-material/Add
const ADD_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" />
  </svg>
);

interface RegisterRowProps {
  nodePath: string;
  row: RegisterRowModel;
  value: string;
  /** whether the value is an editor now, and why not */
  mode: Editability;
  watched: boolean;
}

const RegisterRow = memo(({ nodePath, row, value, mode, watched }: RegisterRowProps) => {
  const write = useCallback(
    (text: string) => {
      const request = registerWrite(nodePath, row.name, text);
      return useDebuggerDataStore.getState().setRegister(request.path, request.name, request.value);
    },
    [nodePath, row.name],
  );
  const editor = useWriteEditor(write);
  // An editor is offered while the register can be written: one that is open when the target
  // runs again (or the server is another one) is not shown any more, and is put away with
  // what was typed.
  const editing = editor.text !== undefined && mode === "editable";
  const { text: draft, close } = editor;
  useEffect(() => {
    if (draft !== undefined && mode !== "editable") {
      close();
    }
  }, [draft, mode, close]);
  const watchTitle = watched ? "Already in watch" : "Add to watch";

  return (
    <tr data-register={row.name}>
      <td>{row.name}</td>
      <td className="register-value">
        {editing ? (
          <WriteEditorInput editor={editor} label={`New value of ${row.name}`} className="register-editor" />
        ) : (
          <span
            data-editable={mode === "editable" ? "" : undefined}
            title={EDIT_TITLES[mode]}
            onDoubleClick={mode === "editable" ? () => editor.open(value) : undefined}
          >
            {value}
          </span>
        )}
      </td>
      <td className="register-bits">{row.bits}</td>
      <td>
        <button
          type="button"
          className="register-watch"
          aria-label={watchTitle}
          title={watchTitle}
          disabled={watched}
          onClick={() => {
            // addWatch ignores expressions that are already watched
            void useDebuggerDataStore.getState().addWatch(row.watch);
          }}
        >
          {ADD_ICON}
        </button>
      </td>
    </tr>
  );
});
RegisterRow.displayName = "RegisterRow";

const RegisterRows = memo(({ node }: { node: DeviceNodeDescriptor }) => {
  const rows = useMemo(() => registerRows(node), [node]);
  const described = node.registers ?? NO_REGISTERS;
  const values = useDebuggerDataStore(
    useShallow((state) => liveRegisterValues(described, state.registersByPath[node.path], state.executionState?.reason === NO_GAME)),
  );
  const watched = useDebuggerDataStore(
    useShallow((state) => rows.map((row) => state.watches.some((watch) => watch.expression === row.watch))),
  );
  // state.setRegister is refused by a server without register writes (-32004), and for a
  // register without a writer (-32013): neither is asked for. Editing is offered while the
  // target is paused.
  const registerWriteCapability = useCapability(CAPABILITIES.REGISTER_WRITE);
  const paused = useRunState() === "paused";

  // A core without a complete context while it runs sends running ticks without its registers
  // and says so (`registersStale`): what is on screen for it is from the last stop.
  const stale = useDebuggerDataStore((state) => {
    if (state.executionState?.registersStale !== true) {
      return false;
    }
    const sh4 = targetInfo(state.shape, "sh4");
    return sh4.supported && node.path === sh4.pcPath;
  });

  return (
    <tbody data-stale={stale ? "" : undefined} title={stale ? STALE_TITLE : undefined}>
      {rows.map((row, index) => (
        <RegisterRow
          key={row.name}
          nodePath={node.path}
          row={row}
          value={values[index]}
          mode={editability(row.writable, { registerWrite: registerWriteCapability, paused })}
          watched={watched[index]}
        />
      ))}
    </tbody>
  );
});
RegisterRows.displayName = "RegisterRows";

interface RegisterPanelProps {
  panelId: PanelId;
}

export const RegisterPanel = ({ panelId }: RegisterPanelProps) => {
  const initialized = useDebuggerDataStore((state) => state.initialized);
  // The describe tree of the server that described itself last: the store's `deviceTree` while
  // its connection is there, and what that was while it is away. A panel whose table the
  // server does not have says so for as long as that server is the one of this page.
  const tree = useDebuggerDataStore((state) => state.shape?.deviceTree);
  const node = useMemo(() => (tree ? panelNode(tree, panelId) : undefined), [tree, panelId]);

  if (tree !== undefined && node === undefined) {
    // nothing is requested: the panel has no node to ask about
    return (
      <Panel>
        <PanelNotice>This server has no {PANEL_REGISTRY[panelId].name}.</PanelNotice>
      </Panel>
    );
  }

  const shown = initialized ? node : undefined;
  return (
    <Panel>
      {/* The frame of the table: its columns, and which node it is of once a server has said so.
          The rows are the server's, and go with its connection. */}
      <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
        <Box component="table" sx={tableSx} aria-label={PANEL_REGISTRY[panelId].name}>
          {shown && (
            <caption style={{ captionSide: "top", textAlign: "left", padding: "6px 8px 2px" }}>
              <Typography component="span" variant="body2" sx={{ fontWeight: 600, fontSize: "0.813rem" }}>
                {shown.label}
              </Typography>{" "}
              <Typography component="span" variant="caption" color="text.secondary" title={shown.description}>
                {shown.path}
              </Typography>
            </caption>
          )}
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
              <th scope="col" style={{ textAlign: "right" }}>
                Bits
              </th>
              <th scope="col" aria-label="Watch" />
            </tr>
          </thead>
          {shown && <RegisterRows node={shown} />}
        </Box>
        {!shown ? (
          <Box sx={{ flex: 1 }}>
            <NoData />
          </Box>
        ) : (
          (shown.registers?.length ?? 0) === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              This node has no registers.
            </Typography>
          )
        )}
      </Box>
    </Panel>
  );
};
