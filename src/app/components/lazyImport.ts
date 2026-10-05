import { lazy, useSyncExternalStore, type ComponentType, type LazyExoticComponent } from "react";

const failedImports = new WeakSet<object>();

/** True when `error` is what a lazyImport component failed with: its code could not be loaded. */
export const isFailedImport = (error: unknown): boolean =>
  typeof error === "object" && error !== null && failedImports.has(error);

/**
 * React.lazy for the pages, panels and dialogs that are downloaded when they are first
 * shown. The server is the emulator, which can be closed and started again while the page
 * stays open, so such a download can fail. The browser then remembers the module as failed
 * for as long as the document lives: importing it again does not ask the server again
 * (measured with Chromium 153), so the code can only arrive with a reload of the page.
 * The failure is marked here, and whoever shows it offers that reload (ReloadPageButton).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the constraint of React.lazy itself
export const lazyImport = <T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> =>
  lazy(() =>
    load().then(
      (module) => {
        // in a task of its own: after React has taken the module from this promise
        setTimeout(announceArrival, 0);
        return module;
      },
      (reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        failedImports.add(error);
        throw error;
      },
    ),
  );

// React shows a lazy component with a retry of its Suspense boundary, a render that every
// state update interrupts and that never expires. While a debugger server runs, a tick
// updates the store five times a second, and a panel that takes longer than the gap
// between two ticks to render (the SH4 simulator) stayed at "Loading..." until the target
// was paused. A boundary that uses useLazyImportArrivals renders once more when the code of
// any lazy component has arrived; that render is an ordinary update, which is not interrupted.
let arrivals = 0;
const arrivalListeners = new Set<() => void>();

const announceArrival = () => {
  arrivals++;
  Array.from(arrivalListeners).forEach((listener) => listener());
};

const subscribeToArrivals = (listener: () => void) => {
  arrivalListeners.add(listener);
  return () => {
    arrivalListeners.delete(listener);
  };
};

const arrivalCount = () => arrivals;

/** Renders the calling component again whenever the code of a lazyImport component has been loaded. */
export const useLazyImportArrivals = (): number => useSyncExternalStore(subscribeToArrivals, arrivalCount);
