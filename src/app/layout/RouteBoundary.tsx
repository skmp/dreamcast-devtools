import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ErrorBoundary } from "../components/ErrorBoundary";

interface RouteBoundaryProps {
  /** Page name for the error heading. */
  name: string;
  /** Crash-test id: the boundary answers to "route:<id>". */
  id: string;
  children: ReactNode;
}

/**
 * Error boundary of one route. An exception outside the dock panels (the workspace frame,
 * a tool page, ...) replaces that page only; navigating to another path dismisses it.
 */
export const RouteBoundary = ({ name, id, children }: RouteBoundaryProps) => {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary scope="route" name={name} testId={`route:${id}`} resetKey={pathname}>
      {children}
    </ErrorBoundary>
  );
};
