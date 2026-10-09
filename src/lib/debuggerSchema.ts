import { z } from "zod";
import type { RpcSchema } from "./jsonRpc";
import { PROTOCOL_VERSION } from "./protocolVersion";

/**
 * Debugger protocol v3: every message, field, method, enum, error code and bound.
 *
 * Two sets of zod schemas are built from the one definition in `defineProtocol`:
 *
 * - the client schemas (the named exports and `DebuggerRpcMethodSchemas`). Objects strip
 *   unknown keys, the fields protocol v3 added are optional and the open enums are plain
 *   strings, so the UI also works against a v2 server and against a newer v3 server;
 * - `ConformanceSchemas` (and `StrictDebuggerRpcMethodSchemas`), the strict copy the
 *   contract runner holds a v3 server to: unknown keys fail, the fields a v3 server always
 *   sends are required, and the open enums are limited to the values a v3 server sends.
 *
 * A server says what it implements through `capabilities` and `targets` of
 * `debugger.describe` and answers everything else with the error -32004 "not supported".
 */
export { PROTOCOL_VERSION };

// Common enums and ID types
export const TargetProcessorSchema = z.enum(["sh4", "arm7", "dsp"]);

// Panel ID constants
export const PANEL_IDS = {
  DOCUMENTATION: "documentation",
  SH4_SIM: "sh4-sim",
  EVENTS: "events",
  EVENTS_BREAKPOINTS: "events-breakpoints",
  SH4_DISASSEMBLY: "sh4-disassembly",
  SH4_MEMORY: "sh4-memory",
  SH4_BREAKPOINTS: "sh4-breakpoints",
  SH4_BSC_REGISTERS: "bsc-registers",
  SH4_CCN_REGISTERS: "ccn-registers",
  SH4_CPG_REGISTERS: "cpg-registers",
  SH4_DMAC_REGISTERS: "dmac-registers",
  SH4_INTC_REGISTERS: "intc-registers",
  SH4_RTC_REGISTERS: "rtc-registers",
  SH4_SCI_REGISTERS: "sci-registers",
  SH4_SCIF_REGISTERS: "scif-registers",
  SH4_TMU_REGISTERS: "tmu-registers",
  SH4_UBC_REGISTERS: "ubc-registers",
  SH4_SQ_CONTENTS: "sq-contents",
  SH4_ICACHE_CONTENTS: "icache-contents",
  SH4_OCACHE_CONTENTS: "ocache-contents",
  SH4_OCRAM_CONTENTS: "ocram-contents",
  SH4_TLB_CONTENTS: "tlb-contents",
  ARM7_DISASSEMBLY: "arm7-disassembly",
  ARM7_MEMORY: "arm7-memory",
  ARM7_BREAKPOINTS: "arm7-breakpoints",
  CLX2_TA: "holly-ta",
  CLX2_CORE: "holly-core",
  SGC: "sgc",
  DSP_DISASSEMBLY: "dsp-disassembly",
  DSP_BREAKPOINTS: "dsp-breakpoints",
  DSP_PLAYGROUND: "dsp-playground",
  DEVICE_TREE: "device-tree",
  WATCHES: "watches",
  SH4_CALLSTACK: "sh4-callstack",
  ARM7_CALLSTACK: "arm7-callstack",
} as const;

export const PanelIdSchema = z.enum([
  PANEL_IDS.DOCUMENTATION,
  PANEL_IDS.SH4_SIM,
  PANEL_IDS.EVENTS,
  PANEL_IDS.EVENTS_BREAKPOINTS,
  PANEL_IDS.SH4_DISASSEMBLY,
  PANEL_IDS.SH4_MEMORY,
  PANEL_IDS.SH4_BREAKPOINTS,
  PANEL_IDS.SH4_BSC_REGISTERS,
  PANEL_IDS.SH4_CCN_REGISTERS,
  PANEL_IDS.SH4_CPG_REGISTERS,
  PANEL_IDS.SH4_DMAC_REGISTERS,
  PANEL_IDS.SH4_INTC_REGISTERS,
  PANEL_IDS.SH4_RTC_REGISTERS,
  PANEL_IDS.SH4_SCI_REGISTERS,
  PANEL_IDS.SH4_SCIF_REGISTERS,
  PANEL_IDS.SH4_TMU_REGISTERS,
  PANEL_IDS.SH4_UBC_REGISTERS,
  PANEL_IDS.SH4_SQ_CONTENTS,
  PANEL_IDS.SH4_ICACHE_CONTENTS,
  PANEL_IDS.SH4_OCACHE_CONTENTS,
  PANEL_IDS.SH4_OCRAM_CONTENTS,
  PANEL_IDS.SH4_TLB_CONTENTS,
  PANEL_IDS.ARM7_DISASSEMBLY,
  PANEL_IDS.ARM7_MEMORY,
  PANEL_IDS.ARM7_BREAKPOINTS,
  PANEL_IDS.CLX2_TA,
  PANEL_IDS.CLX2_CORE,
  PANEL_IDS.SGC,
  PANEL_IDS.DSP_DISASSEMBLY,
  PANEL_IDS.DSP_BREAKPOINTS,
  PANEL_IDS.DSP_PLAYGROUND,
  PANEL_IDS.DEVICE_TREE,
  PANEL_IDS.WATCHES,
  PANEL_IDS.SH4_CALLSTACK,
  PANEL_IDS.ARM7_CALLSTACK,
]);

