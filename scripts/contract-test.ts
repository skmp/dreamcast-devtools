import { writeFileSync } from "node:fs";
import { readElfSymbols } from "./contract/elfSymbols";
import type { ElfSymbols } from "./contract/elfSymbols";
import { runContract, runIdleBreakpoint } from "./contract/run";
import { MILESTONES, SCENARIOS, scenariosOfMilestone } from "./contract/scenarios";
import type { Milestone, Profile } from "./contract/scenarios";
import { ContractFailure } from "./contract/session";

/**
 * The contract runner: holds a debugger server to protocol v3.
 *
 *   npm run contract -- [--url ws://host:port/ws] [--profile mock|emulator] [--elf <path>]
 *                       [--milestone M1|M2|M3|M4] [--require S16,S17] [--only S05,S06]
 *                       [--json] [--json-file <path>] [--verbose]
 *   npm run contract -- --url ws://host:port/ws --idle-breakpoint <address|symbol> [--elf <path>]
 *
 * Without --url it starts the mock debugger in this process (no page, no Vite) and runs
 * against that. It talks to the server with the client's own JsonRpcClient and
 * WebSocketTransport, validates every response and every tick with the strict copy of the
 * schema, checks the invariants I1 to I5 on every tick, and runs the scenarios S00 to S18
 * (scripts/contract/). It leaves the server with the breakpoints, watches, categories and run
 * state it found, and exits with 1 when a scenario failed, an invariant was violated or the
 * server could not be put back. A scenario the server does not advertise the capabilities of
 * is "not applicable" (or "partial"), which is neither a pass nor a failure: the gate of a
 * milestone names the scenarios that have to pass with --milestone (or --require), and then
 * such a scenario is exit code 1 as well. 2 means that there was no run: a wrong option, or a server
 * that could not be connected to. What a connected server answers is always a result, with
 * the summary: a debugger.describe that cannot be used is S01 failed.
 */

const USAGE = `usage: npm run contract -- [options]

  --url <ws://host:port/ws>   the server to test; without it the mock is started in this process
  --profile mock|emulator     default: mock without --url, emulator with it
                              emulator: waits for the StartPaused stop, runs S00 and S15,
                              multiplies every timeout by 5
  --elf <path>                the test program, for its entry point and symbols
  --milestone M1|M2|M3|M4     the gate of a milestone: its scenarios and those of the milestones
                              before it have to pass (M1: S00 to S15, M2: and S16, M3: and S17,
                              M4: and S18; S00 and S15 only in the emulator profile). One that
                              is "not applicable" or "partial" fails the run
  --require <ids>             the same for the scenarios named, e.g. --require S16,S17
  --only <ids>                run only these scenarios, e.g. --only S05,S06
  --timeout-factor <n>        multiply every timeout by n instead of the profile's factor
  --json                      print the summary as JSON on stdout (the scenario lines go to stderr)
  --json-file <path>          also write the JSON summary to a file
  --verbose                   print every frame
  --list                      list the scenarios and exit

  --idle-breakpoint <address|symbol>
                              not a test run: at the StartPaused stop mute the sh4 category, add
                              a breakpoint there, resume, and stay connected until the server
                              closes the connection (for the "listed but never hit" measurement)
`;

interface Options {
  url?: string;
  profile: Profile;
  elf?: string;
  only?: Set<string>;
  require?: Set<string>;
  milestone?: Milestone;
  timeoutFactor?: number;
  json: boolean;
  jsonFile?: string;
  verbose: boolean;
  list: boolean;
  idleBreakpoint?: string;
}

const parseArguments = (argv: string[]): Options => {
  const options: Options = { profile: "mock", json: false, verbose: false, list: false };
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
      case "--milestone": {
        const milestone = value(index++, flag).toUpperCase();
        if (!(MILESTONES as readonly string[]).includes(milestone)) {
          throw new Error(`--milestone is one of ${MILESTONES.join(", ")}, not "${milestone}"`);
        }
        options.milestone = milestone as Milestone;
        break;
      }
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
  return options;
};

const idsOf = (list: string): Set<string> =>
  new Set(
    list
      .split(",")
      .map((id) => id.trim().toUpperCase())
      .filter(Boolean),
  );

/**
 * The scenarios that have to pass: those of --require, and those of the gate of --milestone
 * (of them, the ones that --only selects: a gate can be run in pieces).
 */
const requiredOf = (options: Options): Set<string> | undefined => {
  if (!options.require && !options.milestone) {
    return undefined;
  }
  const gate = options.milestone ? scenariosOfMilestone(options.milestone, options.profile) : [];
  return new Set([...(options.require ?? []), ...gate.filter((id) => !options.only || options.only.has(id))]);
};

const main = async (): Promise<number> => {
  const options = parseArguments(process.argv.slice(2));
  // with --json, stdout carries the JSON document and nothing else
  const say = (line: string) => (options.json ? process.stderr : process.stdout).write(`${line}\n`);

  if (options.list) {
    for (const scenario of SCENARIOS) {
      say(`${scenario.id} ${scenario.title}`);
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
    only: options.only,
    require: requiredOf(options),
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
