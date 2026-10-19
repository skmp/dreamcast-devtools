import { writeFileSync } from "node:fs";
import { readElfSymbols } from "./contract/elfSymbols";
import type { ElfSymbols } from "./contract/elfSymbols";
import { runContract, runIdleBreakpoint } from "./contract/run";
import { MILESTONES, SCENARIOS } from "./contract/scenarios";
import type { Milestone, Profile } from "./contract/scenarios";
import { ContractFailure } from "./contract/session";

/**
 * The contract runner: holds a debugger server to protocol v3.
 *
 *   npm run contract -- [--url ws://host:port/ws] [--profile mock|emulator] [--elf <path>]
 *                       [--milestone M1|M2|M3|M4] [--dsp-program] [--require S16,S17]
 *                       [--only S05,S06] [--parts S16:arm7+tree] [--require-note <text>]
 *                       [--mock-support m1|m2|m3] [--json] [--json-file <path>] [--verbose]
 *   npm run contract -- --url ws://host:port/ws --idle-breakpoint <address|symbol> [--elf <path>]
 *
 * Without --url it starts the mock debugger in this process (no page, no Vite) and runs
 * against that. It talks to the server with the client's own JsonRpcClient and
 * WebSocketTransport, validates every response and every tick with the strict copy of the
 * schema, checks the invariants I1 to I8 on every tick, and runs the scenarios S00 to S21
 * (scripts/contract/). It leaves the server with the breakpoints, watches, categories and run
 * state it found.
 *
 * A gate is a run that names a milestone: --milestone selects the scenarios of that
 * milestone and requires each of them to pass, so "not applicable" and "partial" fail it.
 * Without --milestone the runner looks at a server, and a scenario the server does not claim
 * to support is not applicable, which is no failure; but a run in which no scenario passed has
 * verified nothing and fails. --only narrows the selection and never turns an empty result
 * into a success.
 *
 * Exit codes: 0, every selected scenario that had to pass passed, no invariant was violated
 * and the server was put back; 1, anything else that is a result; 2, there was no run: a
 * wrong option, or a server that could not be connected to. What a connected server answers
 * is always a result, with the summary: a debugger.describe that cannot be used is S01 failed.
 */

const USAGE = `usage: npm run contract -- [options]

  --url <ws://host:port/ws>   the server to test; without it the mock is started in this process
  --profile mock|emulator     default: mock without --url, emulator with it
                              emulator: waits for the StartPaused stop, runs S00 and S15,
                              multiplies every timeout by 5
  --elf <path>                the test program, for its entry point and symbols
  --milestone M1|M2|M3|M4     the gate of a milestone: its scenarios, and those of the milestones
                              before it, are selected, and each of them has to pass (M1: S00 to
                              S15, S19, S20; M2: and S16; M3: and S17; M4: and S18; S00 and S15
                              in the emulator profile only). One that is "not applicable" or
                              "partial" fails the gate
  --dsp-program               the server runs the DSP test program: the second run of the gate
                              of M3 (and M4), which selects S00, S17 and S21. The mock the
                              runner starts for it is paused at its start with its ARM7 held
  --require <ids>             further scenarios that are run and have to pass, e.g. --require S16
  --only <ids>                narrow the selection to these scenarios, e.g. --only S05,S06; a
                              selection that leaves nothing to pass is a failed run
  --parts <id>:<part>[+<part>...]
                              run only these parts of a scenario that has parts, e.g.
                              --parts S16:arm7 (S16: arm7, writeMemory, setRegister, reset, tree).
                              Each named part has to pass: one that is not applicable fails.
                              Not with --milestone: a gate is whole
  --require-note <text>       the run is no pass unless a selected scenario noted exactly this
                              text, e.g. --require-note "arm7: bl stepped over and out"; may be
                              given more than once, also with --milestone
  --mock-support m1|m2|m3     the mock that is started in this process implements what the
                              emulator does in that milestone and no more (not with --url)
  --timeout-factor <n>        multiply every timeout by n instead of the profile's factor
  --json                      print the summary as JSON on stdout (the scenario lines go to stderr)
  --json-file <path>          also write the JSON summary to a file
  --verbose                   print every frame
  --list                      list the scenarios and exit

  --idle-breakpoint <address|symbol>
                              not a test run: at the StartPaused stop mute the sh4 category, add
                              a breakpoint there, resume, and stay connected until the server
                              closes the connection (for the "listed but never hit" measurement)

exit code: 0 passed; 1 a result that is not a pass; 2 no run (a wrong option, no connection)
`;

