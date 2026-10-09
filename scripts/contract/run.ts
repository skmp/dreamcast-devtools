import { MockDebugger } from "../../server/mockDebugger";
import { listenMockDebugger } from "../../server/mockWebSocket";
import type { MockListener } from "../../server/mockWebSocket";
import type { DebuggerShape, DebuggerTick } from "../../src/lib/debuggerSchema";
import { resolveAddress } from "./elfSymbols";
import type { ElfSymbols } from "./elfSymbols";
import { SCENARIOS, baselineOf, cleanUp, runScenario, selectScenarios } from "./scenarios";
import type { Milestone, Profile, RunContext, ScenarioResult } from "./scenarios";
import { ContractFailure, ContractSession, describeState } from "./session";

export interface ContractOptions {
  /** the server to test; without it the mock is started in this process */
  url?: string;
  profile: Profile;
  elf?: ElfSymbols;
  /**
   * The gate of a milestone: its scenarios are selected, and each of them has to pass. One
   * that ends as not applicable or partial, or that is not run, fails the run. Without it the
   * runner looks at a server: a scenario the server does not claim to support is not
   * applicable, and that is no failure.
   */
  milestone?: Milestone;
  /** the server runs the DSP test program: the anchor and the scenarios of that program alone (the second run of the M3 gate) */
  dspProgram?: boolean;
  /** narrows the selection to these scenarios, also inside a gate */
  only?: Set<string>;
  /** further scenarios that are run and have to pass */
  require?: Set<string>;
  /** multiplies every timeout; default 1 for the mock profile, 5 for the emulator profile */
  timeoutFactor?: number;
  verbose?: boolean;
  /** receives the lines of the report as they are produced */
  say?: (line: string) => void;
}

/** The machine-readable result of a run (`--json`). */
export interface ContractSummary {
  /**
   * At least one scenario passed, none failed, every scenario that had to pass did, no
   * invariant was violated, and the server was put back.
   */
  ok: boolean;
  /** no scenario passed: the run verified nothing, whatever else it says */
  nothingVerified: boolean;
  /** the gate the run was (`--milestone`), and whether it was its run with the DSP test program */
  milestone?: Milestone;
  dspProgram: boolean;
  /** the scenarios the run selected, in the order they were run */
  selected: string[];
  /** the scenarios that had to pass (those of the gate, and `require`), and those of them that did not, with how they ended */
  required: string[];
  requiredNotPassed: Array<{ id: string; status: ScenarioResult["status"] | "not-run" }>;
  url: string;
  profile: Profile;
  timeoutFactor: number;
  server: {
    emulator: { name: string; version: string; build: string };
    protocol: number | undefined;
    ui: string | undefined;
    capabilities: string[];
    targets: Array<{ id: string; memory: boolean; stepping: boolean }>;
  };
  passed: number;
  failed: number;
  partial: number;
  notApplicable: number;
  ticksChecked: number;
  invariantViolations: string[];
  cleanUpProblems: string[];
  /** the run state the server was left in */
  finalState: string;
  scenarios: ScenarioResult[];
}

const STATUS_TEXT: Record<ScenarioResult["status"], string> = {
  passed: "passed",
  failed: "FAILED",
  "not-applicable": "not applicable",
  partial: "partial",
};

export const formatScenario = (result: ScenarioResult): string[] => {
  const label = `${result.id} ${result.title}`.padEnd(34, ".");
  const seconds = `${(result.durationMs / 1000).toFixed(1)} s`;
  const parts = result.parts
    ? ` [${result.parts.map((part) => `${part.name}: ${part.status === "not-applicable" ? "n/a" : part.status}`).join("; ")}]`
    : "";
  const reason = result.status === "not-applicable" && result.details.length > 0 ? `: ${result.details[0]}` : "";
  const lines = [`${label} ${STATUS_TEXT[result.status]}${reason}${parts} (${seconds})`];
  const details = result.status === "not-applicable" ? result.details.slice(1) : result.details;
  for (const detail of details) {
    lines.push(`      ${detail}`);
  }
  return lines;
};


