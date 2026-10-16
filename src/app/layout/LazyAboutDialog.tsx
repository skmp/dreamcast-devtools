import { Component, Suspense, useCallback, useState, type ReactNode } from "react";
import { Box, Button, Typography } from "@mui/material";
import { isFailedImport, lazyImport } from "../components/lazyImport";
import { ReloadPageButton } from "../components/ReloadPageButton";

const AboutDialog = lazyImport(() => import("./AboutDialog").then((module) => ({ default: module.AboutDialog })));

interface DialogContainmentProps {
  onError: (error: Error) => void;
  children: ReactNode;
}

/**
 * Keeps a failure of the dialog (usually: its code could not be downloaded) away from the
 * error boundary of the page, which would replace the whole page with it.
 */
class DialogContainment extends Component<DialogContainmentProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error instanceof Error ? error : new Error(String(error)));
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface LazyAboutDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The About dialog, loaded when it is first opened. It reads the session store, which
 * brings the debugger client and the protocol schemas with it; pages that never connect
 * (home, docs, the tools) should not pay for those up front.
 *
 * When the dialog fails, it is closed and the error is shown as a notice on the page,
 * which keeps working. When its code could not be downloaded, the notice offers to reload
 * the page (see lazyImport).
 */
export const LazyAboutDialog = ({ open, onClose }: LazyAboutDialogProps) => {
  const [requested, setRequested] = useState(open);
  const [wasOpen, setWasOpen] = useState(open);
  const [failure, setFailure] = useState<Error | null>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      // every opening is a new attempt
      setRequested(true);
      setFailure(null);
    }
  }

  const handleError = useCallback(
    (error: Error) => {
      setRequested(false);
      setFailure(error);
      onClose();
    },
    [onClose],
  );

  return (
    <>
      {requested && (
        <DialogContainment onError={handleError}>
          <Suspense fallback={null}>
            <AboutDialog open={open} onClose={onClose} />
          </Suspense>
        </DialogContainment>
      )}
      {failure && (
        <Box
          role="alert"
          data-about-failure
          sx={{
            position: "fixed",
            bottom: 16,
            right: 16,
            zIndex: 9999,
            maxWidth: "min(560px, calc(100vw - 32px))",
            p: 1.5,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 1,
            borderRadius: 1,
            boxShadow: 6,
            bgcolor: "error.main",
            color: "error.contrastText",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, width: "100%" }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              The About dialog could not be opened
            </Typography>
            <Button size="small" color="inherit" onClick={() => setFailure(null)}>
              Dismiss
            </Button>
          </Box>
          <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-word" }}>
            {failure.name}: {failure.message}
          </Typography>
          {isFailedImport(failure) && (
            <>
              <Typography variant="body2">
                Its code could not be downloaded. Reload the page when the server (the emulator) is running again.
              </Typography>
              <ReloadPageButton variant="outlined" size="small" color="inherit" />
            </>
          )}
        </Box>
      )}
    </>
  );
};
