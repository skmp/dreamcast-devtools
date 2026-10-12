import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebuggerClient } from "../services/debuggerClient";
import { FakeTransport } from "../services/test-support/fakeTransport";
import { useDebuggerDataStore } from "./debuggerDataStore";
import { RECONNECT_DELAYS_MS } from "./sessionController";

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
  // what a server said about itself outlives its connection: not into the next test
  useDebuggerDataStore.setState({ toasts: [], shape: undefined });
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

  describe("after a debugger.describe that failed", () => {
    const describes = (transport: FakeTransport) => transport.sent.filter((request) => request.method === "debugger.describe").length;
    const BUSY = "debugger.describe failed: emulator busy";

    /** A connection whose first debugger.describe the server refused with "emulator busy". */
    const refused = async () => {
      const { transport, client } = connect();
      const done = store().initialize(client);
      transport.respondError(-32000, "emulator busy");
      await done;
      return { transport, client };
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("the server is asked again on the same connection after 1, 2, 5 and then every 10 seconds, until it answers", async () => {
      expect(RECONNECT_DELAYS_MS).toEqual([1000, 2000, 5000, 10_000]);
      const epoch = store().epoch;
      const { transport, client } = await refused();
      expect(store()).toMatchObject({ initialized: false, initError: BUSY, describeRetry: { attempt: 1, delayMs: 1000 } });
      expect(store().client).toBeUndefined();
      expect(describes(transport)).toBe(1);

      // a tick of a server that is not described is not applied
      transport.deliver(tickFrame({ state: "paused", stopId: 1, reason: "pause" }));
      expect(store().ticks).toBe(0);

      const delays = [1000, 2000, 5000, 10_000, 10_000];
      for (const [index, delayMs] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect(describes(transport), `before the ${delayMs} ms are over`).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(describes(transport), `after ${delayMs} ms`).toBe(index + 2);
        expect(transport.sent.at(-1)).toMatchObject({ method: "debugger.describe", params: { protocol: 3, client: "unit test" } });
        // while it is asked, why the attempt before failed stays, and no next attempt is announced
        expect(store().initError).toBe(BUSY);
        expect(store().describeRetry).toBeUndefined();
        expect(store().initialized).toBe(false);

        if (index < delays.length - 1) {
          transport.respondError(-32000, "emulator busy");
          await vi.advanceTimersByTimeAsync(0);
          expect(store().describeRetry).toEqual({ attempt: index + 2, delayMs: delays[index + 1] });
          expect(store().client).toBeUndefined();
        }
      }

      // the sixth debugger.describe is answered: the server is described, and its tick is applied
      transport.respond(describeResult());
      transport.deliver(tickFrame({ state: "paused", stopId: 3, reason: "pause" }, { registers: { "dc.sh4.cpu": pc("0x8C0000A0") } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(store()).toMatchObject({ initialized: true, epoch: epoch + 1, ticks: 1, executionState: { state: "paused", stopId: 3 } });
      expect(store().client).toBe(client);
      expect(store().initError).toBeUndefined();
      expect(store().describeRetry).toBeUndefined();
      expect(store().deviceTree).toHaveLength(1);
      // and that is the end of the asking
      await vi.advanceTimersByTimeAsync(60_000);
      expect(describes(transport)).toBe(6);
    });

    it("retryDescribe() asks now instead of when the wait is over, and does nothing without a wait", async () => {
      const { transport } = await refused();
      store().retryDescribe();
      expect(describes(transport)).toBe(2);
      expect(store().describeRetry).toBeUndefined();
      // nothing is waiting any more: a second call sends nothing, and neither does the second the wait had left
      store().retryDescribe();
      await vi.advanceTimersByTimeAsync(1000);
      expect(describes(transport)).toBe(2);

      // the count of the attempts goes on from where it was
      transport.respondError(-32000, "emulator busy");
      await vi.advanceTimersByTimeAsync(0);
      expect(store().describeRetry).toEqual({ attempt: 2, delayMs: 2000 });
      store().retryDescribe();
      expect(describes(transport)).toBe(3);
      transport.respond(describeResult());
      await vi.advanceTimersByTimeAsync(0);
      expect(store().initialized).toBe(true);
      store().retryDescribe();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(describes(transport)).toBe(3);
    });

    it("the wait ends with the connection: reset() and the next connection send nothing for it", async () => {
      const lost = await refused();
      store().reset();
      expect(store().initError).toBeUndefined();
      expect(store().describeRetry).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(describes(lost.transport)).toBe(1);
      store().retryDescribe();
      expect(describes(lost.transport)).toBe(1);

      // the session reconnected while the server of the connection before was waited for
      const first = await refused();
      const second = connect();
      const done = store().initialize(second.client);
      expect(store().initError).toBeUndefined();
      expect(store().describeRetry).toBeUndefined();
      second.transport.respond(describeResult());
      await done;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(describes(first.transport)).toBe(1);
      expect(describes(second.transport)).toBe(1);
      expect(store().client).toBe(second.client);
      expect(store().initialized).toBe(true);
    });

    it("a connection that closes while the server is asked again is not asked a third time", async () => {
      const { transport } = await refused();
      await vi.advanceTimersByTimeAsync(1000);
      expect(describes(transport)).toBe(2);
      // the session controller hears of the loss and resets the store; the open request is rejected
      transport.close();
      store().reset();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(describes(transport)).toBe(2);
      expect(store().initError).toBeUndefined();
      expect(store().describeRetry).toBeUndefined();
    });
  });

  it("what the server said about itself outlives its connection, until the next server has described itself", async () => {
    // It is not data: the panels draw their frame from it, and keep that frame without a connection.
    await initialise(undefined, describeResult({ capabilities: ["callstack"] }));
    const first = store().shape;
    expect(first?.capabilities).toEqual(["callstack"]);
    store().reset();
    expect(store().initialized).toBe(false);
    expect(store().deviceTree).toEqual([]);
    expect(store().shape).toBe(first);

    // the next connection: still the last server's while this one has not answered
    const { transport, client } = connect();
    const done = store().initialize(client);
    expect(store().shape).toBe(first);
    expect(store().initialized).toBe(false);
    transport.respond(describeResult({ capabilities: [] }));
    transport.deliver(tickFrame({ state: "running", stopId: 1 }));
    await done;
    expect(store().shape?.capabilities).toEqual([]);

    // a server that cannot be described changes nothing about the frame either
    const third = connect();
    const failed = store().initialize(third.client);
    third.transport.respondError(-32000, "emulator busy");
    await failed;
    expect(store().initialized).toBe(false);
    expect(store().shape?.capabilities).toEqual([]);
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
    // the server lists the target of the breakpoint: a DSP whose steps are decimal, three digits wide
    const dsp = {
      id: "dsp",
      label: "DSP",
      pcPath: "dc.aica.dsp",
      pcRegister: "STEP",
      breakpointEvent: "dc.aica.dsp.step",
      instructionSize: 1,
      addressMax: 127,
      addressRadix: 10,
      addressDigits: 3,
      defaultDisassemblyAddress: 0,
      memory: false,
      stepping: true,
    };
    const { transport } = await initialise(tickFrame({ state: "running", stopId: 1 }), describeResult({ targets: [dsp] }));
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

  it("the address of the announced breakpoint is written as debugger.describe says its target writes them, not from a built-in table", async () => {
    // an SH4 of six digits, an ARM7 whose addresses are decimal, a DSP whose steps are hex
    const target = (id: string, pcPath: string, pcRegister: string, breakpointEvent: string, addressRadix: number, addressDigits: number) => ({
      id,
      label: id.toUpperCase(),
      pcPath,
      pcRegister,
      breakpointEvent,
      instructionSize: 2,
      addressMax: 0x00ffffff,
      addressRadix,
      addressDigits,
      defaultDisassemblyAddress: 0,
      defaultMemoryAddress: 0,
      memory: true,
      stepping: true,
    });
    const targets = [
      target("sh4", "dc.sh4.cpu", "PC", "dc.sh4.cpu.pc", 16, 6),
      target("arm7", "dc.aica.arm7", "PC", "dc.aica.arm7.pc", 10, 7),
      target("dsp", "dc.aica.dsp", "STEP", "dc.aica.dsp.step", 16, 2),
    ];
    const breakpoints = {
      "1": { id: 1, event: "dc.sh4.cpu.pc", address: 0x1008, kind: "code", enabled: true },
      "2": { id: 2, event: "dc.aica.arm7.pc", address: 2097168, kind: "code", enabled: true },
      "3": { id: 3, event: "dc.aica.dsp.step", address: 0x1f, kind: "code", enabled: true },
    };
    const { transport } = await initialise(tickFrame({ state: "running", stopId: 1 }), describeResult({ targets }));
    for (const breakpointId of [1, 2, 3]) {
      transport.deliver(tickFrame({ state: "paused", stopId: 1 + breakpointId, reason: "breakpoint", breakpointId }, { breakpoints }));
    }
    expect(store().toasts.map(({ message }) => message)).toEqual([
      "Breakpoint hit: dc.sh4.cpu.pc == 0x001008",
      "Breakpoint hit: dc.aica.arm7.pc == 2097168",
      "Breakpoint hit: dc.aica.dsp.step == 0x1F",
    ]);
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

describe("writes (state.setRegister, state.editWatch, state.writeMemory)", () => {
  const WATCHED = { watches: [{ id: 7, expression: "dc.sh4.cpu.pc", value: "0x8C0000A0" }] };
  const target = (id: string, pcPath: string) => ({
    id,
    label: id.toUpperCase(),
    pcPath,
    pcRegister: "PC",
    breakpointEvent: `${pcPath}.pc`,
    instructionSize: 2,
    addressMax: 0xffffffff,
    addressRadix: 16,
    addressDigits: 8,
    defaultDisassemblyAddress: 0,
    defaultMemoryAddress: 0,
    memory: true,
    stepping: true,
  });
  const TARGETS = [target("sh4", "dc.sh4.cpu"), target("arm7", "dc.aica.arm7")];
  /** A server that lists the SH4 and the ARM7, paused in stop 1 with both program counters in its tick. */
  const machine = (sh4: string, arm7 = "0x00200010") => ({ "dc.sh4.cpu": pc(sh4), "dc.aica.arm7": pc(arm7) });
  const paused = (registers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    tickFrame({ state: "paused", stopId: 1, reason: "pause" }, { registers, ...WATCHED, ...extra });
  const start = () => initialise(paused(machine("0x8C0000A0")), describeResult({ targets: TARGETS, capabilities: ["register-write", "memory-write"] }));

  /** The three writes: what the store is asked, and the request that is sent for it. */
  const WRITES = [
    ["setRegister", () => store().setRegister("dc.sh4.cpu", "R0", "0x1234"), "state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "0x1234" }],
    ["editWatch", () => store().editWatch(7, " 4660 "), "state.editWatch", { watchId: 7, value: " 4660 " }],
    ["writeMemory", () => store().writeMemory("arm7", 0x00200000, [0xde, 0xad]), "state.writeMemory", { target: "arm7", address: 0x00200000, data: [0xde, 0xad] }],
  ] as const;

  it.each(WRITES)("%s: sends its request as it was asked, and when it is answered {} the views read again where they are", async (_name, send, method, params) => {
    const { transport } = await start();
    const before = { refresh: store().refresh, reread: store().reread };
    const writing = send();
    expect(transport.sent.at(-1)).toMatchObject({ method, params });
    // not before the server has answered
    expect(store().reread).toBe(before.reread);
    transport.respond({});
    await writing;
    expect(store().reread).toBe(before.reread + 1);
    // the answer moves no view: that is the tick's to say
    expect(store().refresh).toBe(before.refresh);
    expect(store().toasts).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(WRITES)("%s: a refusal is said once and rejects, so that the editor stays open; nothing is read again", async (_name, send) => {
    const { transport } = await start();
    const before = { refresh: store().refresh, reread: store().reread };
    for (const [code, message] of [
      [-32013, "not writable: dc.sh4.cpu.PC = 0x8C0000A1: the address is odd"],
      [-32602, 'invalid params: value: "zz" is neither 0x hex nor decimal'],
      [-32001, "emulator stopped by host UI"],
      [-32000, "emulator busy"],
    ] as const) {
      const writing = send();
      transport.respond({ error: { code, message } });
      await expect(writing).rejects.toThrow(message);
      expect(store().toasts.at(-1)?.message).toBe(message);
    }
    expect(store().toasts.map((toast) => toast.count)).toEqual([1, 1, 1, 1]);
    expect(store().reread).toBe(before.reread);
    expect(store().refresh).toBe(before.refresh);
    // what the server says of a value is no failure of the UI: it is shown, not logged
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(WRITES)("%s: a JSON-RPC error and a lost connection are said and reject", async (_name, send, method) => {
    const { transport } = await start();
    const failed = send();
    transport.respondError(-32603, "internal error");
    await expect(failed).rejects.toThrow("internal error");
    const lost = send();
    transport.close();
    await expect(lost).rejects.toThrow(`Connection closed before ${method} was answered`);
    expect(store().toasts.map((toast) => toast.message)).toEqual(["internal error", `Connection closed before ${method} was answered`]);
    expect(store().reread).toBe(0);
  });

  it("without a connection a write is refused here, and says so", async () => {
    await expect(store().setRegister("dc.sh4.cpu", "PC", "0")).rejects.toThrow("No client connected");
    await expect(store().writeMemory("sh4", 0x8c010000, [0])).rejects.toThrow("No client connected");
    await expect(store().editWatch(1, "0")).rejects.toThrow("No client connected");
    expect(store().toasts.map((toast) => `${toast.message} x${toast.count}`)).toEqual(["No client connected x3"]);
  });

  it("a watch the ticks do not list is not written", async () => {
    const { transport } = await start();
    const before = transport.sent.length;
    await expect(store().editWatch(8, "0x1")).rejects.toThrow("Watch not found");
    expect(transport.sent).toHaveLength(before);
  });

  // The tick a write caused reaches the client in front of its response or behind it (design
  // 2.9, "Order"), and it is no new stop. The views that follow the PC move with the tick
  // that shows another PC, and with nothing else: the order does not matter.
  describe("a write of the PC", () => {
    it("the tick behind the response: the answer reads again in place, the tick moves the views", async () => {
      const { transport } = await start();
      expect([store().refresh, store().reread]).toEqual([1, 0]);
      const writing = store().setRegister("dc.sh4.cpu", "PC", "0x8C0000AC");
      transport.respond({});
      await writing;
      expect([store().refresh, store().reread]).toEqual([1, 1]);
      transport.deliver(paused(machine("0x8C0000AC")));
      expect([store().refresh, store().reread]).toEqual([2, 1]);
      // it was no stop
      expect(store().stop).toMatchObject({ serial: 1, stopId: 1 });
    });

    it("the tick in front of the response: the views are moved once, by the tick", async () => {
      const { transport } = await start();
      const writing = store().setRegister("dc.sh4.cpu", "PC", "0x8C0000AC");
      const request = transport.sent.at(-1)!;
      transport.deliver(paused(machine("0x8C0000AC")));
      expect([store().refresh, store().reread]).toEqual([2, 0]);
      transport.deliver({ jsonrpc: "2.0", id: request.id, result: {} });
      await writing;
      expect([store().refresh, store().reread]).toEqual([2, 1]);
    });

    it("through a watch, of the ARM7, and by another client: the tick moves the views the same way", async () => {
      const { transport } = await start();
      const writing = store().editWatch(7, "0x8C0000A4");
      transport.respond({});
      transport.deliver(paused(machine("0x8C0000A4")));
      await writing;
      expect([store().refresh, store().reread]).toEqual([2, 1]);
      // nobody here asked for this one
      transport.deliver(paused(machine("0x8C0000A4", "0x00200030")));
      expect([store().refresh, store().reread]).toEqual([3, 1]);
    });

    it("a write that leaves every PC where it was moves nothing: a register, a byte, the PC written as it is", async () => {
      const { transport } = await start();
      for (const send of [
        () => store().setRegister("dc.sh4.cpu", "R0", "0x1"),
        () => store().writeMemory("sh4", 0x8c0000a0, [0x09, 0x00]),
        () => store().setRegister("dc.sh4.cpu", "PC", "0x8C0000A0"),
      ]) {
        const writing = send();
        transport.respond({});
        transport.deliver(paused(machine("0x8C0000A0")));
        await writing;
      }
      expect([store().refresh, store().reread]).toEqual([1, 3]);
    });

    it("the PC of a target the server does not list moves nothing", async () => {
      // the server of `initialise` lists no target at all
      const { transport } = await initialise(paused(machine("0x8C0000A0")));
      transport.deliver(paused(machine("0x8C0000AC", "0x00200030")));
      expect(store().refresh).toBe(1);
    });

    it("the ticks of a server that has not described itself are read with no target of the server before it", async () => {
      await start();
      // the next connection: its ticks arrive before its debugger.describe is answered
      const { transport, client } = connect();
      const done = store().initialize(client);
      transport.deliver(paused(machine("0x8C0000A0")));
      transport.deliver(paused(machine("0x8C0000AC")));
      expect(store().refresh).toBe(1);
      transport.respond(describeResult({ targets: TARGETS }));
      await done;
      transport.deliver(paused(machine("0x8C0000AE")));
      expect(store().refresh).toBe(2);
    });
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
      ["reset", undefined, "control.reset", {}],
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
    ["reset", undefined, "Reset"],
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

  // A machine that runs is reset and runs on: no tick says so (design 2.3.2). What the views
  // fetched is out of date all the same, and the answer is the only word the client gets.
  describe("reset", () => {
    it("answered {} it has the views read again where they are, and moves none of them", async () => {
      const { transport } = await initialise(tickFrame({ state: "running", stopId: 1 }));
      const before = { refresh: store().refresh, reread: store().reread, ticks: store().ticks };
      const resetting = store().control("reset");
      expect(transport.sent.at(-1)).toMatchObject({ method: "control.reset", params: {} });
      // not before the server has said so
      expect(store().reread).toBe(before.reread);
      transport.respond({});
      await expect(resetting).resolves.toBe(true);
      expect(store().reread).toBe(before.reread + 1);
      expect(store().refresh).toBe(before.refresh);
      // and no tick was needed for it
      expect(store().ticks).toBe(before.ticks);
    });

    it("paused, the new stop moves the views and the answer has them read again: in either order", async () => {
      for (const tickFirst of [false, true]) {
        const { transport } = await initialise(tickFrame({ state: "paused", stopId: 4, reason: "pause" }));
        expect([store().refresh, store().reread]).toEqual([1, 0]);
        const resetting = store().control("reset");
        const request = transport.sent.at(-1)!;
        const stop = tickFrame({ state: "paused", stopId: 5, reason: "reset" });
        if (tickFirst) {
          transport.deliver(stop);
          expect([store().refresh, store().reread]).toEqual([2, 0]);
        }
        transport.deliver({ jsonrpc: "2.0", id: request.id, result: {} });
        await expect(resetting).resolves.toBe(true);
        if (!tickFirst) {
          expect([store().refresh, store().reread]).toEqual([1, 1]);
          transport.deliver(stop);
        }
        expect([store().refresh, store().reread]).toEqual([2, 1]);
        expect(store().stop).toMatchObject({ stopId: 5, reason: "reset" });
        store().reset();
      }
    });

    it.each([
      ["refused in the result", (transport: FakeTransport) => transport.respond({ error: { code: -32001, message: "emulator stopped by host UI" } })],
      ["refused with a JSON-RPC error", (transport: FakeTransport) => transport.respondError(-32603, "internal error")],
      ["not answered", (transport: FakeTransport) => transport.close()],
    ])("%s, nothing is read again", async (_name, answer) => {
      const { transport } = await initialise(tickFrame({ state: "running", stopId: 1 }));
      const resetting = store().control("reset");
      answer(transport);
      await expect(resetting).resolves.toBe(false);
      await settle();
      expect(store().reread).toBe(0);
      expect(store().toasts).toHaveLength(1);
      expect(store().toasts[0].message).toMatch(/^Reset: /);
    });

    it("no other control request has the views read again", async () => {
      const { transport } = await initialise();
      for (const [action, target] of [
        ["run", undefined],
        ["pause", "sh4"],
        ["step", "sh4"],
        ["stepOver", "arm7"],
        ["stepOut", "sh4"],
      ] as const) {
        const done = store().control(action, target);
        transport.respond({});
        await done;
      }
      expect(store().reread).toBe(0);
    });
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
