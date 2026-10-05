import { lazy, type ComponentType, type LazyExoticComponent } from "react";

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
    load().catch((reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      failedImports.add(error);
      throw error;
    }),
  );