/** Opens the connections of a run: to `url`, or to a mock started in this process. */
const prepare = async (options: ContractOptions) => {
  const say = options.say ?? (() => undefined);
  let listener: MockListener | undefined;
  let url = options.url;
  if (!url) {
    if (options.profile !== "mock") {
      throw new Error("--profile emulator needs --url");
    }
    listener = await listenMockDebugger(new MockDebugger());
    url = listener.url;
    say(`mock debugger started in this process at ${url}`);
  }
  const target = url;
  const timeoutFactor = options.timeoutFactor ?? (options.profile === "emulator" ? 5 : 1);
  const sessions: ContractSession[] = [];
  // every id any tick of the run lists, on any connection (ticks the schema rejected included)
  const seen = { breakpoints: new Set<number>(), watches: new Set<number>() };
  const onTick = (tick: DebuggerTick) => {
    for (const breakpoint of Object.values(tick?.breakpoints ?? {})) {
      seen.breakpoints.add(breakpoint?.id);
    }
    for (const watch of Array.isArray(tick?.watches) ? tick.watches : []) {
      seen.watches.add(watch?.id);
    }
  };
  const openSession = async (): Promise<ContractSession> => {
    const session = new ContractSession(target, {
      timeoutFactor,
      clientName: "nullDC contract runner",
      trace: options.verbose ? (line) => say(`    ${line}`) : undefined,
      onTick,
    });
    sessions.push(session);
    await session.open();
    return session;
  };
  const close = async () => {
    sessions.forEach((session) => session.close());
    await listener?.close();
  };
  return { url: target, timeoutFactor, sessions, seen, openSession, close, say };
};

/**
 * The emulator is started with Debugger:StartPaused=yes, and the runner can be connected
 * before the machine is at that stop: waits for it, and then asks debugger.describe again.
 * What describe said before (no SH4 backend selected yet: neither sh4-debug capability)
 * says nothing about the machine that has started since. Returns the tick the run starts from.
 */
const awaitStartStop = async (session: ContractSession, say: (line: string) => void): Promise<DebuggerTick> => {
  const first = session.latestTick().tick;
  if (first.executionState.reason === "start") {
    return first;
  }
  say(`waiting for the StartPaused stop (the server is ${describeState(first)})`);
  const start = await session
    .waitForTick((tick) => tick.executionState.reason === "start", 10_000, 'a paused tick with reason "start"', 0)
    .catch(() => undefined);
  if (!start) {
    return first;
  }
  const described = await session.describe();
  say(describeServer(session));
  return described.tick;
};

const describeServer = (session: ContractSession): string => {
  const shape = session.shape;
  if (!shape) {
    return "server: debugger.describe gave no result";
  }
  return (
    `server: ${shape.emulator.name} ${shape.emulator.version} (${shape.emulator.build}), protocol ${shape.protocol}, ui ${shape.ui}; ` +
    `capabilities: ${shape.capabilities?.join(", ") || "none"}; ` +
    `targets: ${shape.targets?.map((target) => `${target.id}${target.stepping ? "" : " (no stepping)"}`).join(", ") ?? "none"}`
  );
};

/**
 * Runs the scenarios against a server and returns the summary. The server is left with the
 * breakpoints, watches, categories and run state it had.
 */