export type PanelId = z.infer<typeof PanelIdSchema>;

const PANEL_ID_SET: ReadonlySet<string> = new Set(PanelIdSchema.options);

/**
 * `actions` of a device node are open strings on the wire: a server may name a panel this
 * build does not have, and the UI ignores it.
 */
export const isPanelId = (value: string): value is PanelId => PANEL_ID_SET.has(value);

// ID schemas - using integers for efficiency
export const BreakpointIdSchema = z.number().int().nonnegative();
export const WatchIdSchema = z.number().int().nonnegative();

// Enum-style constants for method names (for better discoverability and refactoring)
export const RpcMethod = {
  DEBUGGER_DESCRIBE: "debugger.describe",
  STATE_GET_CALLSTACK: "state.getCallstack",
  STATE_GET_MEMORY_SLICE: "state.getMemorySlice",
  STATE_GET_MEMORY_BINARY: "state.getMemoryBinary",
  STATE_GET_DISASSEMBLY: "state.getDisassembly",
  STATE_WATCH: "state.watch",
  STATE_UNWATCH: "state.unwatch",
  STATE_EDIT_WATCH: "state.editWatch",
  STATE_MODIFY_WATCH_EXPRESSION: "state.modifyWatchExpression",
  STATE_WRITE_MEMORY: "state.writeMemory",
  STATE_SET_REGISTER: "state.setRegister",
  STATE_RECORD_SGC_FRAMES: "state.recordSgcFrames",
  STATE_GET_SGC_FRAME_DATA: "state.getSgcFrameData",
  STATE_GET_TABLE: "state.getTable",
  STATE_CAPTURE_HOLLY: "state.captureHolly",
  CONTROL_STEP: "control.step",
  CONTROL_STEP_OVER: "control.stepOver",
  CONTROL_STEP_OUT: "control.stepOut",
  CONTROL_RUN_UNTIL: "control.runUntil",
  CONTROL_PAUSE: "control.pause",
  CONTROL_RESET: "control.reset",
  BREAKPOINTS_ADD: "breakpoints.add",
  BREAKPOINTS_REMOVE: "breakpoints.remove",
  BREAKPOINTS_TOGGLE: "breakpoints.toggle",
  BREAKPOINTS_SET_CATEGORY_STATES: "breakpoints.setCategoryStates",
  EVENT_TICK: "event.tick",
} as const;

export const RpcMethodNameSchema = z.enum([
  RpcMethod.DEBUGGER_DESCRIBE,
  RpcMethod.STATE_GET_CALLSTACK,
  RpcMethod.STATE_GET_MEMORY_SLICE,
  RpcMethod.STATE_GET_MEMORY_BINARY,
  RpcMethod.STATE_GET_DISASSEMBLY,
  RpcMethod.STATE_WATCH,
  RpcMethod.STATE_UNWATCH,
  RpcMethod.STATE_EDIT_WATCH,
  RpcMethod.STATE_MODIFY_WATCH_EXPRESSION,
  RpcMethod.STATE_WRITE_MEMORY,
  RpcMethod.STATE_SET_REGISTER,
  RpcMethod.STATE_RECORD_SGC_FRAMES,
  RpcMethod.STATE_GET_SGC_FRAME_DATA,
  RpcMethod.STATE_GET_TABLE,
  RpcMethod.STATE_CAPTURE_HOLLY,
  RpcMethod.CONTROL_STEP,
  RpcMethod.CONTROL_STEP_OVER,
  RpcMethod.CONTROL_STEP_OUT,
  RpcMethod.CONTROL_RUN_UNTIL,
  RpcMethod.CONTROL_PAUSE,
  RpcMethod.CONTROL_RESET,
  RpcMethod.BREAKPOINTS_ADD,
  RpcMethod.BREAKPOINTS_REMOVE,
  RpcMethod.BREAKPOINTS_TOGGLE,
  RpcMethod.BREAKPOINTS_SET_CATEGORY_STATES,
  RpcMethod.EVENT_TICK,
]);

/**
 * Methods whose result type is `RpcError`: they report every failure of a well-formed
 * request in-band, as the result `{"error": {"code", "message"}}`, and `{}` on success.
 * Every other method reports failures as JSON-RPC errors. -32700, -32600 and -32601 are
 * always JSON-RPC errors.
 */
