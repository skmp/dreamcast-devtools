import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ConformanceSchemas,
  DebuggerErrorCode,
  DebuggerRpcMethodSchemas,
  IN_BAND_ERROR_METHODS,
  PANEL_IDS,
  PROTOCOL_VERSION,
  PanelIdSchema,
  RegisterValueSchema,
  RpcMethod,
  RpcMethodNameSchema,
  StrictDebuggerRpcMethodSchemas,
  isPanelId,
} from "./debuggerSchema";

interface Frame {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

type MethodName = keyof typeof DebuggerRpcMethodSchemas;

const issuePaths = (result: { success: boolean; error?: z.ZodError }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.path.join("."));

describe("protocol constants", () => {
  it("is protocol version 3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it("has a schema for every method name, in both sets", () => {
    const names = Object.values(RpcMethod).sort();
    expect(RpcMethodNameSchema.options.slice().sort()).toEqual(names);
    expect(Object.keys(DebuggerRpcMethodSchemas).sort()).toEqual(names);
    expect(Object.keys(StrictDebuggerRpcMethodSchemas).sort()).toEqual(names);
  });

  it("lists the in-band methods: exactly those whose result is RpcError", () => {
    for (const [method, schemas] of Object.entries(DebuggerRpcMethodSchemas)) {
      if (method === RpcMethod.EVENT_TICK) {
        continue;
      }
      const acceptsInBandError = schemas.result.safeParse({ error: { code: -32602, message: "invalid params: x" } }).success;
      const acceptsEmpty = schemas.result.safeParse({}).success;
      expect(acceptsInBandError && acceptsEmpty, method).toBe(IN_BAND_ERROR_METHODS.has(method));
    }
  });

  it("has one number per error code, and the strict copy asks an in-band error for a message that is not empty", () => {
    const codes = Object.values(DebuggerErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => Number.isInteger(code) && code <= -32000 && code >= -32700)).toBe(true);
    // the code is the contract; the wording of the message is the server's
    const inBand = StrictDebuggerRpcMethodSchemas[RpcMethod.CONTROL_STEP].result;
    expect(inBand.safeParse({ error: { code: DebuggerErrorCode.NOT_PAUSED, message: "Not paused" } }).success).toBe(true);
    expect(inBand.safeParse({ error: { code: DebuggerErrorCode.NOT_PAUSED, message: "the target runs" } }).success).toBe(true);
    expect(issuePaths(inBand.safeParse({ error: { code: DebuggerErrorCode.NOT_PAUSED, message: "" } }))).toEqual(["error.message"]);
    expect(DebuggerRpcMethodSchemas[RpcMethod.CONTROL_STEP].result.safeParse({ error: { code: DebuggerErrorCode.NOT_PAUSED, message: "" } }).success).toBe(true);
  });

  it("recognises the panel ids, the two register panels of milestone M2 among them", () => {
    expect(isPanelId(PANEL_IDS.SH4_DISASSEMBLY)).toBe(true);
    expect(PANEL_IDS.SH4_REGISTERS).toBe("sh4-registers");
    expect(PANEL_IDS.ARM7_REGISTERS).toBe("arm7-registers");
    expect(isPanelId("sh4-registers")).toBe(true);
    expect(isPanelId("arm7-registers")).toBe(true);
    expect(isPanelId("dsp-registers")).toBe(false);
    // 37 ids, each once, and the schema has exactly those (the emulator's tests read the list as text)
    const ids = Object.values(PANEL_IDS);
    expect(ids).toHaveLength(37);
    expect(new Set(ids).size).toBe(37);
    expect([...PanelIdSchema.options].sort()).toEqual([...ids].sort());
    // a device node of a v3 server may name them as actions
    const node = { path: "dc.sh4.cpu", label: "Core", description: "", actions: ["sh4-registers", "arm7-registers"] };
    expect(ConformanceSchemas.DeviceNodeDescriptorSchema.safeParse(node).success).toBe(true);
    expect(ConformanceSchemas.DeviceNodeDescriptorSchema.safeParse({ ...node, actions: ["dsp-registers"] }).success).toBe(false);
  });

