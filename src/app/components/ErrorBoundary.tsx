import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Box, Button, Typography } from "@mui/material";
import { CrashProbe } from "./CrashProbe";
import { isFailedImport } from "./lazyImport";
import { ReloadPageButton } from "./ReloadPageButton";

interface ErrorBoundaryProps {
  /** "panel" fills a dock panel, "route" fills the page. */
  scope: "panel" | "route";
  /** What failed, for the heading: the panel title or the page name. */
  name: string;
  /** Identifies the boundary to the crash-test hook (see CrashProbe), e.g. "panel:watches". */
  testId: string;
  /** The error is dismissed when this value changes (routes pass the current path). */
  resetKey?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  /** Incremented by "reload": remounts the children from scratch. */
  generation: number;
}

/**
 * Contains an exception thrown while rendering or in an effect of its children: the
 * children are replaced by the error (message, component stack) and a reload button,
 * and everything outside the boundary keeps running.
 *
 * The reload button mounts the children again. When they failed because their code could
 * not be downloaded (see lazyImport), mounting them again cannot help, and the button
 * reloads the page instead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, generation: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(_error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.reload();
    }
  }

  private reload = () => {
    this.setState((state) => ({ error: null, componentStack: null, generation: state.generation + 1 }));
  };

  render() {
    const { scope, name, testId, children } = this.props;
    const { error, componentStack, generation } = this.state;

    if (!error) {
      return (
        <Fragment key={generation}>
          {children}
          <CrashProbe testId={testId} />
        </Fragment>
      );
    }

    const isPanel = scope === "panel";
    const failedImport = isFailedImport(error);
    return (
      <Box
        role="alert"
        data-error-boundary={testId}
        sx={{
          boxSizing: "border-box",
          height: isPanel ? "100%" : "auto",
          minHeight: isPanel ? 0 : "100vh",
          width: "100%",
          overflow: "auto",
          p: 2,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 1.5,
          bgcolor: "background.paper",
          color: "text.primary",
        }}
      >
        <Typography variant="subtitle2" component="h2" color="error" sx={{ fontWeight: 600 }}>
          {isPanel ? `The ${name} panel failed` : `The ${name} page failed`}
        </Typography>
        <Typography variant="body2" sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {error.name}: {error.message}
        </Typography>
        {failedImport ? (
          <>
            <Typography variant="body2">
              The code of this {isPanel ? "panel" : "page"} could not be downloaded. Reload the page when the server (the
              emulator) is running again.
            </Typography>
            <ReloadPageButton variant="outlined" size="small" />
          </>
        ) : (
          <Button variant="outlined" size="small" onClick={this.reload}>
            {isPanel ? "Reload panel" : "Reload page"}
          </Button>
        )}
        <Box component="details" sx={{ width: "100%", typography: "body2" }}>
          <Box component="summary" sx={{ cursor: "pointer", color: "text.secondary" }}>
            Component stack
          </Box>
          <Box
            component="pre"
            sx={{ m: 0, mt: 1, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {componentStack?.trim() || "Not available."}
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary">
          {isPanel
            ? "Only this panel stopped. The other panels and the connection are not affected."
            : "Only this page stopped. The rest of the application is not affected."}
        </Typography>
      </Box>
    );
  }
}
