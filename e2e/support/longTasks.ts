import type { Page } from "@playwright/test";

/**
 * Records for how long the main thread of the page was blocked. The browser reports every
 * task of 50 ms or more (PerformanceObserver "longtask"): an event handler together with the
 * rendering React does in it, or the style and layout work of a frame.
 */
declare global {
  interface Window {
    __longTasks: number[];
  }
}

export const installLongTaskRecorder = async (page: Page) => {
  await page.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longTasks.push(Math.round(entry.duration));
      }
    }).observe({ entryTypes: ["longtask"] });
  });
};

/** Durations in ms of the long tasks since the last call. Empty when no task took 50 ms. */
export const takeLongTasks = (page: Page): Promise<number[]> => page.evaluate(() => window.__longTasks.splice(0));