export const IN_BAND_ERROR_METHODS: ReadonlySet<string> = new Set([
  RpcMethod.CONTROL_PAUSE,
  RpcMethod.CONTROL_RUN_UNTIL,
  RpcMethod.CONTROL_STEP,
  RpcMethod.CONTROL_STEP_OVER,
  RpcMethod.CONTROL_STEP_OUT,
  RpcMethod.CONTROL_RESET,
  RpcMethod.BREAKPOINTS_ADD,
  RpcMethod.BREAKPOINTS_REMOVE,
  RpcMethod.BREAKPOINTS_TOGGLE,
  RpcMethod.BREAKPOINTS_SET_CATEGORY_STATES,
  RpcMethod.STATE_WATCH,
  RpcMethod.STATE_UNWATCH,
  RpcMethod.STATE_MODIFY_WATCH_EXPRESSION,
  RpcMethod.STATE_EDIT_WATCH,
  RpcMethod.STATE_WRITE_MEMORY,
  RpcMethod.STATE_SET_REGISTER,
  RpcMethod.STATE_RECORD_SGC_FRAMES,
]);

/**
 * Error codes of the protocol, on either channel. The codes are normative; the text of
 * `error.message` is not: it is a non-empty line for a person, and nothing may depend on its
 * wording.
 */
export const DebuggerErrorCode = {
  /** the frame is not JSON; the response `id` is `null` */
  PARSE_ERROR: -32700,
  /** not a JSON-RPC 2.0 request object, or a batch */
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  /** missing or mistyped parameter, bound exceeded, unknown breakpoint or watch id, unresolvable watch expression, misaligned address */
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** the emulator thread did not service the request within 2 s */
  EMULATOR_BUSY: -32000,
  /** the machine is stopped by the host UI and the request must write or execute */
  STOPPED_BY_HOST: -32001,
  NO_GAME: -32002,
  /** a step was requested while running */
  NOT_PAUSED: -32003,
  /** target, event, capability or milestone the server does not implement */
  NOT_SUPPORTED: -32004,
  /** a step precondition failed */
  CANNOT_STEP: -32005,
  /** nothing in the requested range is readable */
  NOT_READABLE: -32010,
  NO_CAPTURE: -32011,
  /** the sound target is not clocked */
  NOT_CLOCKED: -32012,
  NOT_WRITABLE: -32013,
  CAPTURE_TIMED_OUT: -32014,
} as const;

export type DebuggerErrorCodeValue = (typeof DebuggerErrorCode)[keyof typeof DebuggerErrorCode];

/** Bounds of request parameters and of what a tick carries. A violation is -32602. */
export const PROTOCOL_BOUNDS = {
  addressMax: 0xffffffff,
  memorySliceLength: { min: 1, max: 65536 },
  memoryBinaryLength: { min: 1, max: 16777216 },
  disassemblyCount: { min: 1, max: 1024 },
  callstackMaxFrames: { min: 1, max: 64, default: 32 },
  sgcFrames: { min: 1, max: 4096, default: 1024 },
  writeMemoryLength: { min: 1, max: 65536 },
  watchExpressionLength: 256,
  watchExpressionsPerCall: 64,
  watches: 256,
  breakpoints: 1024,
  /** the transport closes the connection above this */
  inboundMessageBytes: 1048576,
  eventLogEntries: 200,
  callstackFramesPerTick: 32,
  noticeLineLength: 200,
} as const;

/** `EventLogEntry.subsystem` values a v3 server sends. The client renders an unknown one neutrally. */
export const EVENT_SUBSYSTEMS = [
  "sh4",
  "holly",
  "ta",
  "core",
  "aica",
  "dsp",
  "arm7",
  "gdrom",
  "maple",
  "system",
  "debugger",
] as const;

export const EVENT_SEVERITIES = ["trace", "info", "warn", "error"] as const;

/** `executionState.reason` values a v3 server sends. The client treats the field as an open string. */
export const STOP_REASONS = [
  "pause",
  "step",
  "breakpoint",
  "event",
  "reset",
  "start",
  "capture",
  "host-stopped",
  "guest-exit",
  "no-game",
] as const;

/** `MemorySlice.validity` values a v3 server sends (there is no address translation). */
export const MEMORY_VALIDITIES = ["ok"] as const;

export const BREAKPOINT_CATEGORIES = ["events", "sh4", "arm7", "dsp"] as const;

/** `capabilities` of `debugger.describe` (open strings): which optional methods work. */
export const CAPABILITIES = {
  // M1
  EVENT_BREAKPOINTS: "event-breakpoints",
  CALLSTACK: "callstack",
  // M2
  MEMORY_WRITE: "memory-write",
  REGISTER_WRITE: "register-write",
  RESET: "reset",
  // M3
  SGC_CAPTURE: "sgc-capture",
  MEMORY_BINARY: "memory-binary",
  // M4
  TABLES: "tables",
  HOLLY_CAPTURE: "holly-capture",
  // the emulator at the moment of the call; the live form is the tick (`notice`, `dc.timing`)
  SH4_DEBUG_NATIVE: "sh4-debug-native",
  SH4_DEBUG_FALLBACK: "sh4-debug-fallback",
  DSP_FORCED: "dsp-forced",
} as const;

