import { create } from "zustand";
import type {
  BreakpointCategory,
  BreakpointDescriptor,
  DebuggerShape,
  DebuggerTick,
  DeviceNodeDescriptor,
  RpcError,
  TargetProcessor,
} from "../lib/debuggerSchema";
import type { DebuggerClient } from "../services/debuggerClient";
import type { InvalidMessageReport } from "../services/jsonRpcClient";
import { toggleMuted, toggleSoloed } from "./breakpointCategoryState";
import { describeBreakpoint } from "./targets";
import { applyTick, emptyLiveState } from "./tickState";
import type { CategoryStates, LiveState } from "./tickState";

/** A notice in the corner of a workspace; it goes away by itself. */
export interface Toast {
  id: number;
  type: "error" | "warning";
  message: string;
  /** how often it was raised while it was up: a notice that is on screen is counted, not shown again */
  count: number;
}

/** Messages of the server that the client could not use and dropped. */
export interface InvalidMessages {
  count: number;
  last: InvalidMessageReport;
}

export type ControlAction = "run" | "pause" | "step" | "stepOver" | "stepOut";

const CONTROL_LABELS: Record<ControlAction, string> = {
  run: "Run",
  pause: "Pause",
  step: "Step",
  stepOver: "Step over",
  stepOut: "Step out",
};

const TOAST_MS = 5000;

interface DebuggerDataState extends LiveState {
  /** debugger.describe of the current connection has been answered */
  initialized: boolean;
  /** counts the connections that were initialised; what belongs to one connection is keyed on it */
  epoch: number;
  client?: DebuggerClient;
  shape?: DebuggerShape;
  deviceTree: DeviceNodeDescriptor[];
  availableEvents: string[];
  /** why debugger.describe of the current connection failed */
  initError?: string;
  invalidMessages?: InvalidMessages;
  toasts: Toast[];
  // Methods
  initialize: (client: DebuggerClient) => Promise<void>;
  reset: () => void;
  addWatch: (expression: string) => Promise<void>;
  removeWatch: (watchId: number) => Promise<void>;
  editWatch: (watchId: number, value: string) => Promise<void>;
  modifyWatchExpression: (watchId: number, newExpression: string) => Promise<void>;
  addBreakpoint: (event: string, address?: number, kind?: BreakpointDescriptor["kind"]) => Promise<void>;
  removeBreakpoint: (id: number) => Promise<void>;
  toggleBreakpoint: (id: number, enabled: boolean) => Promise<void>;
  toggleCategoryMute: (category: BreakpointCategory) => Promise<void>;
  toggleCategorySolo: (category: BreakpointCategory) => Promise<void>;
  /** A run-control request. Resolves to false, after showing why, when the server refused it or did not answer. */
  control: (action: ControlAction, target?: TargetProcessor) => Promise<boolean>;
  showError: (message: string) => void;
  dismissToast: (id: number) => void;
  dismissInvalidMessages: () => void;
}

// Helper function to collect all events from device tree
const collectEventsFromTree = (nodes: DeviceNodeDescriptor[]): string[] => {
  const events: string[] = [];
  for (const node of nodes) {
    if (node.events) {
      events.push(...node.events);
    }
    if (node.children) {
      events.push(...collectEventsFromTree(node.children));
    }
  }
  return events;
};

const messageOf = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

