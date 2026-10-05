import { Suspense, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingPlaceholder } from "../components/LoadingPlaceholder";

interface RouteBoundaryProps {
  /** Page name for the error heading. */
  name: string;
  /** Crash-test id: the boundary answers to "route:<id>". */
  id: string;
  children: ReactNode;
}

/**
 * Frame of one route: an error boundary and the placeholder shown while the route's code
 * is loaded. An exception outside the dock panels (the workspace frame, a tool page, ...)
 * replaces that page only; navigating to another path dismisses it.
 */
export const RouteBoundary = ({ name, id, children }: RouteBoundaryProps) => {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary scope="route" name={name} testId={`route:${id}`} resetKey={pathname}>
      <Suspense fallback={<LoadingPlaceholder scope="page" />}>{children}</Suspense>
    </ErrorBoundary>
  );
};
