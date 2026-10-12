import { useMemo, type ReactNode } from "react";
import { Toolbar, Stack, Divider, Button, Box, Autocomplete, TextField } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { createNavigationItems } from "./navigationItems";

/**
 * Below this width a workspace page hides its side docks (`AppLayout`), and its toolbar has no
 * room for the run controls between what is on its left and what is on its right: the centre
 * section then has a line of its own under them.
 */
const NO_ROOM_IN_LINE = "@media (max-width: 1199.95px)";

interface TopNavProps {
  onAboutClick: () => void;
  onResetLayout?: () => void;
  rightSection?: ReactNode;
  centerSection?: ReactNode;
  currentPage?: string;
}

export const TopNav = ({
  onAboutClick,
  onResetLayout,
  rightSection,
  centerSection,
  currentPage,
}: TopNavProps) => {
  const navigate = useNavigate();

  // Navigation items are now defined in navigationItems.ts (not configurable)
  const navigationItems = useMemo(() => createNavigationItems(navigate), [navigate]);

  // Find the current page in navigation items
  const currentValue = currentPage
    ? navigationItems.find(item => item.id === currentPage) || null
    : null;

  return (
    <Toolbar sx={{ gap: 2, position: "relative", ...(centerSection ? { [NO_ROOM_IN_LINE]: { flexWrap: "wrap", rowGap: 0 } } : {}) }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0 }}>
        <Autocomplete
          options={navigationItems}
          groupBy={(option) => option.category}
          getOptionLabel={(option) => option.label}
          value={currentValue}
          onChange={(_, value) => {
            if (value) {
              value.onClick();
            }
          }}
          sx={{ width: 300 }}
          size="small"
          renderInput={(params) => (
            <TextField
              {...params}
              placeholder="Navigate to..."
              variant="outlined"
            />
          )}
          disableClearable={false}
          blurOnSelect
          autoHighlight
          autoSelect
          selectOnFocus
          clearOnEscape
        />
        {onResetLayout && (
          <>
            <Divider orientation="vertical" flexItem />
            <Button variant="text" color="primary" onClick={onResetLayout}>
              Reset layout
            </Button>
          </>
        )}
        <Divider orientation="vertical" flexItem />
        <Button variant="text" color="primary" onClick={onAboutClick}>
          About
        </Button>
      </Stack>
      {centerSection ? (
        // In the line, and it has the room between the two sides: what is in it starts where
        // the left side ends and stays there, whatever is beside it. (It was laid over the
        // middle of the toolbar, where six buttons are on top of the left side in a window of
        // 1280 px.)
        <Box
          sx={{
            flex: "1 1 0",
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            [NO_ROOM_IN_LINE]: { order: 1, flex: "0 0 100%", justifyContent: "center", pb: 1 },
          }}
        >
          {centerSection}
        </Box>
      ) : (
        <Box sx={{ flexGrow: 1 }} />
      )}
      {centerSection ? <Box sx={{ [NO_ROOM_IN_LINE]: { ml: "auto" } }}>{rightSection}</Box> : rightSection}
    </Toolbar>
  );
};
