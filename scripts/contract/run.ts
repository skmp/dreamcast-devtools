import { MockDebugger } from "../../server/mockDebugger";
import { listenMockDebugger } from "../../server/mockWebSocket";
import type { MockListener } from "../../server/mockWebSocket";
import type { BreakpointCategoryState, DebuggerTick } from "../../src/lib/debuggerSchema";
import { resolveAddress } from "./elfSymbols";
import type { ElfSymbols } from "./elfSymbols";
import { SCENARIOS, cleanUp, runScenario } from "./scenarios";
import type { Profile, RunContext, ScenarioResult } from "./scenarios";
import { ContractFailure, ContractSession, describeState } from "./session";

export interface ContractOptions {
  /** the server to test; without it the mock is started in this process */
  url?: string;
  profile: Profile;
  elf?: ElfSymbols;
  /** run only these scenarios */
  only?: Set<string>;
  /** multiplies every timeout; default 1 for the mock profile, 5 for the emulator profile */
  timeoutFactor?: number;
  verbose?: boolean;
  /** receives the lines of the report as they are produced */
  say?: (line: string) => void;
}

/** The machine-readable result of a run (`--json`). */
export interface ContractSummary {
  /** no scenario failed, no invariant was violated, everything was cleaned up */
  ok: boolean;
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
  const openSession = async (): Promise<ContractSession> => {
    const session = new ContractSession(target, {
      timeoutFactor,
      clientName: "nullDC contract runner",
      trace: options.verbose ? (line) => say(`    ${line}`) : undefined,
    });
    sessions.push(session);
    await session.open();
    return session;
  };
  const close = async () => {
    sessions.forEach((session) => session.close());
    await listener?.close();
  };
  return { url: target, timeoutFactor, sessions, openSession, close, say };
};

const describeServer = (session: ContractSession): string => {
  const shape = session.shape;
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
  const { url, timeoutFactor, sessions, openSession, close, say } = await prepare(options);
  try {
    const session = await openSession();
    const shape = session.shape;
    say(describeServer(session));

    let initial: DebuggerTick = session.latestTick().tick;
    if (options.profile === "emulator" && initial.executionState.reason !== "start") {
      // the emulator is started with Debugger:StartPaused=yes; the stop can still be on its way
      say(`waiting for the StartPaused stop (the server is ${describeState(initial)})`);
      const start = await session
        .waitForTick((tick) => tick.executionState.reason === "start", 10_000, 'a paused tick with reason "start"', 0)
        .catch(() => undefined);
      initial = start?.tick ?? initial;
    }
    const initialState = initial.executionState.state;
    const initialCategories = initial.categories
      ? (JSON.parse(JSON.stringify(initial.categories)) as Record<string, BreakpointCategoryState>)
      : undefined;
    say(`initial state: ${describeState(initial)}; profile ${options.profile}, timeouts x${timeoutFactor}`);
    say("");

    const context: RunContext = {
      profile: options.profile,
      url,
      session,
      openSession,
      elf: options.elf,
      breakpoints: new Set(),
      watches: new Set(),
      note: () => undefined,
    };

    const results: ScenarioResult[] = [];
    for (const scenario of SCENARIOS) {
      if (options.only && !options.only.has(scenario.id)) {
        continue;
      }
      if (context.session.isClosed) {
        results.push({ id: scenario.id, title: scenario.title, status: "failed", durationMs: 0, details: ["the connection is closed"] });
      } else {
        const result = await runScenario(scenario, context);
        if (result.status === "failed") {
          // leave nothing of a failed scenario behind for the next one
          const leftovers = await cleanUp(context, initialCategories);
          result.details.push(...leftovers.map((problem) => `clean-up: ${problem}`));
        }
        results.push(result);
      }
      formatScenario(results.at(-1)!).forEach(say);
    }

    // remove what is left, restore the categories and the run state
    const problems = await cleanUp(context, initialCategories);
    if (!context.session.isClosed) {
      const last = context.session.latestTick().tick;
      if (last.executionState.state !== initialState) {
        try {
          // the tick can arrive in the same turn as the response: look from before the request
          const mark = context.session.mark();
          await context.session.call(initialState === "paused" ? "control.pause" : "control.runUntil", {});
          await context.session.waitForTick((tick) => tick.executionState.state === initialState, 2000, `the server is ${initialState} again`, mark);
        } catch (error) {
          problems.push(`restoring the run state: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const final = context.session.isClosed ? undefined : context.session.latestTick().tick;

    const violations = Array.from(new Set(sessions.flatMap((entry) => entry.violations)));
    const ticksChecked = sessions.reduce((sum, entry) => sum + entry.ticksChecked, 0);
    const count = (status: ScenarioResult["status"]) => results.filter((result) => result.status === status).length;
    const ok = count("failed") === 0 && violations.length === 0 && problems.length === 0;
    const summary: ContractSummary = {
      ok,
      url,
      profile: options.profile,
      timeoutFactor,
      server: {
        emulator: shape.emulator,
        protocol: shape.protocol,
        ui: shape.ui,
        capabilities: shape.capabilities ?? [],
        targets: (shape.targets ?? []).map((target) => ({ id: target.id, memory: target.memory, stepping: target.stepping })),
      },
      passed: count("passed"),
      failed: count("failed"),
      partial: count("partial"),
      notApplicable: count("not-applicable"),
      ticksChecked,
      invariantViolations: violations,
      cleanUpProblems: problems,
      finalState: final ? describeState(final) : "connection closed",
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
    const sh4 = session.shape.targets?.find((target) => target.id === "sh4");
    if (!sh4) {
      throw new ContractFailure("the server lists no sh4 target");
    }
    let tick = session.latestTick().tick;
    if (options.profile === "emulator" && tick.executionState.reason !== "start") {
      tick = (await session.waitForTick((candidate) => candidate.executionState.reason === "start", 10_000, 'a paused tick with reason "start"', 0)).tick;
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
