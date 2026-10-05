import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MutableRefObject, SyntheticEvent } from "react";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";
import { useShallow } from "zustand/react/shallow";
import { Panel } from "../layout/Panel";
import { isPanelId } from "../../lib/debuggerSchema";
import type { DeviceNodeDescriptor, RegisterValue, PanelId } from "../../lib/debuggerSchema";
import { Box, Divider, IconButton, Stack, TextField, Typography } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { HideOnHoverTooltip as Tooltip } from "../components";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import SearchIcon from "@mui/icons-material/Search";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { PANEL_REGISTRY, type PanelRegistryEntry } from "../layout/panelRegistry";
import { targetInfo } from "../../state/targets";
import { NO_GAME } from "../../state/tickState";
import {
  defaultExpansion,
  liveRegisterValues,
  registerItemId,
  searchDeviceTree,
  watchExpression,
} from "./deviceTreeModel";

// Rendering model. A tick replaces `registersByPath` and `watches` in the store with new
// objects even when nothing changed, so nothing here subscribes to them as a whole:
//
// - DeviceNodeItem (one per node, memoised) renders from the node descriptor alone and
//   never re-renders for a tick.
// - NodeRegisters (one per expanded node that has registers, memoised) selects the values
//   and watched flags of its own path, compared element by element, so it re-renders only
//   when one of its registers changed.
// - RegisterRow (memoised) re-renders only when its own value or watched flag changed.
//
// Collapsed nodes do not mount their children at all (the tree view unmounts them).
//
// Only the nodes are items of the tree view. The registers of a node are a plain list
// inside its item: every TreeItem writes to the tree view's store when it mounts and when
// it unmounts, and each of those writes notifies every item that is mounted, so removing n
// items in one go costs n * n. With a TreeItem per register, leaving a tree of 2600 rows
// (a search, a collapse, closing the panel) blocked the page for a minute.
//
// The rows must not get role="treeitem": the tree view collects the children of an item
// from the DOM by that role and does not survive one it did not render.

/** Indentation of one tree level in px (the tree view's default, given to it explicitly). */
const INDENT_PX = 12;
/** Where the label starts in a row of the tree view: padding, expander icon, gap. */
const LABEL_OFFSET_PX = 8 + 16 + 8;

const ITEM_SX = {
  "& .MuiTreeItem-content": {
    py: 0,
    minHeight: "24px",
  },
} as const;