interface Options {
  url?: string;
  profile: Profile;
  elf?: string;
  only?: Set<string>;
  require?: Set<string>;
  parts?: Map<string, Set<string>>;
  requireNotes: string[];
  mockSupport?: "m1" | "m2" | "m3";
  milestone?: Milestone;
  dspProgram: boolean;
  timeoutFactor?: number;
  json: boolean;
  jsonFile?: string;
  verbose: boolean;
  list: boolean;
  idleBreakpoint?: string;
}

const parseArguments = (argv: string[]): Options => {
  const options: Options = { profile: "mock", dspProgram: false, json: false, verbose: false, list: false, requireNotes: [] };
  let profileGiven = false;
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    switch (flag) {
      case "--url":
        options.url = value(index++, flag);
        break;
      case "--profile": {
        const profile = value(index++, flag);
        if (profile !== "mock" && profile !== "emulator") {
          throw new Error(`--profile is mock or emulator, not "${profile}"`);
        }
        options.profile = profile;
        profileGiven = true;
        break;
      }
      case "--elf":
        options.elf = value(index++, flag);
        break;
      case "--only":
        options.only = idsOf(value(index++, flag));
        break;
      case "--require":
        options.require = idsOf(value(index++, flag));
        break;
      case "--parts": {
        // <scenario>:<part>[+<part>...]; the keys of the parts are written as --list prints them
        const [id, list, ...rest] = value(index++, flag).split(":");
        const keys = (list ?? "").split("+").map((key) => key.trim()).filter(Boolean);
        if (rest.length > 0 || keys.length === 0) {
          throw new Error("--parts is <scenario>:<part>[+<part>...], e.g. --parts S16:arm7+tree");
        }
        const scenario = id.trim().toUpperCase();
        (options.parts ??= new Map<string, Set<string>>()).set(scenario, new Set([...(options.parts.get(scenario) ?? []), ...keys]));
        break;
      }
      case "--require-note": {
        // (a note may start with anything, "--" included: the next argument is the text)
        const text = argv[++index];
        if (text === undefined || text === "") {
          throw new Error("--require-note needs the text of a note");
        }
        options.requireNotes.push(text);
        break;
      }
      case "--mock-support": {
        const support = value(index++, flag).toLowerCase();
        if (support !== "m1" && support !== "m2" && support !== "m3") {
          throw new Error(`--mock-support is m1, m2 or m3, not "${support}"`);
        }
        options.mockSupport = support;
        break;
      }
      case "--milestone": {
        const milestone = value(index++, flag).toUpperCase();
        if (!(MILESTONES as readonly string[]).includes(milestone)) {
          throw new Error(`--milestone is one of ${MILESTONES.join(", ")}, not "${milestone}"`);
        }
        options.milestone = milestone as Milestone;
        break;
      }
      case "--dsp-program":
        options.dspProgram = true;
        break;
      case "--timeout-factor": {
        const factor = Number(value(index++, flag));
        if (!(factor > 0)) {
          throw new Error("--timeout-factor needs a positive number");
        }
        options.timeoutFactor = factor;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--json-file":
        options.jsonFile = value(index++, flag);
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--idle-breakpoint":
        options.idleBreakpoint = value(index++, flag);
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  if (!profileGiven && options.url) {
    options.profile = "emulator";
  }
  if (options.url && !/^wss?:\/\//.test(options.url)) {
    throw new Error(`--url is a ws:// or wss:// URL, not "${options.url}"`);
  }
  const known = new Set(SCENARIOS.map((scenario) => scenario.id));
  for (const [flag, ids] of [
    ["--only", options.only],
    ["--require", options.require],
  ] as const) {
    for (const id of ids ?? []) {
      if (!known.has(id)) {
        throw new Error(`${flag}: there is no scenario ${id}`);
      }
    }
  }
  // a scenario that --only leaves out cannot pass
  for (const id of options.require ?? []) {
    if (options.only && !options.only.has(id)) {
      throw new Error(`--require ${id}: --only leaves that scenario out`);
    }
  }
  // --parts names parts that exist, of a scenario that is run; and a gate is run whole
  for (const [id, keys] of options.parts ?? []) {
    const scenario = SCENARIOS.find((candidate) => candidate.id === id);
    if (!scenario) {
      throw new Error(`--parts: there is no scenario ${id}`);
    }
    if (!scenario.parts) {
      throw new Error(`--parts ${id}: that scenario has no parts`);
    }
    for (const key of keys) {
      if (!scenario.parts.includes(key)) {
        throw new Error(`--parts ${id}: it has no part "${key}"; its parts are ${scenario.parts.join(", ")}`);
      }
    }
    if (options.only && !options.only.has(id)) {
      throw new Error(`--parts ${id}: --only leaves that scenario out`);
    }
  }
  if (options.parts && options.milestone) {
    throw new Error(`--parts with --milestone: the gate of ${options.milestone} is its scenarios whole; --only ${Array.from(options.parts.keys()).join(",")} --parts ... runs a part by itself`);
  }
  if (options.mockSupport && options.url) {
    throw new Error("--mock-support is for the mock the runner starts itself: not with --url");
  }
  if (options.dspProgram && options.milestone && MILESTONES.indexOf(options.milestone) < MILESTONES.indexOf("M3")) {
    throw new Error(`--dsp-program is the second run of the gate of M3: the gate of ${options.milestone} has no scenario for it`);
  }
  return options;
};

const idsOf = (list: string): Set<string> =>
  new Set(
    list
      .split(",")
      .map((id) => id.trim().toUpperCase())
      .filter(Boolean),
  );

const main = async (): Promise<number> => {
  const options = parseArguments(process.argv.slice(2));
  // with --json, stdout carries the JSON document and nothing else
  const say = (line: string) => (options.json ? process.stderr : process.stdout).write(`${line}\n`);

  if (options.list) {
    for (const scenario of SCENARIOS) {
      const notes = [
        scenario.milestone ?? "M1",
        ...(scenario.emulatorOnly ? ["emulator profile"] : []),
        ...(scenario.dspProgram === "only" ? ["--dsp-program"] : scenario.dspProgram === "also" ? ["also with --dsp-program"] : []),
        ...(scenario.parts ? [`parts: ${scenario.parts.join(", ")}`] : []),
      ];
      say(`${scenario.id} ${scenario.title} (${notes.join(", ")})`);
    }
    return 0;
  }

  let elf: ElfSymbols | undefined;
  if (options.elf) {
    elf = readElfSymbols(options.elf);
    say(`ELF ${options.elf}: entry 0x${elf.entry.toString(16).toUpperCase()}, ${elf.symbols.size} symbols`);
  }
  const common = {
    url: options.url,
    profile: options.profile,
    elf,
    milestone: options.milestone,
    dspProgram: options.dspProgram,
    only: options.only,
    require: options.require,
    parts: options.parts,
    requireNotes: options.requireNotes,
    mockSupport: options.mockSupport,
    timeoutFactor: options.timeoutFactor,
    verbose: options.verbose,
    say,
  };

  if (options.idleBreakpoint !== undefined) {
    return runIdleBreakpoint(common, options.idleBreakpoint);
  }

  const summary = await runContract(common);
  if (options.jsonFile) {
    writeFileSync(options.jsonFile, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary.ok ? 0 : 1;
};

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    const text = error instanceof ContractFailure ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`contract: ${text}\n`);
    process.exit(2);
  },
);
