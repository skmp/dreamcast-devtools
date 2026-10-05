import { memo, useCallback, useMemo, useState } from "react";
import type { SyntheticEvent } from "react";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";
import { useShallow } from "zustand/react/shallow";
import { Panel } from "../layout/Panel";
import type { DeviceNodeDescriptor, RegisterValue, PanelId } from "../../lib/debuggerSchema";
import { Box, Divider, IconButton, Stack, TextField, Typography } from "@mui/material";
import { HideOnHoverTooltip as Tooltip } from "../components";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { PANEL_REGISTRY, type PanelRegistryEntry } from "../layout/panelRegistry";
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

const ITEM_SX = {
  "& .MuiTreeItem-content": {
    py: 0,
    minHeight: "24px",
  },
} as const;

const TREE_SX = {
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
} as const;

const TREE_SLOTS = { collapseIcon: ExpandMoreIcon, expandIcon: ChevronRightIcon };

interface RegisterRowProps {
  nodePath: string;
  name: string;
  value: string;
  watched: boolean;
}

const RegisterRow = memo(({ nodePath, name, value, watched }: RegisterRowProps) => (
  <TreeItem
    itemId={registerItemId(nodePath, name)}
    label={
      <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="space-between" sx={{ py: 0 }}>
        <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.813rem", lineHeight: 1.4 }}>
          {name} = {value}
        </Typography>
        <Tooltip title={watched ? "Already in watch" : "Add to watch"}>
          <span>
            <IconButton
              size="small"
              color="primary"
              disabled={watched}
              onClick={(event) => {
                event.stopPropagation();
                // addWatch ignores expressions that are already watched
                void useDebuggerDataStore.getState().addWatch(watchExpression(nodePath, name));
              }}
              sx={{ padding: "2px" }}
            >
              <AddIcon sx={{ fontSize: "0.875rem" }} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    }
    sx={ITEM_SX}
  />
));
RegisterRow.displayName = "RegisterRow";

interface NodeRegistersProps {
  nodePath: string;
  /** The registers to show, as described (a search may have filtered them). */
  registers: RegisterValue[];
}

const NodeRegisters = memo(({ nodePath, registers }: NodeRegistersProps) => {
  const values = useDebuggerDataStore(
    useShallow((state) => liveRegisterValues(registers, state.registersByPath[nodePath])),
  );
  const expressions = useMemo(
    () => registers.map((register) => watchExpression(nodePath, register.name)),
    [nodePath, registers],
  );
  const watched = useDebuggerDataStore(
    useShallow((state) => expressions.map((expression) => state.watches.some((watch) => watch.expression === expression))),
  );

  return registers.map((register, index) => (
    <RegisterRow
      key={register.name}
      nodePath={nodePath}
      name={register.name}
      value={values[index]}
      watched={watched[index]}
    />
  ));
});
NodeRegisters.displayName = "NodeRegisters";

interface DeviceNodeItemProps {
  node: DeviceNodeDescriptor;
  onOpenPanel?: (panelId: PanelId) => void;
}

const DeviceNodeItem = memo(({ node, onOpenPanel }: DeviceNodeItemProps) => {
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
            {hasActions ? (
              <Tooltip title={node.description} placement="right">
                <Typography variant="body2" fontWeight={500} sx={{ fontSize: "0.813rem", lineHeight: 1.4 }}>
                  {node.label}
                </Typography>
              </Tooltip>
            ) : (
              <Typography variant="body2" fontWeight={500} sx={{ fontSize: "0.813rem", lineHeight: 1.4 }}>
                {node.label}
              </Typography>
            )}
            {!node.actions && (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.688rem", lineHeight: 1.4 }}>
                {node.description}
              </Typography>
            )}
          </Stack>
          {hasActions && (
            <Stack direction="row" spacing={0.25} alignItems="center">
              {actions.map((panelId) => {
                // the server may name a panel this build does not have
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
          {hasRegisters && <NodeRegisters nodePath={node.path} registers={node.registers!} />}
          {node.children?.map((child) => (
            <DeviceNodeItem key={child.path} node={child} onOpenPanel={onOpenPanel} />
          ))}
        </>
      ) : undefined}
    </TreeItem>
  );
});
DeviceNodeItem.displayName = "DeviceNodeItem";

interface DeviceTreePanelProps {
  onOpenPanel?: (panelId: PanelId) => void;
}

export const DeviceTreePanel = ({ onOpenPanel }: DeviceTreePanelProps = {}) => {
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const deviceTree = useDebuggerDataStore((state) => state.deviceTree);
  const [searchQuery, setSearchQuery] = useState("");

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

  return (
    <Panel>
      {!initialized ? (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
          <Typography variant="body2" color="text.secondary">
            No Data
          </Typography>
        </Box>
      ) : deviceTree.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No device information available.
        </Typography>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
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
            {search && search.totalRows > search.shownRows && (
              <Typography variant="caption" color="warning.main" role="status" sx={{ display: "block", mt: 0.5 }}>
                Showing the first {search.shownRows} of {search.totalRows} matching rows. Refine your search to see the
                rest.
              </Typography>
            )}
            {search && search.totalRows === 0 && (
              <Typography variant="caption" color="text.secondary" role="status" sx={{ display: "block", mt: 0.5 }}>
                No component or register matches.
              </Typography>
            )}
          </Box>
          <Divider />
          <SimpleTreeView
            expandedItems={expandedItems}
            onExpandedItemsChange={handleExpandedItemsChange}
            slots={TREE_SLOTS}
            multiSelect
            sx={TREE_SX}
          >
            {nodes.map((node) => (
              <DeviceNodeItem key={node.path} node={node} onOpenPanel={onOpenPanel} />
            ))}
          </SimpleTreeView>
        </Box>
      )}
    </Panel>
  );
};