const treeSx = (theme: Theme) => ({
  px: 1,
  py: 0.5,
  flex: 1,
  overflowY: "auto",
  "& .MuiTreeItem-group": {
    marginLeft: "12px",
    marginTop: 0,
  },
  "& .MuiTreeItem-content": {
    marginBottom: 0,
  },
  "& .device-tree-registers": {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  // values of the last stop, shown while the running core does not report them
  "& .device-tree-registers[data-stale]": {
    opacity: 0.45,
  },
  // RegisterRow, laid out like the content of a tree item
  "& .device-tree-register": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "4px",
    boxSizing: "border-box",
    minHeight: "24px",
    paddingRight: "8px",
    borderRadius: 1,
    "&:hover": {
      backgroundColor: theme.palette.action.hover,
      "@media (hover: none)": {
        backgroundColor: "transparent",
      },
    },
  },
  "& .device-tree-register-text": {
    fontFamily: "monospace",
    fontSize: "0.813rem",
    lineHeight: 1.4,
  },
  "& .device-tree-watch": {
    display: "inline-flex",
    flexShrink: 0,
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

const TREE_SLOTS = { collapseIcon: ExpandMoreIcon, expandIcon: ChevronRightIcon };

// the path of @mui/icons-material/Add
const ADD_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" />
  </svg>
);

interface RegisterRowProps {
  /** Left padding in px that puts the text where the label of a tree item at this depth starts. */
  indent: number;
  nodePath: string;
  name: string;
  value: string;
  watched: boolean;
}

/** A register of a node. The tree view does not know it: the arrow keys skip it and it cannot be selected. */
const RegisterRow = memo(({ indent, nodePath, name, value, watched }: RegisterRowProps) => {
  const title = watched ? "Already in watch" : "Add to watch";
  return (
    <li className="device-tree-register" data-register={registerItemId(nodePath, name)} style={{ paddingLeft: indent }}>
      <span className="device-tree-register-text">{`${name} = ${value}`}</span>
      <button
        type="button"
        className="device-tree-watch"
        aria-label={title}
        title={title}
        disabled={watched}
        onClick={() => {
          // addWatch ignores expressions that are already watched
          void useDebuggerDataStore.getState().addWatch(watchExpression(nodePath, name));
        }}
      >
        {ADD_ICON}
      </button>
    </li>
  );
});
RegisterRow.displayName = "RegisterRow";

/**
 * A key pressed inside the register list bubbles to the item of the node, and the tree
 * view would act on it as a key of that item: Enter would collapse the node instead of
 * pressing the button. This is how an event is kept from the handlers of MUI X.
 */
const keepKeyFromTreeView = (event: KeyboardEvent<HTMLElement> & { defaultMuiPrevented?: boolean }) => {
  event.defaultMuiPrevented = true;
};

interface NodeRegistersProps {
  nodePath: string;
  /** Depth of the node in the tree; its registers are one level below it. */
  depth: number;
  /** The registers to show, as described (a search may have filtered them). */
  registers: RegisterValue[];
}

const NodeRegisters = memo(({ nodePath, depth, registers }: NodeRegistersProps) => {
  const values = useDebuggerDataStore(
    useShallow((state) =>
      liveRegisterValues(registers, state.registersByPath[nodePath], state.executionState?.reason === NO_GAME),
    ),
  );
  const expressions = useMemo(
    () => registers.map((register) => watchExpression(nodePath, register.name)),
    [nodePath, registers],
  );
  const watched = useDebuggerDataStore(
    useShallow((state) => expressions.map((expression) => state.watches.some((watch) => watch.expression === expression))),
  );

  // A core without a complete context while it runs sends running ticks without its registers
  // and says so (`registersStale`): what is on screen for it is from the last stop.
  const stale = useDebuggerDataStore(
    (state) => state.executionState?.registersStale === true && nodePath === targetInfo(state.shape, "sh4").pcPath,
  );

  const indent = LABEL_OFFSET_PX + INDENT_PX * (depth + 1);
  return (
    <ul
      className="device-tree-registers"
      data-stale={stale ? "" : undefined}
      title={stale ? "Values of the last stop: the running core does not report its registers" : undefined}
      onKeyDown={keepKeyFromTreeView}
    >
      {registers.map((register, index) => (
        <RegisterRow
          key={register.name}
          indent={indent}
          nodePath={nodePath}
          name={register.name}
          value={values[index]}
          watched={watched[index]}
        />
      ))}
    </ul>
  );
});
NodeRegisters.displayName = "NodeRegisters";

interface DeviceNodeItemProps {
  node: DeviceNodeDescriptor;
  /** 0 for the roots of the tree */
  depth: number;
  onOpenPanel?: (panelId: PanelId) => void;
}

const DeviceNodeItem = memo(({ node, depth, onOpenPanel }: DeviceNodeItemProps) => {
  const actions = node.actions ?? [];
  const hasActions = actions.length > 0;
  const hasRegisters = node.registers !== undefined && node.registers.length > 0;
  const hasChildren = node.children !== undefined && node.children.length > 0;

  return (
    <TreeItem
      itemId={node.path}
      label={
        <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="space-between" sx={{ py: 0, width: "100%" }}>
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" fontWeight={500} sx={{ fontSize: "0.813rem", lineHeight: 1.4, flexShrink: 0 }}>
              {node.label}
            </Typography>
            {/* next to the label for every node; the buttons of a node with actions take what they need first */}
            {node.description && (
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                title={node.description}
                sx={{ fontSize: "0.688rem", lineHeight: 1.4, minWidth: 0 }}
              >
                {node.description}
              </Typography>
            )}
          </Stack>
          {hasActions && (
            <Stack direction="row" spacing={0.25} alignItems="center">
              {actions.map((panelId) => {
                // the server may name a panel this build does not have
                if (!isPanelId(panelId)) {
                  return null;
                }
                const panelInfo: PanelRegistryEntry | undefined = PANEL_REGISTRY[panelId];
                if (!panelInfo) {
                  return null;
                }
                return (
                  <Tooltip key={panelId} title={`Open ${panelInfo.name}`} placement="left">
                    <IconButton
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenPanel?.(panelId);
                      }}
                      sx={{ padding: "2px" }}
                    >
                      {panelInfo.icon}
                    </IconButton>
                  </Tooltip>
                );
              })}
            </Stack>
          )}
        </Stack>
      }
      sx={ITEM_SX}
    >
      {/* undefined, not an empty list: the tree view shows an expander for any children */}
      {hasRegisters || hasChildren ? (
        <>
          {hasRegisters && <NodeRegisters nodePath={node.path} depth={depth} registers={node.registers!} />}
          {node.children?.map((child) => (
            <DeviceNodeItem key={child.path} node={child} depth={depth + 1} onOpenPanel={onOpenPanel} />
          ))}
        </>
      ) : undefined}
    </TreeItem>
  );
});
DeviceNodeItem.displayName = "DeviceNodeItem";