export const runContract = async (options: ContractOptions): Promise<ContractSummary> => {
  const { url, timeoutFactor, sessions, seen, openSession, close, say } = await prepare(options);
  const selection = selectScenarios(options);
  const selected = SCENARIOS.filter((scenario) => selection.selected.includes(scenario.id));
  try {
    // A server that cannot be connected to cannot be tested: that error leaves this function.
    // A server that is connected to and does not get as far as the first scenario (no usable
    // answer to debugger.describe, no tick after it) is a server that fails S01.
    let session: ContractSession | undefined;
    let initial: DebuggerTick | undefined;
    let unusable: ContractFailure | undefined;
    try {
      session = await openSession();
      say(describeServer(session));
      initial = options.profile === "emulator" ? await awaitStartStop(session, say) : session.latestTick().tick;
    } catch (error) {
      if (!(error instanceof ContractFailure)) {
        throw error;
      }
      unusable = error;
    }

    const results: ScenarioResult[] = [];
    let problems: string[] = [];
    let final: DebuggerTick | undefined;
    if (session && initial) {
      // what the run leaves behind is compared with this tick
      const baseline = baselineOf(initial);
      say(`initial state: ${describeState(initial)}; profile ${options.profile}, timeouts x${timeoutFactor}`);
      say("");

      const context: RunContext = {
        profile: options.profile,
        url,
        session,
        openSession,
        elf: options.elf,
        milestone: options.milestone,
        dspProgram: options.dspProgram,
        seen,
        note: () => undefined,
      };

      for (const scenario of selected) {
        if (context.session.isClosed) {
          results.push({ id: scenario.id, title: scenario.title, status: "failed", durationMs: 0, details: ["the connection is closed"] });
        } else {
          const result = await runScenario(scenario, context);
          if (result.status === "failed") {
            // leave nothing of a failed scenario behind for the next one
            const leftovers = await cleanUp(context, baseline, false);
            result.details.push(...leftovers.problems.map((problem) => `clean-up: ${problem}`));
          }
          results.push(result);
        }
        formatScenario(results.at(-1)!).forEach(say);
      }

      // remove what is left, restore the categories and the run state, and look at what the server then says
      ({ problems, tick: final } = await cleanUp(context, baseline, true));
    } else {
      // S01 with what was found; nothing else can be asked of this server, and nothing was changed on it
      say("");
      const found = unusable ? [unusable.message, ...unusable.more] : ["debugger.describe gave no result"];
      for (const scenario of selected) {
        const details = scenario.id === "S01" ? found : [`not run: ${found[0]}`];
        results.push({ id: scenario.id, title: scenario.title, status: "failed", durationMs: 0, details });
        formatScenario(results.at(-1)!).forEach(say);
      }
      final = sessions[0]?.ticks.at(-1)?.tick;
    }

    // (read here: awaitStartStop can have replaced what describe said at connect time)
    const shape: DebuggerShape | undefined = sessions[0]?.shape;
    const violations = Array.from(new Set(sessions.flatMap((entry) => entry.violations)));
    const ticksChecked = sessions.reduce((sum, entry) => sum + entry.ticksChecked, 0);
    const count = (status: ScenarioResult["status"]) => results.filter((result) => result.status === status).length;
    const required = selection.required;
    const requiredNotPassed = required
      .map((id) => ({ id, status: results.find((result) => result.id === id)?.status ?? ("not-run" as const) }))
      .filter((entry) => entry.status !== "passed");
    // A run in which no scenario passed has verified nothing: not applicable and partial are
    // no failures of their own, and they are no passes either.
    const nothingVerified = count("passed") === 0;
    const ok = !nothingVerified && count("failed") === 0 && requiredNotPassed.length === 0 && violations.length === 0 && problems.length === 0;
    const summary: ContractSummary = {
      ok,
      nothingVerified,
      ...(options.milestone ? { milestone: options.milestone } : {}),
      dspProgram: options.dspProgram === true,
      selected: selection.selected,
      required,
      requiredNotPassed,
      url,
      profile: options.profile,
      timeoutFactor,
      server: {
        emulator: shape?.emulator ?? { name: "unknown", version: "unknown", build: "unknown" },
        protocol: shape?.protocol,
        ui: shape?.ui,
        capabilities: shape?.capabilities ?? [],
        targets: (shape?.targets ?? []).map((target) => ({ id: target.id, memory: target.memory, stepping: target.stepping })),
      },
      passed: count("passed"),
      failed: count("failed"),
      partial: count("partial"),
      notApplicable: count("not-applicable"),
      ticksChecked,
      invariantViolations: violations,
      cleanUpProblems: problems,
      finalState: final ? describeState(final) : initial ? "connection closed" : "unknown",
      scenarios: results,
    };

    say("");
    for (const problem of problems) {
      say(`clean-up: ${problem}`);
    }
    // violations that no scenario was running for (between scenarios), or that were cut from a scenario's list
    const reported = new Set(results.flatMap((result) => result.details));
    for (const violation of violations.filter((entry) => !reported.has(`invariant: ${entry}`)).slice(0, 20)) {
      say(`invariant: ${violation}`);
    }
    for (const { id, status } of requiredNotPassed.filter((entry) => entry.status !== "failed")) {
      say(`required: ${id} is ${status === "not-run" ? "not run" : STATUS_TEXT[status]}; it has to pass`);
    }
    if (nothingVerified) {
      say(selected.length === 0 ? "nothing verified: the selection leaves no scenario to run" : "nothing verified: no scenario passed");
    }
    say(
      `${count("passed")} passed, ${count("failed")} failed, ${count("partial")} partial, ${count("not-applicable")} not applicable; ` +
        `${ticksChecked} ticks checked, ${violations.length} invariant violation${violations.length === 1 ? "" : "s"}; ` +
        `left ${summary.finalState}`,
    );
    say(ok ? "contract: OK" : "contract: FAILED");
    return summary;
  } finally {
    await close();
  }
};

