import { AppBar, Box } from "@mui/material";
import { TopNav } from "./TopNav";
import { LazyAboutDialog } from "./LazyAboutDialog";
import { useAboutModal } from "./useAboutModal";
import { CoreInspectorPanel } from "../panels/CoreInspectorPanel";

export const Clx2CoreLogAnalyzerPage = () => {
  const { open: aboutOpen, show: showAbout, hide: hideAbout } = useAboutModal();

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" elevation={1} color="default">
        <TopNav
          onAboutClick={showAbout}
          currentPage="core-log-analyzer"
        />
      </AppBar>
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <CoreInspectorPanel />
      </Box>
      <LazyAboutDialog open={aboutOpen} onClose={hideAbout} />
    </Box>
  );
};
