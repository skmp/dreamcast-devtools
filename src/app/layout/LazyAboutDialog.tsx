import { lazy, Suspense, useState } from "react";

const AboutDialog = lazy(() => import("./AboutDialog").then((module) => ({ default: module.AboutDialog })));

interface LazyAboutDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The About dialog, loaded when it is first opened. It reads the session store, which
 * brings the debugger client and the protocol schemas with it; pages that never connect
 * (home, docs, the tools) should not pay for those up front.
 */
export const LazyAboutDialog = ({ open, onClose }: LazyAboutDialogProps) => {
  const [requested, setRequested] = useState(open);
  if (open && !requested) {
    setRequested(true);
  }
  if (!requested) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <AboutDialog open={open} onClose={onClose} />
    </Suspense>
  );
};