/**
 * Rendered just before the tree, and goes with it. The tree goes when the connection does,
 * and a node that had the keyboard focus takes the focus along: it would be on the page body
 * when the tree is back a second later. This notes the node on the way out (it is unmounted
 * before the tree is taken out of the document) and gives the focus back on the way in, if
 * nothing else has taken it since.
 */
const TreeFocusKeeper = ({ treeId, lost }: { treeId: string; lost: MutableRefObject<string | undefined> }) => {
  useLayoutEffect(() => {
    const id = lost.current;
    lost.current = undefined;
    // The tree view renders the nodes below its top level a moment after itself: the node is
    // looked for during the next frames, for as long as the focus is nowhere.
    let frame = 0;
    let framesLeft = 60;
    const restore = () => {
      if (id === undefined || document.activeElement !== document.body) {
        return;
      }
      const item = document.getElementById(id);
      if (item) {
        item.focus();
      } else if (framesLeft-- > 0) {
        frame = requestAnimationFrame(restore);
      }
    };
    restore();
    return () => {
      cancelAnimationFrame(frame);
      const item = document.activeElement?.closest<HTMLElement>('[role="treeitem"]');
      lost.current = item?.id.startsWith(`${treeId}-`) ? item.id : undefined;
    };
  }, [treeId, lost]);
  return null;
};

interface DeviceTreePanelProps {
  onOpenPanel?: (panelId: PanelId) => void;
}

export const DeviceTreePanel = ({ onOpenPanel }: DeviceTreePanelProps = {}) => {
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const deviceTree = useDebuggerDataStore((state) => state.deviceTree);
  const [searchQuery, setSearchQuery] = useState("");
  // The ids of the tree's nodes in the document start with this, and it is the panel's, not the
  // tree's: the tree that comes with the next connection has the same ids.
  const treeId = useId();
  const lostFocus = useRef<string | undefined>(undefined);

  // What the user expanded and collapsed. Until they touch the tree it follows the default
  // of the current tree; a search does not change it.
  const [userExpanded, setUserExpanded] = useState<string[] | null>(null);
  const initiallyExpanded = useMemo(() => defaultExpansion(deviceTree), [deviceTree]);
  // Toggles made while a search is shown apply to that search only.
  const [searchExpanded, setSearchExpanded] = useState<{ query: string; items: string[] } | null>(null);

  const search = useMemo(
    () => (searchQuery.trim() ? searchDeviceTree(deviceTree, searchQuery) : null),
    [deviceTree, searchQuery],
  );

  const nodes = search ? search.nodes : deviceTree;
  const expandedItems = search
    ? searchExpanded?.query === searchQuery
      ? searchExpanded.items
      : search.expanded
    : (userExpanded ?? initiallyExpanded);

  const handleExpandedItemsChange = useCallback(
    (_event: SyntheticEvent | null, items: string[]) => {
      if (searchQuery.trim()) {
        setSearchExpanded({ query: searchQuery, items });
      } else {
        setUserExpanded(items);
      }
    },
    [searchQuery],
  );

  const hasTree = initialized && deviceTree.length > 0;

  return (
    <Panel>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {/* Always there, like the box of the Watches panel: what was typed, and the focus, are
            still there when a lost connection is back. */}
        <Box sx={{ px: 1.5, py: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Search components..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            InputProps={{
              startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: "text.secondary" }} />,
            }}
            sx={{ "& .MuiOutlinedInput-root": { fontSize: "0.875rem" } }}
          />
          {hasTree && search && search.totalRows > search.shownRows && (
            <Typography variant="caption" color="warning.main" role="status" sx={{ display: "block", mt: 0.5 }}>
              Showing the first {search.shownRows} of {search.totalRows} matching rows. Refine your search to see the
              rest.
            </Typography>
          )}
          {hasTree && search && search.totalRows === 0 && (
            <Typography variant="caption" color="text.secondary" role="status" sx={{ display: "block", mt: 0.5 }}>
              No component or register matches.
            </Typography>
          )}
        </Box>
        <Divider />
        {!initialized ? (
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1 }}>
            <Typography variant="body2" color="text.secondary">
              No Data
            </Typography>
          </Box>
        ) : deviceTree.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            No device information available.
          </Typography>
        ) : (
          <>
            <TreeFocusKeeper treeId={treeId} lost={lostFocus} />
            <SimpleTreeView
              id={treeId}
              expandedItems={expandedItems}
              onExpandedItemsChange={handleExpandedItemsChange}
              slots={TREE_SLOTS}
              itemChildrenIndentation={INDENT_PX}
              multiSelect
              sx={treeSx}
            >
              {nodes.map((node) => (
                <DeviceNodeItem key={node.path} node={node} depth={0} onOpenPanel={onOpenPanel} />
              ))}
            </SimpleTreeView>
          </>
        )}
      </Box>
    </Panel>
  );
};