/** Identifies the connection that `initialize` was last called for; what an older one still delivers is ignored. */
let generation = 0;
let unsubscribe: (() => void) | undefined;
let nextToastId = 1;
/** what takes each notice away again, by its id */
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const useDebuggerDataStore = create<DebuggerDataState>()((set, get) => {
  // A notice that says what one on screen says is not put next to it: that one counts it, and
  // stays for another five seconds. A refusal that is repeated (a step button held down on a
  // target that cannot step, a breakpoint hit again and again) would otherwise put up a notice
  // each time, and two hundred of them cover the page.
  const notify = (type: Toast["type"], message: string) => {
    const shown = get().toasts.find((toast) => toast.type === type && toast.message === message);
    const id = shown ? shown.id : nextToastId++;
    set((state) => ({
      toasts: shown
        ? state.toasts.map((toast) => (toast.id === id ? { ...toast, count: toast.count + 1 } : toast))
        : [...state.toasts, { id, type, message, count: 1 }],
    }));
    clearTimeout(toastTimers.get(id));
    toastTimers.set(
      id,
      setTimeout(() => get().dismissToast(id), TOAST_MS),
    );
  };

  /**
   * Puts the state of a tick into the store. The store replaces its state and then calls its
   * subscribers in turn. When one of them throws (React does when it is asked for a fifty-first
   * render in a row), the ones after it have not heard of the tick and go on showing the one
   * before, and for the tick of a stop there may be no next one to put that right. So the
   * failure is logged instead of ending the tick halfway, and everyone is called once more.
   */
  const publish = (state: LiveState) => {
    try {
      set(state);
    } catch (error) {
      console.error("A subscriber of the debugger data failed on a tick", error);
      try {
        // the same values in a new state object: every subscriber is called again
        set({});
      } catch (again) {
        console.error("A subscriber of the debugger data failed on a tick again", again);
      }
    }
  };

  const handleTick = (tick: DebuggerTick) => {
    const outcome = applyTick(get(), tick);
    publish(outcome.state);
    if (outcome.hit) {
      const text = "event" in outcome.hit ? describeBreakpoint(get().shape, outcome.hit) : `#${outcome.hit.id}`;
      notify("warning", `Breakpoint hit: ${text}`);
    }
  };

  /** Sends new category states. The buttons show them at once; the next tick of a v3 server says what they are. */
  const sendCategories = async (next: CategoryStates) => {
    const { client, categories: previous } = get();
    if (!client) {
      return;
    }
    set({ categories: next });
    try {
      const result = (await client.setCategoryStates(next)) as RpcError;
      if (result.error) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      if (get().categories === next) {
        set({ categories: previous });
      }
      get().showError(messageOf(error, "Failed to change the breakpoint categories"));
    }
  };

  return {
    initialized: false,
    epoch: 0,
    deviceTree: [],
    availableEvents: [],
    toasts: [],
    ...emptyLiveState(),

    async initialize(client) {
      const mine = ++generation;
      unsubscribe?.();
      // nothing of an earlier connection is live any more: its registers and its callstack go too
      set({
        client,
        initialized: false,
        shape: undefined,
        deviceTree: [],
        availableEvents: [],
        initError: undefined,
        invalidMessages: undefined,
        ...emptyLiveState(),
      });

      // Before debugger.describe is sent: the server answers and then sends a full tick, and
      // both can be delivered before the code after `await` runs.
      const unsubscribeTicks = client.onNotification((notification) => {
        if (generation === mine && notification.topic === "tick") {
          handleTick(notification.payload);
        }
      });
      // A message that fails validation never reaches the handlers above. Without this a
      // dropped tick is only visible as a UI that stopped updating.
      const unsubscribeInvalid = client.onInvalidMessage((report) => {
        if (generation === mine) {
          set((state) => ({ invalidMessages: { count: (state.invalidMessages?.count ?? 0) + 1, last: report } }));
        }
      });
      unsubscribe = () => {
        unsubscribeTicks();
        unsubscribeInvalid();
      };

      try {
        const shape = await client.describe();
        if (generation !== mine) {
          return;
        }
        set((state) => ({
          shape,
          deviceTree: shape.deviceTree,
          availableEvents: collectEventsFromTree(shape.deviceTree),
          initialized: true,
          epoch: state.epoch + 1,
        }));
      } catch (error) {
        if (generation !== mine) {
          return;
        }
        console.error("Failed to initialize debugger data", error);
        unsubscribe?.();
        unsubscribe = undefined;
        set({
          initialized: false,
          client: undefined,
          initError: `debugger.describe failed: ${messageOf(error, String(error))}`,
          ...emptyLiveState(),
        });
      }
    },

    reset() {
      generation++;
      unsubscribe?.();
      unsubscribe = undefined;
      // Without a connection nothing on screen is live: the panels say "No Data" instead of
      // showing the last values as if they were.
      set({
        client: undefined,
        initialized: false,
        shape: undefined,
        deviceTree: [],
        availableEvents: [],
        initError: undefined,
        invalidMessages: undefined,
        ...emptyLiveState(),
      });
    },

    async addWatch(expression) {
      // the server stores expressions in lower case, and does not add one it has twice
      const normalised = expression.trim().toLowerCase();
      if (!normalised) {
        return;
      }
      const { client, watches } = get();
      if (!client || watches.some((w) => w.expression === normalised)) {
        return;
      }
      try {
        const result = (await client.watch([normalised])) as RpcError;
        if (result.error) {
          get().showError(result.error.message);
        }
      } catch (error) {
        console.error("Failed to add watch", error);
        get().showError(messageOf(error, "Failed to add watch"));
      }
    },

    async removeWatch(watchId) {
      const { client, watches } = get();
      const watch = watches.find((w) => w.id === watchId);
      if (!client || !watch) {
        return;
      }
      try {
        const result = (await client.unwatch([watchId])) as RpcError;
        if (result.error) {
          get().showError(result.error.message);
        }
      } catch (error) {
        console.error("Failed to remove watch", error);
        get().showError(messageOf(error, "Failed to remove watch"));
      }
    },

    async editWatch(watchId, value) {
      const { client, watches } = get();
      if (!client) {
        const error = new Error("No client connected");
        get().showError(error.message);
        throw error;
      }
      const watch = watches.find((w) => w.id === watchId);
      if (!watch) {
        const error = new Error("Watch not found");
        get().showError(error.message);
        throw error;
      }
      try {
        const result = (await client.editWatch(watchId, value)) as RpcError;
        if (result.error) {
          throw new Error(result.error.message);
        }
      } catch (error) {
        console.error("Failed to edit watch", error);
        get().showError(messageOf(error, "Failed to edit watch"));
        throw error;
      }
    },

    async modifyWatchExpression(watchId, newExpression) {
      const { client, watches } = get();
      if (!client) {
        const error = new Error("No client connected");
        get().showError(error.message);
        throw error;
      }
      const watch = watches.find((w) => w.id === watchId);
      if (!watch) {
        const error = new Error("Watch not found");
        get().showError(error.message);
        throw error;
      }
      try {
        const result = (await client.modifyWatchExpression(watchId, newExpression.trim().toLowerCase())) as RpcError;
        if (result.error) {
          throw new Error(result.error.message);
        }
      } catch (error) {
        console.error("Failed to modify watch expression", error);
        get().showError(messageOf(error, "Failed to modify watch expression"));
        throw error;
      }
    },

    async addBreakpoint(event, address, kind = "code") {
      const trimmed = event.trim();
      if (!trimmed) {
        return;
      }
      const { client } = get();
      if (!client) {
        return;
      }
      try {
        const result = (await client.addBreakpoint(trimmed, address, kind)) as RpcError;
        if (result.error) {
          get().showError(result.error.message);
        }
      } catch (error) {
        console.error("Failed to add breakpoint", error);
        get().showError(messageOf(error, "Failed to add breakpoint"));
      }
    },

    async removeBreakpoint(id) {
      const { client } = get();
      if (!client) {
        return;
      }
      try {
        const result = (await client.removeBreakpoint(id)) as RpcError;
        if (result.error) {
          get().showError(result.error.message);
        }
      } catch (error) {
        console.error("Failed to remove breakpoint", error);
        get().showError(messageOf(error, "Failed to remove breakpoint"));
      }
    },

    async toggleBreakpoint(id, enabled) {
      const { client } = get();
      if (!client) {
        return;
      }
      try {
        const result = (await client.toggleBreakpoint(id, enabled)) as RpcError;
        if (result.error) {
          get().showError(result.error.message);
        }
      } catch (error) {
        console.error("Failed to toggle breakpoint", error);
        get().showError(messageOf(error, "Failed to toggle breakpoint"));
      }
    },

    toggleCategoryMute: (category) => sendCategories(toggleMuted(get().categories, category)),
    toggleCategorySolo: (category) => sendCategories(toggleSoloed(get().categories, category)),

    async control(action, target) {
      const { client } = get();
      if (!client) {
        return false;
      }
      const label = CONTROL_LABELS[action];
      try {
        // every control.* request is answered as soon as it is armed, with {} or with why not;
        // a tick reports what then happened
        const result: RpcError =
          action === "run"
            ? await client.runUntil()
            : action === "pause"
              ? await client.pause(target)
              : action === "step"
                ? await client.step(target ?? "sh4")
                : action === "stepOver"
                  ? await client.stepOver(target ?? "sh4")
                  : await client.stepOut(target ?? "sh4");
        if (result.error) {
          get().showError(`${label}: ${result.error.message}`);
          return false;
        }
        return true;
      } catch (error) {
        get().showError(`${label}: ${messageOf(error, "the request failed")}`);
        return false;
      }
    },

    showError(message) {
      notify("error", message);
    },

    dismissToast(id) {
      clearTimeout(toastTimers.get(id));
      toastTimers.delete(id);
      if (get().toasts.some((toast) => toast.id === id)) {
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
      }
    },

    dismissInvalidMessages() {
      set({ invalidMessages: undefined });
    },
  };
});