  it("a register may say that it has a writer: flags.writable, in the client copy and in the strict copy", () => {
    const register = { name: "R0", value: "0x00000000", width: 32, flags: { writable: true } };
    expect(ConformanceSchemas.RegisterValueSchema.safeParse(register).success).toBe(true);
    expect(RegisterValueSchema.parse(register).flags).toEqual({ writable: true });
    // a flag is a boolean
    expect(ConformanceSchemas.RegisterValueSchema.safeParse({ ...register, flags: { writable: "yes" } }).success).toBe(false);
  });
});

describe("a message without the fields a v3 server always sends", () => {
  // The client copy takes it, so that the UI can say what is wrong with the server instead of
  // dropping what it sends; the strict copy, which the contract runner holds a server to, names
  // every field that is missing.
  const describeResult = {
    emulator: { name: "mockServer", version: "unspecified", build: "native" },
    deviceTree: [{ path: "dc", label: "Dreamcast", description: "", registers: [{ name: "SYSCLK", value: "200MHz", width: 0 }] }],
  };
  const tick = {
    tickId: 3,
    timestamp: 1791150000000,
    executionState: { state: "paused" },
    registers: { "dc.sh4.cpu": [{ name: "PC", value: "0x8C0000A0", width: 32 }] },
    breakpoints: { "1": { id: 1, event: "dc.sh4.cpu.pc", address: 0x8c0000a0, kind: "code", enabled: true } },
    eventLog: [{ eventId: "41", timestamp: 1791150000000, subsystem: "gdrom", severity: "info", message: "command 0x30" }],
  };

  it("a describe result without protocol, ui, capabilities and targets is one for the client", () => {
    const shape = DebuggerRpcMethodSchemas["debugger.describe"].result.parse(describeResult);
    expect(shape).toEqual(describeResult);
    expect(shape.protocol).toBeUndefined();
    expect(shape.capabilities).toBeUndefined();
    expect(shape.targets).toBeUndefined();
    expect(issuePaths(StrictDebuggerRpcMethodSchemas["debugger.describe"].result.safeParse(describeResult)).sort()).toEqual([
      "capabilities",
      "protocol",
      "targets",
      "ui",
    ]);
  });

  it("a tick without stopId, watches, callstacks and categories, and a log entry without metadata, is one for the client", () => {
    const parsed = DebuggerRpcMethodSchemas["event.tick"].params.parse(tick);
    expect(parsed).toEqual(tick);
    expect(parsed.executionState.stopId).toBeUndefined();
    expect(parsed.watches).toBeUndefined();
    expect(parsed.callstacks).toBeUndefined();
    expect(parsed.categories).toBeUndefined();
    expect(parsed.eventLog[0].metadata).toBeUndefined();
    expect(issuePaths(StrictDebuggerRpcMethodSchemas["event.tick"].params.safeParse(tick)).sort()).toEqual([
      "callstacks",
      "categories",
      "eventLog.0.metadata",
      "executionState.stopId",
      "watches",
    ]);
  });

  it("a state.getSgcFrameData result without binaryId is one for the client", () => {
    const result = { frameCount: 1, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: 8192 };
    expect(DebuggerRpcMethodSchemas["state.getSgcFrameData"].result.parse(result)).toEqual(result);
    expect(issuePaths(StrictDebuggerRpcMethodSchemas["state.getSgcFrameData"].result.safeParse(result))).toEqual(["binaryId"]);
  });
});