export const TABLE_IDS = ["tlb", "sq", "icache", "ocache", "ocram"] as const;
export const HOLLY_CAPTURE_KINDS = ["core", "ta"] as const;
export const HOLLY_CAPTURE_FORMATS = ["refsw2-log-gzip", "taframe4"] as const;

const uint32 = z.number().int().min(0).max(PROTOCOL_BOUNDS.addressMax);
const within = (bounds: { min: number; max: number }) => z.number().int().min(bounds.min).max(bounds.max);

/**
 * Builds every schema of the protocol. `conformance: false` gives the client's schemas,
 * `conformance: true` the strict copy (see the comment at the top of this file). The static
 * types are those of the client schemas in both cases.
 */
const defineProtocol = (conformance: boolean) => {
  /** an object whose unknown keys fail in the strict copy */
  const object = (conformance ? z.strictObject : z.object) as unknown as typeof z.object;
  /** a field protocol v3 added: a v3 server always sends it, a v2 server never does */
  const always = <T extends z.ZodType>(schema: T): z.ZodOptional<T> =>
    (conformance ? schema : schema.optional()) as unknown as z.ZodOptional<T>;
  /** an open enum: any string for the client, one of the listed values from a v3 server */
  const listed = (values: readonly string[]): z.ZodString =>
    (conformance ? z.enum(values as [string, ...string[]]) : z.string()) as unknown as z.ZodString;
  /** a number that a v3 server sends as an unsigned 32-bit integer (addresses, ids, counters) */
  const unsigned = (): z.ZodNumber => (conformance ? uint32 : z.number());
  /** an array that a v3 server omits instead of sending it empty */
  const nonEmptyWhenPresent = <T extends z.ZodType>(element: T): z.ZodOptional<z.ZodArray<T>> =>
    (conformance ? z.array(element).min(1) : z.array(element)).optional();

  const RegisterValueSchema = object({
    name: z.string(),
    /** "0x" + upper-case hex zero-padded to ceil(width / 4) digits; free text when `width` is 0; "n/a" when it cannot be read */
    value: z.string(),
    /** bits; 0 for free text */
    width: conformance ? z.number().int().min(0) : z.number(),
    flags: z.record(z.string(), z.boolean()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  // Define the base schema without the recursive children
  const BaseDeviceNodeDescriptorSchema = object({
    path: z.string(),
    label: z.string(),
    description: z.string(),
    registers: nonEmptyWhenPresent(RegisterValueSchema),
    events: nonEmptyWhenPresent(z.string()),
    /** panel ids; open strings for the client */
    actions: nonEmptyWhenPresent(listed(PanelIdSchema.options)),
  });

  type DeviceNode = z.infer<typeof BaseDeviceNodeDescriptorSchema> & {
    children?: DeviceNode[];
  };

  const DeviceNodeDescriptorSchema: z.ZodType<DeviceNode> = z.lazy(() =>
    BaseDeviceNodeDescriptorSchema.extend({
      children: nonEmptyWhenPresent(z.lazy(() => DeviceNodeDescriptorSchema)),
    }),
  );

  /** `[offset, length]` runs of bytes that could not be read; those bytes are 0 in the data */
  const UnreadableRunsSchema = nonEmptyWhenPresent(
    z.tuple([conformance ? z.number().int().min(0) : z.number(), conformance ? z.number().int().min(1) : z.number()]),
  );

  const MemorySliceSchema = object({
    baseAddress: unsigned(),
    /** always `length` bytes */
    data: z.array(conformance ? z.number().int().min(0).max(255) : z.number()),
    validity: listed(MEMORY_VALIDITIES),
    unreadable: UnreadableRunsSchema,
  });

  const DisassemblyLineSchema = object({
    address: unsigned(),
    /** space-separated upper-case hex in memory order ("09 00"), or "??" for an unreadable word */
    bytes: z.string(),
    disassembly: z.string(),
  });

  const BreakpointCategorySchema = z.enum(BREAKPOINT_CATEGORIES);

  const BreakpointCategoryStateSchema = object({
    muted: z.boolean(),
    soloed: z.boolean(),
  });

  const BreakpointDescriptorBaseSchema = object({
    id: BreakpointIdSchema,
    event: z.string(), // For code: "dc.sh4.cpu.pc", "dc.aica.dsp.step", etc. For events: "dc.holly.ta.list_end", etc.
    address: unsigned().optional(), // For code breakpoints: the PC/step value. Undefined for event breakpoints.
    kind: z.enum(["code", "event"]),
    enabled: z.boolean(),
  });
  const BreakpointDescriptorSchema = conformance
    ? BreakpointDescriptorBaseSchema.superRefine((breakpoint, ctx) => {
        if (breakpoint.kind === "code" && breakpoint.address === undefined) {
          ctx.addIssue({ code: "custom", message: "a code breakpoint has an address", path: ["address"] });
        }
        // an address given with an event breakpoint is ignored and not stored
        if (breakpoint.kind === "event" && breakpoint.address !== undefined) {
          ctx.addIssue({ code: "custom", message: "an event breakpoint has no address", path: ["address"] });
        }
      })
    : BreakpointDescriptorBaseSchema;

  const BacktraceFrameSchema = object({
    index: z.number(),
    pc: z.number(),
    symbol: z.string().optional(),
    location: z.string().optional(),
  });

  const EventLogEntrySchema = object({
    /** decimal sequence number, unique per process */
    eventId: conformance ? z.string().regex(/^\d+$/) : z.string(),
    /** wall-clock ms */
    timestamp: z.number(),
    subsystem: listed(EVENT_SUBSYSTEMS),
    severity: listed(EVENT_SEVERITIES),
    message: z.string(),
    /** v3: `{ event: "<event name>", cycles: "<decimal>" }` */
    metadata: (conformance
      ? z.strictObject({ event: z.string().min(1), cycles: z.string().regex(/^\d+$/) })
      : z.record(z.string(), z.unknown()).optional()) as unknown as z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>,
  });

  const TransportSettingsSchema = object({
    sessionToken: z.string().optional(),
    build: z.enum(["native", "wasm"]),
  });

  const CallstackFrameSchema = object({
    index: conformance ? z.number().int().min(0) : z.number(),
    pc: unsigned(),
    /** a v3 server sends it in every frame; no client reads more into it than that it is there */
    sp: always(unsigned()),
    /** `name+0xOFF` */
    symbol: z.string().optional(),
    /** v3: "pr", "lr" or "stack+0x.." */
    location: z.string().optional(),
  });

  const TargetBaseSchema = object({
    id: TargetProcessorSchema,
    label: z.string(),
    /** where the current PC / step is in the device tree */
    pcPath: z.string(),
    pcRegister: z.string(),
    /** event name of this target's code breakpoints */
    breakpointEvent: z.string(),
    instructionSize: z.number().int().min(1),
    addressMax: unsigned(),
    /** how panels, inputs and toasts format and parse addresses */
    addressRadix: z.union([z.literal(10), z.literal(16)]),
    addressDigits: z.number().int().min(1),
    defaultDisassemblyAddress: unsigned(),
    /** absent iff `memory` is false */
    defaultMemoryAddress: unsigned().optional(),
    /** state.getMemorySlice works for this target */
    memory: z.boolean(),
    /** control.step* and code breakpoints work for this target */
    stepping: z.boolean(),
  });
  const TargetSchema = conformance
    ? TargetBaseSchema.superRefine((target, ctx) => {
        if (target.memory !== (target.defaultMemoryAddress !== undefined)) {
          ctx.addIssue({
            code: "custom",
            message: "defaultMemoryAddress is present exactly when memory is true",
            path: ["defaultMemoryAddress"],
          });
        }
      })
    : TargetBaseSchema;

  const DebuggerShapeSchema = object({
    emulator: object({
      name: z.string(),
      version: z.string(),
      build: z.enum(["native", "wasm"]),
    }),
    /** absent: a v2 server */
    protocol: always(z.number().int()),
    /** "none" or the version of the UI bundle embedded in the emulator */
    ui: always(z.string()),
    capabilities: always(z.array(z.string())),
    /** a target missing from a present list is unsupported; absent: a v2 server */
    targets: always(z.array(TargetSchema)),
    deviceTree: z.array(DeviceNodeDescriptorSchema),
  });

  const WatchDescriptorSchema = object({
    id: WatchIdSchema,
    expression: z.string(),
    value: (conformance ? z.string() : z.unknown()) as z.ZodUnknown,
  });

  const ExecutionStateBaseSchema = object({
    state: z.enum(["running", "paused"]),
    /** counts stops; absent: a v2 server */
    stopId: always(z.number().int().min(0)),
    /** in every paused tick of a v3 server; never in a running tick */
    reason: listed(STOP_REASONS).optional(),
    /** v3: in every paused tick of a stop caused by a breakpoint. v2: only in the tick of the hit */
    breakpointId: BreakpointIdSchema.optional(),
    /** only when true: running ticks omit `dc.sh4.cpu` */
    registersStale: (conformance ? z.literal(true) : z.boolean()).optional() as z.ZodOptional<z.ZodBoolean>,
    /** one line per fallback or forcing statement, joined with "\n", each at most 200 characters */
    notice: z.string().optional(),
  });
  const ExecutionStateSchema = conformance
    ? ExecutionStateBaseSchema.superRefine((execution, ctx) => {
        if (execution.state === "paused" && execution.reason === undefined) {
          ctx.addIssue({ code: "custom", message: "a paused tick carries a reason", path: ["reason"] });
        }
        if (execution.state === "running" && execution.reason !== undefined) {
          ctx.addIssue({ code: "custom", message: "a running tick carries no reason", path: ["reason"] });
        }
        if (execution.state === "running" && execution.breakpointId !== undefined) {
          ctx.addIssue({ code: "custom", message: "a running tick carries no breakpointId", path: ["breakpointId"] });
        }
        if (execution.notice !== undefined) {
          const lines = execution.notice.split("\n");
          if (lines.some((line) => line.length === 0 || line.length > PROTOCOL_BOUNDS.noticeLineLength)) {
            ctx.addIssue({
              code: "custom",
              message: `every line of a notice has 1 to ${PROTOCOL_BOUNDS.noticeLineLength} characters`,
              path: ["notice"],
            });
          }
        }
      })
    : ExecutionStateBaseSchema;

  const callstackFrames = conformance
    ? z.array(CallstackFrameSchema).max(PROTOCOL_BOUNDS.callstackFramesPerTick)
    : z.array(CallstackFrameSchema);

  const DebuggerTickSchema = object({
    /** increases with every tick built */
    tickId: conformance ? z.number().int().min(0) : z.number(),
    /** wall-clock ms */
    timestamp: z.number(),
    executionState: ExecutionStateSchema,
    /**
     * Merged per path by the client: a path that is present carries its complete register
     * list and replaces the stored one, an absent path keeps its value.
     */
    registers: z.record(z.string(), z.array(RegisterValueSchema)),
    /** key = decimal id */
    breakpoints: z.record(z.string(), BreakpointDescriptorSchema),
    /** oldest first */
    eventLog: conformance ? z.array(EventLogEntrySchema).max(PROTOCOL_BOUNDS.eventLogEntries) : z.array(EventLogEntrySchema),
    /** v3: always, in id order */
    watches: always(z.array(WatchDescriptorSchema)),
    /** v3: always both keys, empty arrays while running */
    callstacks: (conformance
      ? z.strictObject({ sh4: callstackFrames, arm7: callstackFrames })
      : z.record(z.string(), callstackFrames).optional()) as unknown as z.ZodOptional<
      z.ZodRecord<z.ZodString, typeof callstackFrames>
    >,
    /** v3: always the keys events, sh4, arm7, dsp. The client reads only keys it knows */
    categories: (conformance
      ? z.strictObject({
          events: BreakpointCategoryStateSchema,
          sh4: BreakpointCategoryStateSchema,
          arm7: BreakpointCategoryStateSchema,
          dsp: BreakpointCategoryStateSchema,
        })
      : z.record(z.string(), BreakpointCategoryStateSchema).optional()) as unknown as z.ZodOptional<
      z.ZodRecord<z.ZodString, typeof BreakpointCategoryStateSchema>
    >,
  });

  /**
   * `{}` on success. The code is what a client acts on; the message is for a person, and no
   * client depends on its wording. A v3 server sends one that is not empty.
   */
  const RpcErrorSchema = object({
    error: object({
      code: conformance ? z.number().int() : z.number(),
      message: conformance ? z.string().min(1) : z.string(),
    }).optional(),
  });

  const SgcFrameInfoSchema = object({
    frameCount: conformance ? z.number().int().min(0) : z.number(),
    channelsPerFrame: (conformance ? z.literal(64) : z.number()) as z.ZodNumber,
    bytesPerChannel: (conformance ? z.literal(128) : z.number()) as z.ZodNumber,
    totalBytes: unsigned(),
    /** absent: a v2 server, whose binary frame has no header */
    binaryId: always(unsigned()),
  });
  const V2InBandErrorSchema = z.object({
    error: z.object({ code: z.number(), message: z.string() }),
  });

  const targetParam = TargetProcessorSchema;
  const addressParam = uint32;
  const watchExpressionParam = z.string().max(PROTOCOL_BOUNDS.watchExpressionLength);
  const stepParams = object({ target: targetParam });

  // RPC Method Schemas for validation
  const methods = {
    [RpcMethod.DEBUGGER_DESCRIBE]: {
      params: object({
        /** the client's PROTOCOL_VERSION */
        protocol: z.number().optional(),
        /** free text, logged by the server */
        client: z.string().optional(),
      }),
      /** followed by a full tick to this client */
      result: DebuggerShapeSchema,
    },
    [RpcMethod.STATE_GET_CALLSTACK]: {
      params: object({
        target: z.enum(["sh4", "arm7"]),
        maxFrames: within(PROTOCOL_BOUNDS.callstackMaxFrames).optional(),
      }),
      result: object({
        target: (conformance ? z.enum(["sh4", "arm7"]) : TargetProcessorSchema) as typeof TargetProcessorSchema,
        /** at most `maxFrames`, which is at most 64 */
        frames: conformance ? z.array(CallstackFrameSchema).max(PROTOCOL_BOUNDS.callstackMaxFrames.max) : z.array(CallstackFrameSchema),
      }),
    },
    [RpcMethod.STATE_GET_MEMORY_SLICE]: {
      params: object({
        target: targetParam.optional(),
        address: addressParam,
        length: within(PROTOCOL_BOUNDS.memorySliceLength),
      }),
      result: MemorySliceSchema,
    },
    [RpcMethod.STATE_GET_MEMORY_BINARY]: {
      params: object({
        target: targetParam.optional(),
        address: addressParam,
        length: within(PROTOCOL_BOUNDS.memoryBinaryLength),
      }),
      /** then one binary frame of kind 2 with `totalBytes == length` bytes */
      result: object({
        baseAddress: unsigned(),
        totalBytes: unsigned(),
        unreadable: UnreadableRunsSchema,
        binaryId: unsigned(),
      }),
    },
    [RpcMethod.STATE_GET_DISASSEMBLY]: {
      params: object({
        target: targetParam.optional(),
        address: addressParam,
        count: within(PROTOCOL_BOUNDS.disassemblyCount),
        /** ignored */
        context: z.number().optional(),
      }),
      result: object({
        /** exactly `count` lines (fewer only at `addressMax`), addresses stepping by `instructionSize` */
        lines: z.array(DisassemblyLineSchema),
      }),
    },
    [RpcMethod.STATE_WATCH]: {
      params: object({
        expressions: z.array(watchExpressionParam).max(PROTOCOL_BOUNDS.watchExpressionsPerCall),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.STATE_UNWATCH]: {
      params: object({
        watchIds: z.array(WatchIdSchema),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.STATE_EDIT_WATCH]: {
      params: object({
        watchId: WatchIdSchema,
        value: z.string(),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.STATE_MODIFY_WATCH_EXPRESSION]: {
      params: object({
        watchId: WatchIdSchema,
        newExpression: watchExpressionParam,
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.STATE_WRITE_MEMORY]: {
      params: object({
        target: z.enum(["sh4", "arm7"]),
        address: addressParam,
        data: z
          .array(z.number().int().min(0).max(255))
          .min(PROTOCOL_BOUNDS.writeMemoryLength.min)
          .max(PROTOCOL_BOUNDS.writeMemoryLength.max),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.STATE_SET_REGISTER]: {
      params: object({
        path: z.string(),
        name: z.string(),
        /** "0x" hex or decimal, truncated to the register's width */
        value: z.string(),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.STATE_RECORD_SGC_FRAMES]: {
      params: object({
        frames: within(PROTOCOL_BOUNDS.sgcFrames).optional(),
      }),
      /** sent when the capture is complete */
      result: RpcErrorSchema,
    },
    [RpcMethod.STATE_GET_SGC_FRAME_DATA]: {
      params: object({}),
      /**
       * then one binary frame of kind 1 with `frameCount` x 64 x 128 bytes. A v3 server
       * reports "no capture" as the JSON-RPC error -32011; the v2 mock answered with an
       * in-band error object, which only the client schema accepts.
       */
      result: (conformance ? SgcFrameInfoSchema : z.union([SgcFrameInfoSchema, V2InBandErrorSchema])) as z.ZodUnion<
        [typeof SgcFrameInfoSchema, typeof V2InBandErrorSchema]
      >,
    },
    [RpcMethod.STATE_GET_TABLE]: {
      params: object({
        id: z.enum(TABLE_IDS),
      }),
      result: object({
        columns: z.array(z.string()),
        /** every row has `columns.length` cells */
        rows: z.array(z.array(z.string())),
        note: z.string().optional(),
      }),
    },
    [RpcMethod.STATE_CAPTURE_HOLLY]: {
      params: object({
        what: z.enum(HOLLY_CAPTURE_KINDS),
      }),
      /** then one binary frame of kind 3 (core) or 4 (ta) */
      result: object({
        what: z.enum(HOLLY_CAPTURE_KINDS),
        format: z.enum(HOLLY_CAPTURE_FORMATS),
        totalBytes: unsigned(),
        binaryId: unsigned(),
      }),
    },
    [RpcMethod.CONTROL_STEP]: {
      params: stepParams,
      result: RpcErrorSchema,
    },
    [RpcMethod.CONTROL_STEP_OVER]: {
      params: stepParams,
      result: RpcErrorSchema,
    },
    [RpcMethod.CONTROL_STEP_OUT]: {
      params: stepParams,
      result: RpcErrorSchema,
    },
    [RpcMethod.CONTROL_RUN_UNTIL]: {
      params: object({}),
      result: RpcErrorSchema,
    },
    [RpcMethod.CONTROL_PAUSE]: {
      params: object({
        /** ignored: there is one global run state */
        target: targetParam.optional(),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.CONTROL_RESET]: {
      params: object({}),
      result: RpcErrorSchema,
    },
    [RpcMethod.BREAKPOINTS_ADD]: {
      params: object({
        event: z.string(),
        address: addressParam.optional(),
        /** defaults to "code" when `address` is present, else "event" */
        kind: z.enum(["code", "event"]).optional(),
        /** defaults to true */
        enabled: z.boolean().optional(),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.BREAKPOINTS_SET_CATEGORY_STATES]: {
      params: object({
        /** unknown keys are ignored, absent keys keep their state */
        categories: z.record(z.string(), BreakpointCategoryStateSchema),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.BREAKPOINTS_REMOVE]: {
      params: object({
        id: BreakpointIdSchema,
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.BREAKPOINTS_TOGGLE]: {
      params: object({
        id: BreakpointIdSchema,
        enabled: z.boolean(),
      }),
      result: RpcErrorSchema,
    },
    [RpcMethod.EVENT_TICK]: {
      params: DebuggerTickSchema,
      result: z.never(),
    },
  } as const;

  return {
    RegisterValueSchema,
    DeviceNodeDescriptorSchema,
    MemorySliceSchema,
    DisassemblyLineSchema,
    BreakpointCategorySchema,
    BreakpointCategoryStateSchema,
    BreakpointDescriptorSchema,
    BacktraceFrameSchema,
    EventLogEntrySchema,
    TransportSettingsSchema,
    CallstackFrameSchema,
    TargetSchema,
    DebuggerShapeSchema,
    WatchDescriptorSchema,
    ExecutionStateSchema,
    DebuggerTickSchema,
    RpcErrorSchema,
    methods,
  };
};

const clientSchemas = defineProtocol(false);

// Zod Schemas
export const RegisterValueSchema = clientSchemas.RegisterValueSchema;
export const DeviceNodeDescriptorSchema = clientSchemas.DeviceNodeDescriptorSchema;
export const MemorySliceSchema = clientSchemas.MemorySliceSchema;
export const DisassemblyLineSchema = clientSchemas.DisassemblyLineSchema;
export const BreakpointCategorySchema = clientSchemas.BreakpointCategorySchema;
export const BreakpointCategoryStateSchema = clientSchemas.BreakpointCategoryStateSchema;
export const BreakpointDescriptorSchema = clientSchemas.BreakpointDescriptorSchema;
export const BacktraceFrameSchema = clientSchemas.BacktraceFrameSchema;
export const EventLogEntrySchema = clientSchemas.EventLogEntrySchema;
export const TransportSettingsSchema = clientSchemas.TransportSettingsSchema;
export const CallstackFrameSchema = clientSchemas.CallstackFrameSchema;
export const TargetSchema = clientSchemas.TargetSchema;
export const DebuggerShapeSchema = clientSchemas.DebuggerShapeSchema;
export const WatchDescriptorSchema = clientSchemas.WatchDescriptorSchema;
export const ExecutionStateSchema = clientSchemas.ExecutionStateSchema;
export const DebuggerTickSchema = clientSchemas.DebuggerTickSchema;
export const RpcErrorSchema = clientSchemas.RpcErrorSchema;

// RPC Method Schemas for validation
export const DebuggerRpcMethodSchemas = clientSchemas.methods;

/**
 * The strict copy of every schema, for the contract runner: what a v3 server has to send.
 * Unknown keys fail, the v3 fields are required, the open enums are closed.
 */
export const ConformanceSchemas = defineProtocol(true);
export const StrictDebuggerRpcMethodSchemas = ConformanceSchemas.methods;

// Type exports derived from Zod schemas
export type TargetProcessor = z.infer<typeof TargetProcessorSchema>;
export type RpcMethodName = z.infer<typeof RpcMethodNameSchema>;
export type BreakpointId = z.infer<typeof BreakpointIdSchema>;
export type WatchId = z.infer<typeof WatchIdSchema>;
export type RegisterValue = z.infer<typeof RegisterValueSchema>;
export type DeviceNodeDescriptor = z.infer<typeof DeviceNodeDescriptorSchema>;
export type MemorySlice = z.infer<typeof MemorySliceSchema>;
export type DisassemblyLine = z.infer<typeof DisassemblyLineSchema>;
export type BreakpointCategory = z.infer<typeof BreakpointCategorySchema>;
export type BreakpointCategoryState = z.infer<typeof BreakpointCategoryStateSchema>;
export type BreakpointDescriptor = z.infer<typeof BreakpointDescriptorSchema>;
export type BacktraceFrame = z.infer<typeof BacktraceFrameSchema>;
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
export type TransportSettings = z.infer<typeof TransportSettingsSchema>;
export type CallstackFrame = z.infer<typeof CallstackFrameSchema>;
export type DebuggerTarget = z.infer<typeof TargetSchema>;
export type DebuggerShape = z.infer<typeof DebuggerShapeSchema>;
export type WatchDescriptor = z.infer<typeof WatchDescriptorSchema>;
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export type DebuggerTick = z.infer<typeof DebuggerTickSchema>;
export type RpcError = z.infer<typeof RpcErrorSchema>;
export type StopReason = (typeof STOP_REASONS)[number];
export type TableId = (typeof TABLE_IDS)[number];
export type HollyCaptureKind = (typeof HOLLY_CAPTURE_KINDS)[number];

// Helper type to infer TypeScript types from Zod RPC schemas
type InferRpcMethod<T extends { params: z.ZodType; result: z.ZodType }> = {
  params: z.infer<T["params"]>;
  result: z.infer<T["result"]>;
};

type InferRpcSchema<T extends Record<string, { params: z.ZodType; result: z.ZodType }>> = {
  [K in keyof T]: InferRpcMethod<T[K]>;
};

export type DebuggerRpcSchema = RpcSchema & InferRpcSchema<typeof DebuggerRpcMethodSchemas>;

export const DebuggerNotificationSchema = z.object({
  topic: z.literal("tick"),
  payload: DebuggerTickSchema,
});

export type DebuggerNotification = z.infer<typeof DebuggerNotificationSchema>;
