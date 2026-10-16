import type { ReactNode } from "react";
import { Box, Stack, Typography } from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useNoDataText } from "../../state/debuggerSelectors";

/**
 * Says, in place of controls, that the server cannot do what they are for: a target it does
 * not list, a method it has no capability for. A control that can only fail is not shown.
 */
export const PanelNotice = ({ children }: { children: ReactNode }) => (
  <Box role="note" sx={{ display: "flex", alignItems: "flex-start", gap: 1, p: 2, color: "text.secondary" }}>
    <InfoOutlinedIcon fontSize="small" sx={{ mt: "1px", flexShrink: 0 }} />
    <Typography variant="body2">{children}</Typography>
  </Box>
);

/** What a panel shows in place of data while it has none to show. */
export const PanelPlaceholder = ({ children }: { children: ReactNode }) => (
  <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", minHeight: 48 }}>
    <Typography variant="body2" color="text.secondary">
      {children}
    </Typography>
  </Stack>
);

/**
 * In place of the data of a panel while the session has none: "Not connected", or "No Data"
 * for a connection whose server has not described itself. The frame of the panel — its boxes
 * and its toolbar — is not part of this and stays.
 */
export const NoData = () => <PanelPlaceholder>{useNoDataText()}</PanelPlaceholder>;