describe("a v3 server (captured from the mock, server/mockDebugger.ts)", () => {
  const capture = JSON.parse(readFileSync(new URL("./test-fixtures/protocol-v3-frames.json", import.meta.url), "utf8")) as {
    requests: Array<{ id: number; method: MethodName }>;
    frames: Frame[];
  };
  const methodOf = (id: number) => capture.requests.find((request) => request.id === id)!.method;
  const responses = capture.frames.filter((frame) => frame.method === undefined);
  const ticks = capture.frames.filter((frame) => frame.method === "event.tick").map((frame) => frame.params);

  it("round-trips through the client schemas and through the strict copy: nothing is stripped, nothing is missing", () => {
    for (const tick of ticks) {
      expect(DebuggerRpcMethodSchemas["event.tick"].params.parse(tick)).toEqual(tick);
      expect(StrictDebuggerRpcMethodSchemas["event.tick"].params.parse(tick)).toEqual(tick);
    }
    let results = 0;
    for (const frame of responses) {
      if (frame.result === undefined) {
        continue;
      }
      const method = methodOf(frame.id!);
      expect(DebuggerRpcMethodSchemas[method].result.parse(frame.result), method).toEqual(frame.result);
      expect(StrictDebuggerRpcMethodSchemas[method].result.parse(frame.result), method).toEqual(frame.result);
      results++;
    }
    expect(ticks).toHaveLength(6);
    expect(results).toBeGreaterThanOrEqual(15);
    expect(JSON.stringify(capture.frames)).not.toMatch(/:null[,}\]]/);
  });

  it("carries what protocol v3 added", () => {
    const shape = DebuggerRpcMethodSchemas["debugger.describe"].result.parse(responses[0].result);
    expect(shape.protocol).toBe(PROTOCOL_VERSION);
    expect(shape.ui).toBe("none");
    expect(shape.capabilities).toContain("event-breakpoints");
    expect(shape.targets?.map((target) => [target.id, target.addressRadix, target.addressDigits, target.memory])).toEqual([
      ["sh4", 16, 8, true],
      ["arm7", 16, 8, true],
      ["dsp", 10, 3, false],
    ]);
    expect(shape.targets?.[2].defaultMemoryAddress).toBeUndefined();

    const parsed = ticks.map((tick) => DebuggerRpcMethodSchemas["event.tick"].params.parse(tick));
    const states = parsed.map((tick) => tick.executionState);
    expect(states.map((state) => `${state.state} ${state.reason ?? "-"}`)).toEqual([
      "running -",
      "running -",
      "paused pause",
      "paused step",
      "paused breakpoint",
      "paused capture",
    ]);
    expect(states.map((state) => state.stopId)).toEqual([0, 0, 1, 2, 3, 4]);
    expect(states[4].breakpointId).toBe(1);
    // the first tick is full, the periodic running tick carries the base paths only
    expect(Object.keys(parsed[0].registers).length).toBeGreaterThan(20);
    expect(Object.keys(parsed[1].registers).sort()).toEqual(["dc.aica.arm7", "dc.aica.dsp", "dc.sh4.cpu", "dc.timing"]);
    expect(parsed[1].callstacks).toEqual({ sh4: [], arm7: [] });
    expect(parsed[4].callstacks?.sh4.map((frame) => frame.location)).toEqual([undefined, "pr", "stack+0x0"]);
    expect(parsed[4].categories).toEqual({
      events: { muted: false, soloed: false },
      sh4: { muted: false, soloed: false },
      arm7: { muted: true, soloed: false },
      dsp: { muted: false, soloed: false },
    });
    expect(parsed[4].watches).toEqual([
      { id: 1, expression: "dc.sh4.cpu.pc", value: "0x8C0000A6" },
      { id: 2, expression: "dc.sh4.scif.scfrdr2", value: "n/a" },
    ]);
    for (const entry of parsed[5].eventLog) {
      expect(entry.metadata).toEqual({ event: expect.stringMatching(/^dc\./), cycles: expect.stringMatching(/^\d+$/) });
    }
  });

  it("reports failures on the channel of the method, with code and message only", () => {
    const byMethod = (method: string) => responses.filter((frame) => methodOf(frame.id!) === method);
    expect(byMethod("breakpoints.remove")[0]).toEqual({
      jsonrpc: "2.0",
      id: expect.any(Number),
      result: { error: { code: -32602, message: "invalid params: unknown breakpoint id 99" } },
    });
    expect(byMethod("control.reset")[0].result).toEqual({ error: { code: -32004, message: "not supported: control.reset" } });
    expect(byMethod("state.getTable")[0].error).toEqual({ code: -32004, message: "not supported: state.getTable" });
    expect(byMethod("state.getMemorySlice")[1].error).toEqual({ code: -32010, message: "address not readable" });
    expect(byMethod("state.getSgcFrameData")[0].error).toEqual({ code: -32011, message: "no capture available" });
    expect(byMethod("state.getSgcFrameData")[1].result).toEqual({
      frameCount: 2,
      channelsPerFrame: 64,
      bytesPerChannel: 128,
      totalBytes: 16384,
      binaryId: 1,
    });
    // unreadable bytes are listed, and an unreadable word of the disassembly is marked
    expect(byMethod("state.getMemorySlice")[0].result).toMatchObject({ baseAddress: 0x0021fff8, validity: "ok", unreadable: [[8, 8]] });
    expect(byMethod("state.getDisassembly")[1].result).toMatchObject({ lines: [{ address: 0x0021fffe }, { address: 0x00220000, bytes: "??", disassembly: "<unreadable>" }] });
  });
});