/**
 * The helper mode of the "breakpoint listed but never hit" measurement: one breakpoint on a
 * hot address with its category muted, the target running, and a client connected (so that
 * the breakpoint stays armed) until the server closes the connection or the process is
 * signalled. Returns the exit code: 1 if the muted breakpoint stopped the target or an
 * invariant was violated.
 */
export const runIdleBreakpoint = async (options: ContractOptions, where: string): Promise<number> => {
  const { openSession, close, say } = await prepare(options);
  try {
    const session = await openSession();
    say(describeServer(session));
    const address = resolveAddress(where, options.elf);
    const tick = options.profile === "emulator" ? await awaitStartStop(session, say) : session.latestTick().tick;
    if (options.profile === "emulator" && tick.executionState.reason !== "start") {
      throw new ContractFailure(`the emulator is not at its StartPaused stop: it is ${describeState(tick)}`);
    }
    const sh4 = session.shape.targets?.find((target) => target.id === "sh4");
    if (!sh4) {
      throw new ContractFailure("the server lists no sh4 target");
    }
    const categories = { ...(tick.categories ?? {}), sh4: { muted: true, soloed: false } };
    await session.call("breakpoints.setCategoryStates", { categories });
    const mark = session.mark();
    await session.call("breakpoints.add", { event: sh4.breakpointEvent, address });
    const listed = await session.waitForTick(
      (candidate) => Object.values(candidate.breakpoints).some((breakpoint) => breakpoint.address === address && breakpoint.enabled),
      1000,
      "a tick that lists the breakpoint",
      mark,
    );
    const id = Object.values(listed.tick.breakpoints).find((breakpoint) => breakpoint.address === address)!.id;
    if (listed.tick.categories?.sh4?.muted !== true) {
      throw new ContractFailure("the sh4 category is not muted in the tick");
    }
    if (tick.executionState.state === "paused") {
      await session.call("control.runUntil", {});
    }
    say(
      `idle breakpoint ${id} at 0x${address.toString(16).toUpperCase().padStart(8, "0")} (${where}), sh4 muted, target running; ` +
        "connected until the server closes the connection",
    );
    const stop = new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await Promise.race([session.untilClosed(), stop]);
    const stops = session.ticks.filter((record) => record.tick.executionState.breakpointId === id);
    say(session.isClosed ? "the server closed the connection" : "interrupted");
    if (stops.length > 0) {
      say(`the muted breakpoint stopped the target ${stops.length} time(s)`);
      return 1;
    }
    if (session.violations.length > 0) {
      Array.from(new Set(session.violations))
        .slice(0, 20)
        .forEach((violation) => say(`invariant: ${violation}`));
      return 1;
    }
    return 0;
  } finally {
    await close();
  }
};
