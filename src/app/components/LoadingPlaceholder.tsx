import { Box, CircularProgress, Typography } from "@mui/material";

interface LoadingPlaceholderProps {
  /** "panel" fills a dock panel, "page" fills the viewport. */
  scope: "panel" | "page";
}

/** Shown while the code of a lazily loaded page or panel is being fetched. */
export const LoadingPlaceholder = ({ scope }: LoadingPlaceholderProps) => (
  <Box
    role="status"
    sx={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 1.5,
      height: scope === "panel" ? "100%" : "100vh",
      width: "100%",
      color: "text.secondary",
    }}
  >
    <CircularProgress size={18} />
    <Typography variant="body2">Loading…</Typography>
  </Box>
);