describe("the strict copy", () => {
  const tick = () => ({
    tickId: 12,
    timestamp: 1791150000000,
    executionState: { state: "paused", stopId: 3, reason: "breakpoint", breakpointId: 1 },
    registers: { "dc.sh4.cpu": [{ name: "PC", value: "0x8C0000A0", width: 32 }] },
    breakpoints: { "1": { id: 1, event: "dc.sh4.cpu.pc", address: 0x8c0000a0, kind: "code", enabled: true } },
    eventLog: [
      {
        eventId: "41",
        timestamp: 1791150000000,
        subsystem: "gdrom",
        severity: "info",
        message: "command 0x30",
        metadata: { event: "dc.gdrom.command", cycles: "123456789012345" },
      },
    ],
    watches: [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x8C0000A0" }],
    callstacks: { sh4: [{ index: 0, pc: 0x8c0000a0, sp: 0x8cfff000 }], arm7: [] },
    categories: {
      events: { muted: false, soloed: false },
      sh4: { muted: false, soloed: false },
      arm7: { muted: false, soloed: false },
      dsp: { muted: false, soloed: false },
    },
  });
  const strict = StrictDebuggerRpcMethodSchemas["event.tick"].params;
  const paths = (value: unknown) => issuePaths(strict.safeParse(value));

  it("accepts a complete v3 tick, and so does the client", () => {
    expect(paths(tick())).toEqual([]);
    expect(DebuggerRpcMethodSchemas["event.tick"].params.safeParse(tick()).success).toBe(true);
  });

  it("fails on unknown keys at every level; the client strips them", () => {
    const value = tick() as Record<string, unknown> & ReturnType<typeof tick>;
    value.extra = 1;
    (value.executionState as Record<string, unknown>).extra = 1;
    (value.registers["dc.sh4.cpu"][0] as Record<string, unknown>).extra = 1;
    (value.eventLog[0].metadata as Record<string, unknown>).extra = 1;
    (value.callstacks as Record<string, unknown>).dsp = [];
    (value.categories as Record<string, unknown>).gdrom = { muted: false, soloed: false };
    const result = strict.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error!.issues.every((issue) => issue.code === "unrecognized_keys")).toBe(true);
    expect(result.error!.issues.map((issue) => issue.path.join(".")).sort()).toEqual(
      ["", "callstacks", "categories", "eventLog.0.metadata", "executionState", "registers.dc.sh4.cpu.0"].sort(),
    );

    const stripped = DebuggerRpcMethodSchemas["event.tick"].params.parse(value);
    expect(Object.keys(stripped)).not.toContain("extra");
    expect(stripped.executionState).toEqual(tick().executionState);
  });

  it("requires what a v3 server always sends", () => {
    for (const key of ["watches", "callstacks", "categories"] as const) {
      const value: Record<string, unknown> = tick();
      delete value[key];
      expect(paths(value), key).toEqual([key]);
    }
    const noStopId = tick() as { executionState: Record<string, unknown> };
    delete noStopId.executionState.stopId;
    expect(paths(noStopId)).toEqual(["executionState.stopId"]);
    const threeCategories = tick() as { categories: Record<string, unknown> };
    delete threeCategories.categories.dsp;
    expect(paths(threeCategories)).toEqual(["categories.dsp"]);
    const oneCallstack = tick() as { callstacks: Record<string, unknown> };
    delete oneCallstack.callstacks.arm7;
    expect(paths(oneCallstack)).toEqual(["callstacks.arm7"]);
  });

  it("ties reason and breakpointId to the state", () => {
    const pausedWithoutReason = tick() as { executionState: Record<string, unknown> };
    delete pausedWithoutReason.executionState.reason;
    expect(paths(pausedWithoutReason)).toEqual(["executionState.reason"]);

    const running = tick();
    running.executionState = { state: "running", stopId: 3, reason: "breakpoint", breakpointId: 1 };
    expect(paths(running).sort()).toEqual(["executionState.breakpointId", "executionState.reason"]);
    (running as { executionState: unknown }).executionState = { state: "running", stopId: 3 };
    expect(paths(running)).toEqual([]);
  });

  it("limits the open enums to the values a v3 server sends; the client takes any string", () => {
    const value = tick();
    value.executionState.reason = "watchpoint";
    value.eventLog[0].subsystem = "pvr";
    value.eventLog[0].severity = "debug";
    expect(paths(value).sort()).toEqual(["eventLog.0.severity", "eventLog.0.subsystem", "executionState.reason"]);
    expect(DebuggerRpcMethodSchemas["event.tick"].params.safeParse(value).success).toBe(true);
  });

  it("checks registersStale, the notice, the event log and the breakpoints", () => {
    const stale = tick() as { executionState: Record<string, unknown> };
    stale.executionState.registersStale = false;
    expect(paths(stale)).toEqual(["executionState.registersStale"]);
    stale.executionState.registersStale = true;
    stale.executionState.notice = "SH4 runs on the interpreter while breakpoints are armed\nDSP forced";
    expect(paths(stale)).toEqual([]);
    stale.executionState.notice = `ok\n${"x".repeat(201)}`;
    expect(paths(stale)).toEqual(["executionState.notice"]);

    const events = tick();
    events.eventLog[0].eventId = "e-41";
    events.eventLog[0].metadata.cycles = "0x10";
    expect(paths(events).sort()).toEqual(["eventLog.0.eventId", "eventLog.0.metadata.cycles"]);
    const many = tick();
    many.eventLog = Array.from({ length: 201 }, (_, index) => ({ ...tick().eventLog[0], eventId: String(index) }));
    expect(paths(many)).toEqual(["eventLog"]);

    const breakpoint = tick() as { breakpoints: Record<string, Record<string, unknown>> };
    delete breakpoint.breakpoints["1"].address;
    expect(paths(breakpoint)).toEqual(["breakpoints.1.address"]);
    breakpoint.breakpoints["1"].address = -1;
    expect(paths(breakpoint)).toEqual(["breakpoints.1.address"]);
    // an event breakpoint never has an address: one that was given with the request is not stored
    const event = tick() as { breakpoints: Record<string, Record<string, unknown>> };
    event.breakpoints["1"] = { id: 1, event: "dc.holly.core.vblank", kind: "event", enabled: true };
    expect(paths(event)).toEqual([]);
    event.breakpoints["1"].address = 0x8c0000a0;
    expect(paths(event)).toEqual(["breakpoints.1.address"]);
    expect(DebuggerRpcMethodSchemas["event.tick"].params.safeParse(event).success).toBe(true);
  });

  it("requires sp in every callstack frame, and at most 64 frames of state.getCallstack; the client takes less and more", () => {
    const frame = (index: number) => ({ index, pc: 0x8c0000a0 + index * 2, sp: 0x8cfff000 });
    const withoutSp = tick() as { callstacks: Record<string, Array<Record<string, unknown>>> };
    delete withoutSp.callstacks.sh4[0].sp;
    expect(paths(withoutSp)).toEqual(["callstacks.sh4.0.sp"]);
    expect(DebuggerRpcMethodSchemas["event.tick"].params.safeParse(withoutSp).success).toBe(true);

    const result = StrictDebuggerRpcMethodSchemas["state.getCallstack"].result;
    const frames = (count: number) => ({ target: "sh4", frames: Array.from({ length: count }, (_, index) => frame(index)) });
    expect(issuePaths(result.safeParse(frames(64)))).toEqual([]);
    expect(issuePaths(result.safeParse(frames(65)))).toEqual(["frames"]);
    expect(issuePaths(result.safeParse({ target: "sh4", frames: [{ index: 0, pc: 0x8c0000a0 }] }))).toEqual(["frames.0.sp"]);
    expect(DebuggerRpcMethodSchemas["state.getCallstack"].result.safeParse(frames(65)).success).toBe(true);
    expect(DebuggerRpcMethodSchemas["state.getCallstack"].result.safeParse({ target: "sh4", frames: [{ index: 0, pc: 0x8c0000a0 }] }).success).toBe(true);
  });

  it("takes a register width as a number of bits: an integer, 0 for free text; the client takes any number", () => {
    for (const width of [-1, 31.5]) {
      const register = tick();
      register.registers["dc.sh4.cpu"][0].width = width;
      expect(paths(register)).toEqual(["registers.dc.sh4.cpu.0.width"]);
      expect(issuePaths(ConformanceSchemas.RegisterValueSchema.safeParse({ name: "PC", value: "0x8C0000A0", width }))).toEqual(["width"]);
      expect(DebuggerRpcMethodSchemas["event.tick"].params.safeParse(register).success).toBe(true);
    }
    expect(ConformanceSchemas.RegisterValueSchema.safeParse({ name: "BUILD", value: "nullDC 3.0.0", width: 0 }).success).toBe(true);
  });

  it("never accepts null for an optional field (both sets)", () => {
    const value = tick() as { executionState: Record<string, unknown> };
    value.executionState.breakpointId = null;
    expect(paths(value)).toEqual(["executionState.breakpointId"]);
    expect(DebuggerRpcMethodSchemas["event.tick"].params.safeParse(value).success).toBe(false);
  });

  const sh4Target = {
    id: "sh4",
    label: "SH4",
    pcPath: "dc.sh4.cpu",
    pcRegister: "PC",
    breakpointEvent: "dc.sh4.cpu.pc",
    instructionSize: 2,
    addressMax: 0xffffffff,
    addressRadix: 16,
    addressDigits: 8,
    defaultDisassemblyAddress: 0x8c010000,
    defaultMemoryAddress: 0x8c010000,
    memory: true,
    stepping: true,
  };
  const shape = () => ({
    emulator: { name: "nullDC", version: "3.0.0", build: "native" },
    protocol: 3,
    ui: "none",
    capabilities: ["event-breakpoints", "callstack", "sh4-debug-native"],
    targets: [sh4Target],
    deviceTree: [
      {
        path: "dc",
        label: "Dreamcast",
        description: "",
        children: [
          {
            path: "dc.sh4.cpu",
            label: "Core",
            description: "SH4 CPU core",
            registers: [{ name: "PC", value: "0x8C0000A0", width: 32 }],
            actions: ["sh4-disassembly"],
          },
        ],
      },
    ],
  });
  const strictShape = StrictDebuggerRpcMethodSchemas["debugger.describe"].result;

  it("accepts a v3 describe result", () => {
    expect(issuePaths(strictShape.safeParse(shape()))).toEqual([]);
    expect(ConformanceSchemas.TargetSchema.safeParse(sh4Target).success).toBe(true);
  });

  it("checks the device tree: no empty arrays, no unknown actions, no unknown keys in nested nodes", () => {
    const value = shape();
    const node = value.deviceTree[0].children[0] as Record<string, unknown>;
    node.actions = ["sh4-pipeline"];
    node.events = [];
    node.children = [{ path: "dc.sh4.cpu.x", label: "X", description: "", note: "unknown key" }];
    expect(issuePaths(strictShape.safeParse(value)).sort()).toEqual([
      "deviceTree.0.children.0.actions.0",
      "deviceTree.0.children.0.children.0",
      "deviceTree.0.children.0.events",
    ]);
    // the client ignores an unknown action instead of dropping the message
    const lenient = DebuggerRpcMethodSchemas["debugger.describe"].result.parse(value);
    expect(lenient.deviceTree[0].children?.[0].actions).toEqual(["sh4-pipeline"]);
  });

  it("ties defaultMemoryAddress to memory", () => {
    const noMemory = { ...sh4Target, id: "dsp", memory: false };
    expect(issuePaths(ConformanceSchemas.TargetSchema.safeParse(noMemory))).toEqual(["defaultMemoryAddress"]);
    const { defaultMemoryAddress: _omitted, ...withoutDefault } = sh4Target;
    expect(issuePaths(ConformanceSchemas.TargetSchema.safeParse(withoutDefault))).toEqual(["defaultMemoryAddress"]);
    expect(ConformanceSchemas.TargetSchema.safeParse({ ...withoutDefault, memory: false }).success).toBe(true);
    expect(issuePaths(ConformanceSchemas.TargetSchema.safeParse({ ...sh4Target, addressRadix: 8 }))).toEqual(["addressRadix"]);
  });

  it("checks results: memory, in-band errors without data, SGC geometry", () => {
    const memory = StrictDebuggerRpcMethodSchemas["state.getMemorySlice"].result;
    expect(memory.safeParse({ baseAddress: 0x21fff0, data: [1, 0], validity: "ok", unreadable: [[1, 1]] }).success).toBe(true);
    expect(issuePaths(memory.safeParse({ baseAddress: 0, data: [256], validity: "tlb-miss", unreadable: [] })).sort()).toEqual([
      "data.0",
      "unreadable",
      "validity",
    ]);

    const rpcError = StrictDebuggerRpcMethodSchemas["control.step"].result;
    expect(rpcError.safeParse({}).success).toBe(true);
    expect(rpcError.safeParse({ error: { code: -32003, message: "not paused" } }).success).toBe(true);
    expect(issuePaths(rpcError.safeParse({ error: { code: -32003, message: "not paused", data: { stack: "" } } }))).toEqual(["error"]);
    expect(rpcError.safeParse(null).success).toBe(false);
    // an in-band code is an integer, as the code of a JSON-RPC error is; the client takes what it gets
    expect(issuePaths(rpcError.safeParse({ error: { code: -32003.5, message: "not paused" } }))).toEqual(["error.code"]);
    expect(DebuggerRpcMethodSchemas["control.step"].result.safeParse({ error: { code: -32003.5, message: "not paused" } }).success).toBe(true);

    const sgc = StrictDebuggerRpcMethodSchemas["state.getSgcFrameData"].result;
    expect(sgc.safeParse({ frameCount: 64, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: 524288, binaryId: 1 }).success).toBe(true);
    expect(issuePaths(sgc.safeParse({ frameCount: 64, channelsPerFrame: 32, bytesPerChannel: 128, totalBytes: 524288 })).sort()).toEqual([
      "binaryId",
      "channelsPerFrame",
    ]);
    // "no capture" is the JSON-RPC error -32011: an in-band error object is no result of this method, in either copy
    const inBand = { error: { code: -32001, message: "No SGC frame data available. Record some data first." } };
    expect(sgc.safeParse(inBand).success).toBe(false);
    expect(DebuggerRpcMethodSchemas["state.getSgcFrameData"].result.safeParse(inBand).success).toBe(false);
  });
});

