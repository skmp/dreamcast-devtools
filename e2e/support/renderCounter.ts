import type { Page } from "@playwright/test";

/**
 * Counts React component renders in a production build, without help from the app.
 *
 * React calls `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` after every commit when
 * that hook exists before React loads. On each commit the fiber tree is walked the way
 * React DevTools does: a subtree whose `child` pointer is the same object as in the
 * previous tree was skipped by React (bail-out) and is not visited; a component fiber that
 * was visited rendered in this commit when it carries the PerformedWork flag, and was
 * mounted when it has no alternate.
 *
 * Only fibers below the DOM element matched by `scopeSelector` are counted.
 */
export interface RenderCounts {
  /** commits in which at least one counted component rendered or mounted */
  commits: number;
  /** component functions that ran for an update */
  rendered: number;
  /** component instances that were created */
  mounted: number;
  /** milliseconds from the last WebSocket message to the commit that followed it; one entry per such commit */
  messageToCommitMs: number[];
}

declare global {
  interface Window {
    __renderCounter: { counts: RenderCounts; reset: () => void };
  }
}

export const installRenderCounter = async (page: Page, scopeSelector: string) => {
  await page.addInitScript((selector) => {
    const PERFORMED_WORK = 0b1;
    // FunctionComponent, ClassComponent, ForwardRef, MemoComponent, SimpleMemoComponent
    const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
    interface Fiber {
      tag: number;
      flags: number;
      stateNode: unknown;
      alternate: Fiber | null;
      child: Fiber | null;
      sibling: Fiber | null;
    }

    const fresh = (): RenderCounts => ({ commits: 0, rendered: 0, mounted: 0, messageToCommitMs: [] });
    const counter = {
      counts: fresh(),
      reset() {
        counter.counts = fresh();
      },
    };
    window.__renderCounter = counter;

    let lastMessageAt: number | undefined;
    const NativeWebSocket = window.WebSocket;
    const addEventListener = NativeWebSocket.prototype.addEventListener;
    NativeWebSocket.prototype.addEventListener = function (this: WebSocket, type: string, listener: unknown, options?: unknown) {
      if (type === "message" && typeof listener === "function") {
        const wrapped = (event: Event) => {
          lastMessageAt = performance.now();
          (listener as (event: Event) => void).call(this, event);
        };
        return addEventListener.call(this, type, wrapped, options as AddEventListenerOptions);
      }
      return addEventListener.call(this, type, listener as EventListener, options as AddEventListenerOptions);
    };

    const isScope = (fiber: Fiber) => fiber.stateNode instanceof Element && fiber.stateNode.matches(selector);

    const walk = (next: Fiber, previous: Fiber | null, inside: boolean, tally: { rendered: number; mounted: number }) => {
      const nowInside = inside || isScope(next);
      if (nowInside && COMPONENT_TAGS.has(next.tag)) {
        if (!previous) {
          tally.mounted++;
        } else if ((next.flags & PERFORMED_WORK) !== 0) {
          tally.rendered++;
        }
      }
      if (previous && next.child === previous.child) {
        return; // React did not touch this subtree
      }
      for (let child = next.child; child; child = child.sibling) {
        walk(child, previous ? child.alternate : null, nowInside, tally);
      }
    };

    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      setStrictMode: () => undefined,
      checkDCE: () => undefined,
      onCommitFiberRoot: (_rendererId: number, root: { current: Fiber }) => {
        const tally = { rendered: 0, mounted: 0 };
        walk(root.current, root.current.alternate, false, tally);
        if (tally.rendered === 0 && tally.mounted === 0) {
          return;
        }
        counter.counts.commits++;
        counter.counts.rendered += tally.rendered;
        counter.counts.mounted += tally.mounted;
        if (lastMessageAt !== undefined) {
          counter.counts.messageToCommitMs.push(performance.now() - lastMessageAt);
          lastMessageAt = undefined;
        }
      },
    };
  }, scopeSelector);
};

export const resetRenderCounts = (page: Page) => page.evaluate(() => window.__renderCounter.reset());

export const readRenderCounts = (page: Page): Promise<RenderCounts> =>
  page.evaluate(() => structuredClone(window.__renderCounter.counts));
