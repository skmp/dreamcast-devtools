import { useEffect, useState } from "react";

// Crash-test hook for the end-to-end suite. It is only active when the page was loaded
// with ?crashTest in its query string (before the #route); without it nothing listens.
// With it, dispatching
//   new CustomEvent("nulldc:crash-test", { detail: { target: "panel:watches", phase: "render" } })
// on window makes the probe with that testId throw, either while rendering ("render") or
// from an effect ("effect"), so that the error boundary around it has something to catch.
const CRASH_TEST_EVENT = "nulldc:crash-test";
const crashTestEnabled =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("crashTest");

type CrashPhase = "render" | "effect";

const ActiveCrashProbe = ({ testId }: { testId: string }) => {
  const [phase, setPhase] = useState<CrashPhase | null>(null);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string; phase?: string } | undefined>).detail;
      if (detail?.target === testId) {
        setPhase(detail.phase === "effect" ? "effect" : "render");
      }
    };
    window.addEventListener(CRASH_TEST_EVENT, listener);
    return () => window.removeEventListener(CRASH_TEST_EVENT, listener);
  }, [testId]);

  useEffect(() => {
    if (phase === "effect") {
      throw new Error(`crash test: effect (${testId})`);
    }
  }, [phase, testId]);

  if (phase === "render") {
    throw new Error(`crash test: render (${testId})`);
  }
  return null;
};

/** Rendered by every ErrorBoundary next to its children. Inert unless ?crashTest is set. */
export const CrashProbe = ({ testId }: { testId: string }) =>
  crashTestEnabled ? <ActiveCrashProbe testId={testId} /> : null;