describe("request parameters carry the bounds of the protocol", () => {
  const accepts = (method: MethodName, params: unknown) => DebuggerRpcMethodSchemas[method].params.safeParse(params).success;

  it("bounds lengths and counts", () => {
    expect(accepts("state.getMemorySlice", { address: 0, length: 65536 })).toBe(true);
    expect(accepts("state.getMemorySlice", { address: 0, length: 65537 })).toBe(false);
    expect(accepts("state.getMemorySlice", { address: 0, length: 0 })).toBe(false);
    expect(accepts("state.getMemoryBinary", { address: 0, length: 16777216 })).toBe(true);
    expect(accepts("state.getMemoryBinary", { address: 0, length: 16777217 })).toBe(false);
    expect(accepts("state.getDisassembly", { address: 0, count: 1024 })).toBe(true);
    expect(accepts("state.getDisassembly", { address: 0, count: 1025 })).toBe(false);
    expect(accepts("state.getCallstack", { target: "sh4", maxFrames: 64 })).toBe(true);
    expect(accepts("state.getCallstack", { target: "sh4", maxFrames: 65 })).toBe(false);
    expect(accepts("state.getCallstack", { target: "dsp" })).toBe(false);
    expect(accepts("state.recordSgcFrames", {})).toBe(true);
    expect(accepts("state.recordSgcFrames", { frames: 4097 })).toBe(false);
    expect(accepts("state.writeMemory", { target: "sh4", address: 0, data: [] })).toBe(false);
    expect(accepts("state.writeMemory", { target: "sh4", address: 0, data: [256] })).toBe(false);
    expect(accepts("state.writeMemory", { target: "arm7", address: 0, data: [255] })).toBe(true);
    expect(accepts("state.writeMemory", { target: "sh4", address: 0, data: new Array(65536).fill(0) })).toBe(true);
    expect(accepts("state.writeMemory", { target: "sh4", address: 0, data: new Array(65537).fill(0) })).toBe(false);
    // the target is required and is any of the three ids, as for the reads: "dsp" is the
    // method's own -32004, decided by the server behind the lifetime, and not an invalid parameter
    expect(accepts("state.writeMemory", { target: "dsp", address: 0, data: [0] })).toBe(true);
    expect(StrictDebuggerRpcMethodSchemas["state.writeMemory"].params.safeParse({ target: "dsp", address: 0, data: [0] }).success).toBe(true);
    expect(accepts("state.writeMemory", { address: 0, data: [0] })).toBe(false);
    expect(accepts("state.writeMemory", { target: "gpu", address: 0, data: [0] })).toBe(false);
  });

  it("bounds addresses to unsigned 32 bits and watch expressions to 256 characters, 64 per call", () => {
    expect(accepts("state.getMemorySlice", { address: 0xffffffff, length: 1 })).toBe(true);
    expect(accepts("state.getMemorySlice", { address: 0x100000000, length: 1 })).toBe(false);
    expect(accepts("state.getMemorySlice", { address: -1, length: 1 })).toBe(false);
    expect(accepts("state.getMemorySlice", { address: 1.5, length: 1 })).toBe(false);
    expect(accepts("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c010000 })).toBe(true);
    expect(accepts("breakpoints.add", { event: "dc.sh4.interrupt" })).toBe(true);
    expect(accepts("state.watch", { expressions: ["x".repeat(256)] })).toBe(true);
    expect(accepts("state.watch", { expressions: ["x".repeat(257)] })).toBe(false);
    expect(accepts("state.watch", { expressions: Array.from({ length: 65 }, () => "dc.sh4.cpu.pc") })).toBe(false);
    expect(accepts("state.getTable", { id: "sq" })).toBe(true);
    expect(accepts("state.getTable", { id: "vram" })).toBe(false);
    expect(accepts("state.captureHolly", { what: "ta" })).toBe(true);
    expect(accepts("debugger.describe", { protocol: 3, client: "Dreamcast DevTools" })).toBe(true);
    expect(accepts("debugger.describe", {})).toBe(true);
  });
});
