import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebuggerClient } from "../services/debuggerClient";
import { FakeTransport } from "../services/test-support/fakeTransport";
import { useDebuggerDataStore } from "./debuggerDataStore";

// The store against a transport the test plays the server on: what it sends and when, and
// what a tick, an answer and a broken message do to it.

const unmuted = { muted: false, soloed: false };
const CATEGORIES = { events: unmuted, sh4: unmuted, arm7: unmuted, dsp: unmuted };

const describeResult = (extra: Record<string, unknown> = {}) => ({
  emulator: { name: "nullDC", version: "3.0.0", build: "native" },
  protocol: 3,
  ui: "none",
  capabilities: ["event-breakpoints", "callstack"],
  targets: [],
  deviceTree: [
    {
      path: "dc",
      label: "Dreamcast",
      description: "",
      events: ["dc.system.reset"],
      children: [{ path: "dc.sh4.cpu", label: "Core", description: "", registers: [{ name: "PC", value: "0x8C0000A0", width: 32 }] }],
    },
  ],
  ...extra,
});

let tickId = 0;
const tickFrame = (execution: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  method: "event.tick",
  params: {
    tickId: tickId++,
    timestamp: 1,
    executionState: execution,
    registers: {},
    breakpoints: {},
    eventLog: [],
    watches: [],
    callstacks: { sh4: [], arm7: [] },
    categories: CATEGORIES,
    ...extra,
  },
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const connect = () => {
  const transport = new FakeTransport();
  const client = new DebuggerClient({ mode: "native", endpoint: "ws://test/ws", transport, clientName: "unit test" });
  return { transport, client };
};

/** Initialises the store on a new connection; the server answers debugger.describe and sends `first`. */
const initialise = async (first: unknown = tickFrame({ state: "paused", stopId: 1, reason: "pause" }), shape: unknown = describeResult()) => {
  const { transport, client } = connect();
  const done = useDebuggerDataStore.getState().initialize(client);
  transport.respond(shape);
  transport.deliver(first);
  await done;
  return { transport, client };
};

const store = () => useDebuggerDataStore.getState();
const pc = (value: string) => [{ name: "PC", value, width: 32 }];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  store().reset();
  useDebuggerDataStore.setState({ toasts: [] });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("initialize", () => {
  it("listens for ticks before it sends debugger.describe: the tick that follows the response in the same turn is applied", async () => {
    const { transport, client } = connect();
    const epoch = store().epoch;
    const done = store().initialize(client);
    expect(transport.sent.map((frame) => frame.method)).toEqual(["debugger.describe"]);
    // response and tick are delivered back to back, before the code after `await describe()` runs
    transport.respond(describeResult());
    transport.deliver(tickFrame({ state: "paused", stopId: 3, reason: "start" }, { registers: { "dc.sh4.cpu": pc("0xA0000000") } }));
    expect(store().ticks).toBe(1);
    await done;

    expect(store().initialized).toBe(true);
    // every connection that is initialised is a new epoch: what belongs to one is keyed on it
    expect(store().epoch).toBe(epoch + 1);
    expect(store().executionState).toEqual({ state: "paused", stopId: 3, reason: "start" });
    expect(store().registersByPath).toEqual({ "dc.sh4.cpu": pc("0xA0000000") });
    expect(store().stop).toMatchObject({ serial: 1, stopId: 3 });
    expect(store().availableEvents).toEqual(["dc.system.reset"]);
  });

  it("a tick that arrives before the response (the periodic one of a running server) is applied too", async () => {
    const { transport, client } = connect();
    const done = store().initialize(client);
    transport.deliver(tickFrame({ state: "running", stopId: 0 }, { registers: { "dc.sh4.cpu": pc("0x8C0000A4") } }));
    expect(store().initialized).toBe(false);
    transport.respond(describeResult());
    await done;
    expect(store().ticks).toBe(1);
    expect(store().first?.registers).toEqual({ "dc.sh4.cpu": pc("0x8C0000A4") });
  });

  it("clears the registers, the callstack and the stop of the connection before", async () => {
    await initialise(
      tickFrame(
        { state: "paused", stopId: 9, reason: "breakpoint", breakpointId: 1 },
        {
          registers: { "dc.sh4.cpu": pc("0x8C0000A6"), "dc.sh4.tmu": [{ name: "TCNT0", value: "0x1", width: 32 }] },
          callstacks: { sh4: [{ index: 0, pc: 0x8c0000a6 }], arm7: [] },
          breakpoints: { "1": { id: 1, event: "dc.sh4.cpu.pc", address: 0x8c0000a6, kind: "code", enabled: true } },
          categories: { ...CATEGORIES, sh4: { muted: true, soloed: false } },
        },
      ),
    );
    expect(store().stop?.stopId).toBe(9);
    expect(store().categories.sh4.muted).toBe(true);
    const epoch = store().epoch;

    // the next connection: nothing has arrived yet
    const { transport, client } = connect();
    const done = store().initialize(client);
    expect(store().initialized).toBe(false);
    expect(store().registersByPath).toEqual({});
    expect(store().callstacks).toEqual({});
    expect(store().breakpoints).toEqual([]);
    expect(store().stop).toBeUndefined();
    expect(store().categories.sh4.muted).toBe(false);
    expect(store().ticks).toBe(0);
    transport.respond(describeResult());
    // its first tick has the same stopId as the old connection's last: still its first stop
    transport.deliver(tickFrame({ state: "paused", stopId: 9, reason: "pause" }));
    await done;
    expect(store().epoch).toBe(epoch + 1);
    expect(store().stop).toMatchObject({ serial: 1, stopId: 9 });
  });

  it("ticks of a connection that was replaced are ignored", async () => {
    const old = await initialise();
    await initialise(tickFrame({ state: "running", stopId: 5 }));
    old.transport.deliver(tickFrame({ state: "paused", stopId: 77, reason: "pause" }));
    expect(store().executionState).toEqual({ state: "running", stopId: 5 });
  });

  it("a debugger.describe that fails is said, and leaves the store empty", async () => {
    const { transport, client } = connect();
    const done = store().initialize(client);
    transport.respondError(-32603, "internal error");
    await done;
    expect(store().initialized).toBe(false);
    expect(store().initError).toBe("debugger.describe failed: internal error");

    // a result that does not validate names what is wrong
    const second = connect();
    const again = store().initialize(second.client);
    expect(store().initError).toBeUndefined();
    second.transport.respond({ emulator: { name: "x", build: "native" }, deviceTree: [] });
    await again;
    expect(store().initError).toMatch(/^debugger\.describe failed: Response validation failed for debugger\.describe: emulator\.version: /);
    expect(store().invalidMessages).toMatchObject({ count: 1, last: { kind: "response", method: "debugger.describe" } });
  });

  it("reset() forgets the connection: no client, no data, and nothing of it is applied afterwards", async () => {
    const { transport } = await initialise(tickFrame({ state: "paused", stopId: 1, reason: "pause" }, { registers: { "dc.sh4.cpu": pc("0x1") } }));
    store().reset();
    expect(store().initialized).toBe(false);
    expect(store().client).toBeUndefined();
    expect(store().registersByPath).toEqual({});
    expect(store().deviceTree).toEqual([]);
    expect(store().executionState).toBeUndefined();
    transport.deliver(tickFrame({ state: "running", stopId: 1 }));
    expect(store().ticks).toBe(0);
  });
});

describe("ticks", () => {
  it("announce the breakpoint of a new stop once, in the address format of its target", async () => {
    vi.useFakeTimers();
    const hit = { state: "paused", stopId: 2, reason: "breakpoint", breakpointId: 4 };
    const breakpoints = { "4": { id: 4, event: "dc.aica.dsp.step", address: 5, kind: "code", enabled: true } };
    const { transport } = await initialise(tickFrame({ state: "running", stopId: 1 }));
    expect(store().toasts).toEqual([]);

    transport.deliver(tickFrame(hit, { breakpoints }));
    transport.deliver(tickFrame(hit, { breakpoints }));
    expect(store().toasts.map(({ type, message }) => ({ type, message }))).toEqual([
      { type: "warning", message: "Breakpoint hit: dc.aica.dsp.step == 005" },
    ]);
    // the notice goes away by itself
    await vi.advanceTimersByTimeAsync(5000);
    expect(store().toasts).toEqual([]);
  });

  it("a subscriber that throws on a tick does not keep it from the subscribers after it, or its breakpoint from being announced", async () => {
    const { transport } = await initialise(tickFrame({ state: "running", stopId: 1 }));

    // subscribers are called in the order in which they subscribed; the first fails once for every stop
    const failed = new Set<number>();
    const unsubscribeFirst = useDebuggerDataStore.subscribe((state) => {
      const stopId = state.executionState?.stopId;
      if (stopId !== undefined && stopId > 1 && !failed.has(stopId)) {
        failed.add(stopId);
        throw new Error("Maximum update depth exceeded");
      }
    });
    const heard: Array<number | undefined> = [];
    const unsubscribeSecond = useDebuggerDataStore.subscribe((state) => heard.push(state.executionState?.stopId));

    // a stop that nothing else follows: the subscriber after the one that threw is told of it all the same
    const step = { state: "paused", stopId: 2, reason: "step" };
    expect(() => transport.deliver(tickFrame(step))).not.toThrow();
    expect(store().executionState).toEqual(step);
    expect(heard).toEqual([2]);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "A subscriber of the debugger data failed on a tick",
      expect.objectContaining({ message: "Maximum update depth exceeded" }),
    );

    // a stop at a breakpoint: the tick is handled to its end
    const hit = { state: "paused", stopId: 3, reason: "breakpoint", breakpointId: 4 };
    const breakpoints = { "4": { id: 4, event: "dc.sh4.cpu.pc", address: 0x8c0000a6, kind: "code", enabled: true } };
    transport.deliver(tickFrame(hit, { breakpoints }));
    expect(store().toasts.map((toast) => toast.message)).toEqual(["Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6"]);
    expect(console.error).toHaveBeenCalledTimes(2);

    // the tick after it is an ordinary one
    transport.deliver(tickFrame({ state: "running", stopId: 3 }));
    expect(store().executionState?.state).toBe("running");
    expect(console.error).toHaveBeenCalledTimes(2);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("a tick that fails validation is dropped and counted, with the place that is wrong; the next good one is applied", async () => {
    const { transport } = await initialise();
    const bad = tickFrame({ state: "running", stopId: 1 });
    (bad.params as Record<string, unknown>).eventLog = [{ eventId: "1", timestamp: 1, subsystem: 5, severity: "info", message: "x" }];
    transport.deliver(bad);
    transport.deliver(bad);
    expect(store().executionState?.state).toBe("paused");
    expect(store().invalidMessages?.count).toBe(2);
    expect(store().invalidMessages?.last).toMatchObject({ kind: "notification", method: "event.tick", issues: [{ path: "eventLog.0.subsystem" }] });
    expect(store().invalidMessages?.last.message).toContain("event.tick: eventLog.0.subsystem:");

    transport.deliver(tickFrame({ state: "running", stopId: 1 }));
    expect(store().executionState?.state).toBe("running");
    store().dismissInvalidMessages();
    expect(store().invalidMessages).toBeUndefined();
  });
});

describe("notices", () => {
  const shown = () => store().toasts.map(({ type, message, count }) => `${type}: ${message} x${count}`);

  it("a notice that repeats one that is up is counted in it, and the notice stays five seconds from the last time", async () => {
    vi.useFakeTimers();
    for (let index = 0; index < 200; index++) {
      store().showError("Step: cannot step: undefined opcode");
    }
    expect(shown()).toEqual(["error: Step: cannot step: undefined opcode x200"]);
    const { id } = store().toasts[0];

    // another text is another notice; the first one goes on counting, wherever it is in the list
    await vi.advanceTimersByTimeAsync(3000);
    store().showError("Run: emulator busy");
    store().showError("Step: cannot step: undefined opcode");
    expect(shown()).toEqual(["error: Step: cannot step: undefined opcode x201", "error: Run: emulator busy x1"]);
    expect(store().toasts[0].id).toBe(id);

    // five seconds after it was first raised it is still up: it was raised again two seconds ago
    await vi.advanceTimersByTimeAsync(2500);
    expect(shown()).toEqual(["error: Step: cannot step: undefined opcode x201", "error: Run: emulator busy x1"]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(shown()).toEqual([]);

    // once it is gone, the same text is a new notice
    store().showError("Step: cannot step: undefined opcode");
    expect(shown()).toEqual(["error: Step: cannot step: undefined opcode x1"]);
    expect(store().toasts[0].id).not.toBe(id);
  });

  it("an error and a warning with the same text are two notices; one that is put away starts again at one", async () => {
    const { transport } = await initialise(tickFrame({ state: "running", stopId: 1 }));
    const breakpoints = { "4": { id: 4, event: "dc.sh4.cpu.pc", address: 0x8c0000a6, kind: "code", enabled: true } };
    const hit = (stopId: number) => tickFrame({ state: "paused", stopId, reason: "breakpoint", breakpointId: 4 }, { breakpoints });
    // the same breakpoint, hit by three stops in a row
    transport.deliver(hit(2));
    transport.deliver(hit(3));
    transport.deliver(hit(4));
    store().showError("Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6");
    expect(shown()).toEqual([
      "warning: Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6 x3",
      "error: Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6 x1",
    ]);

    store().dismissToast(store().toasts[0].id);
    transport.deliver(hit(5));
    expect(shown()).toEqual([
      "error: Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6 x1",
      "warning: Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6 x1",
    ]);
  });
});

describe("watches", () => {
  it("are sent in lower case, and not sent when the server has the expression", async () => {
    const { transport } = await initialise(
      tickFrame({ state: "paused", stopId: 1, reason: "pause" }, { watches: [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x1" }] }),
    );
    const before = transport.sent.length;
    await store().addWatch("DC.SH4.CPU.PC");
    await store().addWatch("  dc.sh4.cpu.Pc ");
    await store().addWatch("   ");
    expect(transport.sent).toHaveLength(before);

    const adding = store().addWatch(" dc.sh4.cpu.VBR ");
    expect(transport.sent.at(-1)).toMatchObject({ method: "state.watch", params: { expressions: ["dc.sh4.cpu.vbr"] } });
    transport.respond({});
    await adding;
    expect(store().toasts).toEqual([]);
  });

  it("an expression the server refuses is said", async () => {
    const { transport } = await initialise();
    const adding = store().addWatch("dc.nothing.here");
    transport.respond({ error: { code: -32602, message: 'invalid params: "dc.nothing.here" is not a register of the device tree' } });
    await adding;
    expect(store().toasts.map((toast) => toast.message)).toEqual(['invalid params: "dc.nothing.here" is not a register of the device tree']);
  });

  it("a refused edit is said once, and rejects, so that the editor stays open", async () => {
    const { transport } = await initialise(
      tickFrame({ state: "paused", stopId: 1, reason: "pause" }, { watches: [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x1" }] }),
    );
    const editing = store().editWatch(1, "0x2");
    transport.respond({ error: { code: -32004, message: "not supported: state.editWatch" } });
    await expect(editing).rejects.toThrow("not supported: state.editWatch");
    expect(store().toasts.map((toast) => toast.message)).toEqual(["not supported: state.editWatch"]);
  });
});

describe("category states", () => {
  it("a click sends all four states, shows them at once, and the tick has the last word", async () => {
    const { transport } = await initialise();
    const muting = store().toggleCategoryMute("sh4");
    expect(store().categories.sh4).toEqual({ muted: true, soloed: false });
    expect(transport.sent.at(-1)).toMatchObject({
      method: "breakpoints.setCategoryStates",
      params: { categories: { events: unmuted, sh4: { muted: true, soloed: false }, arm7: unmuted, dsp: unmuted } },
    });
    transport.respond({});
    await muting;

    // somebody else moves the solo to ARM7 and unmutes SH4: the tick says so
    transport.deliver(tickFrame({ state: "paused", stopId: 1, reason: "pause" }, { categories: { ...CATEGORIES, arm7: { muted: false, soloed: true } } }));
    expect(store().categories).toEqual({ ...CATEGORIES, arm7: { muted: false, soloed: true } });

    const soloing = store().toggleCategorySolo("dsp");
    expect(transport.sent.at(-1)?.params).toEqual({ categories: { ...CATEGORIES, dsp: { muted: false, soloed: true } } });
    transport.respond({});
    await soloing;
  });

  it("a refusal is said and the state goes back to what it was", async () => {
    const { transport } = await initialise();
    const muting = store().toggleCategoryMute("events");
    transport.respond({ error: { code: -32000, message: "emulator busy" } });
    await muting;
    expect(store().categories.events).toEqual(unmuted);
    expect(store().toasts.map((toast) => toast.message)).toEqual(["emulator busy"]);
  });
});

describe("run control", () => {
  it("sends the request of each action, with its target", async () => {
    const { transport } = await initialise();
    for (const [action, target, method, params] of [
      ["run", undefined, "control.runUntil", {}],
      ["pause", "sh4", "control.pause", { target: "sh4" }],
      ["step", "arm7", "control.step", { target: "arm7" }],
      ["stepOver", "sh4", "control.stepOver", { target: "sh4" }],
      ["stepOut", "dsp", "control.stepOut", { target: "dsp" }],
    ] as const) {
      const done = store().control(action, target);
      expect(transport.sent.at(-1)).toMatchObject({ method, params });
      transport.respond({});
      await expect(done).resolves.toBe(true);
    }
    expect(store().toasts).toEqual([]);
  });

  // The server refuses in one of two ways: in the result (`{ error }`, the in-band channel of
  // the methods whose success is {}) or with a JSON-RPC error. Every action reads both.
  it.each([
    ["run", undefined, "Run"],
    ["pause", "sh4", "Pause"],
    ["step", "sh4", "Step"],
    ["stepOver", "arm7", "Step over"],
    ["stepOut", "sh4", "Step out"],
  ] as const)("%s: an in-band error and a JSON-RPC error are both shown, and resolve to false", async (action, target, label) => {
    const { transport } = await initialise();
    const refused = store().control(action, target);
    transport.respond({ error: { code: -32005, message: "refused in the result" } });
    await expect(refused).resolves.toBe(false);
    expect(store().toasts.map(({ type, message }) => `${type}: ${message}`)).toEqual([`error: ${label}: refused in the result`]);

    const failed = store().control(action, target);
    transport.respondError(-32603, "internal error");
    await expect(failed).resolves.toBe(false);
    expect(store().toasts.map(({ type, message }) => `${type}: ${message}`)).toEqual([
      `error: ${label}: refused in the result`,
      `error: ${label}: internal error`,
    ]);
  });

  it("shows a lost connection, and resolves to false", async () => {
    const { transport } = await initialise();
    const lost = store().control("pause", "sh4");
    transport.close();
    await expect(lost).resolves.toBe(false);
    await settle();

    expect(store().toasts.map(({ type, message }) => `${type}: ${message}`)).toEqual([
      "error: Pause: Connection closed before control.pause was answered",
    ]);
  });

  it("does nothing without a connection", async () => {
    await expect(store().control("run")).resolves.toBe(false);
    expect(store().toasts).toEqual([]);
  });
});
