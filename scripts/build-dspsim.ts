// npm run build:dspsim -- --emulator <emulator tree> [--emcc-version <version>]
// (or NULLDC_DIR=<emulator tree> npm run build:dspsim)
//
// Regenerates src/wasm/aica-dsp-core/, the DSP of the playground, from an emulator tree (nullDC 3.0.0: the
// repository skmp/nulldc3):
//
//   aica_dsp_core.wasm, aica_dsp_core.mjs  as <tree>/libswirl/hw/aica/dsp_core/wasm/build.sh --check writes them:
//                                          two builds that are the same bytes, with no path of this machine in them
//   PROVENANCE.json                        the tree's commit, the last commit of dsp_core, whether dsp_core has
//                                          changes, the emscripten version, the interface version, the two files'
//                                          sizes and sha256
//   known-answers.json                     the native core's answers to its known-answer programs
//                                          (<tree>/tests/aica_dsp/dsp_known.cpp), written by scripts/dspsim-known.cpp
//                                          compiled here with the tree's core; src/lib/aicaDspKnown.test.ts holds the
//                                          module to them
//
// The emscripten version is pinned: the emcc that build.sh uses (the PATH's, else the one of the emsdk in $EMSDK,
// else in ~/emsdk, under upstream/emscripten, found as build.sh finds it) has to report with `emcc -dumpversion`
// the version PROVENANCE.json names, compared as strings; another emscripten gives other bytes. --emcc-version
// <version> names the version to accept instead, and PROVENANCE.json then records it.
//
// Nothing here is run by the build or the tests: a fresh clone builds, type-checks and tests with the committed
// files, without emcc, a C++ compiler or the emulator tree. The C++ compiler of the native driver is $CXX, else c++.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the module is committed. */
export const MODULE_DIR = join(ROOT, "src", "wasm", "aica-dsp-core");

/** The files build.sh writes, which the emulator's aica.dsp.wasm.devtools replays its trace on. */
export const MODULE_FILES = ["aica_dsp_core.wasm", "aica_dsp_core.mjs"] as const;

export const PROVENANCE_FILE = "PROVENANCE.json";
export const KNOWN_ANSWERS_FILE = "known-answers.json";

/** The repository the module is built from. */
export const REPOSITORY = "skmp/nulldc3";

/** dsp_core in an emulator tree. */
const DSP_CORE = "libswirl/hw/aica/dsp_core";

/** PROVENANCE.json: these keys and no others, in this order (the emulator's aica.dsp.wasm.devtools reads it). */
export interface Provenance {
  repository: string;
  /** git rev-parse HEAD of the emulator tree */
  treeCommit: string;
  /** git log -1 --format=%H -- libswirl/hw/aica/dsp_core */
  dspCoreCommit: string;
  /** git status --porcelain -- libswirl/hw/aica/dsp_core is not empty */
  dirty: boolean;
  /** emcc -dumpversion of the emcc build.sh uses */
  emscripten: string;
  /** AICA_DSP_API_VERSION */
  apiVersion: number;
  files: Record<(typeof MODULE_FILES)[number], { bytes: number; sha256: string }>;
}

export const PROVENANCE_KEYS = ["repository", "treeCommit", "dspCoreCommit", "dirty", "emscripten", "apiVersion", "files"] as const;

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The lookup of build.sh, word for word: emcc on the PATH, else the PATH gets ${EMSDK:-$HOME/emsdk}/upstream/emscripten
 * in front. Then that emcc's -dumpversion.
 */
const EMCC_VERSION_SCRIPT = `
if ! command -v emcc >/dev/null 2>&1; then
	PATH="\${EMSDK:-$HOME/emsdk}/upstream/emscripten:$PATH"
	export PATH

	if ! command -v emcc >/dev/null 2>&1; then
		echo "no emcc on the PATH and no emsdk in \${EMSDK:-$HOME/emsdk}" >&2
		exit 3
	fi
fi
command -v emcc >&2
emcc -dumpversion
`;

/** What `emcc -dumpversion` says of the emcc that build.sh would use with this environment; where it is goes to `where`. */
export const findEmccVersion = (env: NodeJS.ProcessEnv): { version: string; where: string } => {
  const run = spawnSync("/bin/sh", ["-c", EMCC_VERSION_SCRIPT], { env, encoding: "utf8" });
  if (run.error) {
    throw new Error(`build:dspsim: cannot run sh: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`build:dspsim: ${run.stderr.trim() || `the lookup of emcc failed (exit ${run.status})`}`);
  }
  const version = run.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!version) {
    throw new Error("build:dspsim: emcc -dumpversion said nothing");
  }
  return { version, where: run.stderr.trim() };
};

/** The version an emcc has to report: the one asked for, else the one PROVENANCE.json names. */
export const requiredEmccVersion = (asked: string | undefined, provenance: Partial<Provenance> | null): string => {
  if (asked !== undefined) {
    return asked;
  }
  if (provenance && typeof provenance.emscripten === "string" && provenance.emscripten !== "") {
    return provenance.emscripten;
  }
  throw new Error(`build:dspsim: ${PROVENANCE_FILE} names no emscripten version: name the one to build with, --emcc-version <version>`);
};

/** Refuses an emcc of another version than the one required (strings, as they are). */
export const checkEmccVersion = (found: string, required: string, asked: boolean): void => {
  if (found !== required) {
    throw new Error(
      asked
        ? `build:dspsim: emcc reports ${found}, --emcc-version asks for ${required}`
        : `build:dspsim: emcc reports ${found}, ${PROVENANCE_FILE} names ${required}: another emscripten gives other bytes. ` +
            `To regenerate the module with ${found} and record it: --emcc-version ${found}`,
    );
  }
};

/** The words of this machine that may not be in a committed file: its paths, its home, its host name. */
export const machineWords = (paths: string[]): string[] => {
  const words = new Set<string>(["/home/", "/Users/", "/tmp/", "\\Users\\", "emsdk"]);
  for (const path of [homedir(), tmpdir(), ...paths]) {
    if (path && path !== "/") {
      words.add(path);
    }
  }
  const host = hostname();
  if (host.length >= 4) {
    words.add(host);
  }
  return [...words];
};

/** The first of `words` that is in `bytes`, or undefined. */
export const findMachineWord = (bytes: Uint8Array, words: string[]): string | undefined => {
  const text = Buffer.from(bytes).toString("latin1");
  return words.find((word) => text.includes(Buffer.from(word, "utf8").toString("latin1")));
};

export interface Options {
  tree: string;
  emccVersion?: string;
}

export const parseArguments = (argv: string[], env: NodeJS.ProcessEnv): Options => {
  let tree = env.NULLDC_DIR || undefined;
  let emccVersion: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`build:dspsim: ${argument} needs a value`);
      }
      return next;
    };
    if (argument === "--emulator") {
      tree = value();
    } else if (argument === "--emcc-version") {
      emccVersion = value();
    } else {
      throw new Error(`build:dspsim: unknown argument ${argument}\nusage: npm run build:dspsim -- --emulator <emulator tree> [--emcc-version <version>]`);
    }
  }
  if (!tree) {
    throw new Error("build:dspsim: no emulator tree: --emulator <tree>, or NULLDC_DIR=<tree>");
  }
  return { tree: resolve(tree), emccVersion };
};

const git = (tree: string, args: string[]): string => {
  const run = spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`build:dspsim: git ${args.join(" ")} failed in the emulator tree: ${run.stderr.trim()}`);
  }
  return run.stdout.trim();
};

const runOrFail = (what: string, command: string, args: string[], options: { cwd?: string } = {}): void => {
  const run = spawnSync(command, args, { stdio: "inherit", ...options });
  if (run.error) {
    throw new Error(`build:dspsim: ${what}: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`build:dspsim: ${what} failed (exit ${run.status ?? run.signal})`);
  }
};

const readProvenance = (): Partial<Provenance> | null => {
  const path = join(MODULE_DIR, PROVENANCE_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<Provenance>) : null;
};

const main = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2), process.env);
  const tree = options.tree;
  const buildScript = join(tree, DSP_CORE, "wasm", "build.sh");
  const capi = join(tree, DSP_CORE, "wasm", "aica_dsp_capi.h");
  const known = join(tree, "tests", "aica_dsp", "dsp_known.cpp");
  for (const path of [buildScript, capi, known]) {
    if (!existsSync(path)) {
      throw new Error(`build:dspsim: ${path} is not there: --emulator names no emulator tree with the DSP core`);
    }
  }

  // the pinned emscripten, before anything is built
  const required = requiredEmccVersion(options.emccVersion, readProvenance());
  const emcc = findEmccVersion(process.env);
  console.log(`build:dspsim: emcc ${emcc.version} (${emcc.where})`);
  checkEmccVersion(emcc.version, required, options.emccVersion !== undefined);

  const apiDefine = /#define\s+AICA_DSP_API_VERSION\s+(\d+)/.exec(readFileSync(capi, "utf8"));
  if (!apiDefine) {
    throw new Error("build:dspsim: aica_dsp_capi.h defines no AICA_DSP_API_VERSION");
  }
  const apiVersion = Number(apiDefine[1]);

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "build-dspsim-")));
  try {
    const out = join(scratch, "module");
    runOrFail("build.sh --check", "sh", [buildScript, "--check", out]);
    const files = Object.fromEntries(MODULE_FILES.map((name) => [name, readFileSync(join(out, name))])) as Record<
      (typeof MODULE_FILES)[number],
      Buffer
    >;

    // the loader of this build loads its module and has its interface version
    const loader = (await import(pathToFileURL(join(out, "aica_dsp_core.mjs")).href)) as {
      AICA_DSP_API_VERSION: number;
      loadAicaDsp: (source: Uint8Array) => Promise<unknown>;
    };
    await loader.loadAicaDsp(files["aica_dsp_core.wasm"]);
    if (loader.AICA_DSP_API_VERSION !== apiVersion) {
      throw new Error(`build:dspsim: the loader has interface version ${loader.AICA_DSP_API_VERSION}, aica_dsp_capi.h ${apiVersion}`);
    }

    // the native core's answers to its known-answer programs
    const driver = join(scratch, "dspsim-known");
    const cxx = process.env.CXX || "c++";
    runOrFail(`${cxx} of scripts/dspsim-known.cpp`, cxx, [
      "-std=c++20",
      "-O2",
      `-I${join(tree, "libswirl")}`,
      `-I${join(tree, "tests", "aica_dsp")}`,
      join(ROOT, "scripts", "dspsim-known.cpp"),
      join(tree, DSP_CORE, "aica_dsp_core.cpp"),
      known,
      "-o",
      driver,
    ]);
    const answersPath = join(scratch, "known.json");
    runOrFail("dspsim-known", driver, [answersPath]);
    const answers = JSON.parse(readFileSync(answersPath, "utf8")) as { apiVersion: number; known: number; groups: string[]; trace: number[] };
    if (answers.apiVersion !== apiVersion) {
      throw new Error(`build:dspsim: the native driver has interface version ${answers.apiVersion}, aica_dsp_capi.h ${apiVersion}`);
    }

    const provenance: Provenance = {
      repository: REPOSITORY,
      treeCommit: git(tree, ["rev-parse", "HEAD"]),
      dspCoreCommit: git(tree, ["log", "-1", "--format=%H", "--", DSP_CORE]),
      dirty: git(tree, ["status", "--porcelain", "--", DSP_CORE]) !== "",
      emscripten: emcc.version,
      apiVersion,
      files: {
        "aica_dsp_core.wasm": { bytes: files["aica_dsp_core.wasm"].length, sha256: sha256(files["aica_dsp_core.wasm"]) },
        "aica_dsp_core.mjs": { bytes: files["aica_dsp_core.mjs"].length, sha256: sha256(files["aica_dsp_core.mjs"]) },
      },
    };
    const knownAnswers = {
      about:
        "The answers of the emulator's DSP core, natively, to its known-answer programs (tests/aica_dsp/dsp_known.cpp of the tree in PROVENANCE.json): written by npm run build:dspsim with scripts/dspsim-known.cpp, for the module beside it (src/lib/aicaDspKnown.test.ts).",
      module: { "aica_dsp_core.wasm": provenance.files["aica_dsp_core.wasm"].sha256 },
      treeCommit: provenance.treeCommit,
      apiVersion,
      known: answers.known,
      groups: answers.groups,
      trace: answers.trace,
    };

    const written: Record<string, Uint8Array> = {
      ...files,
      // the keys in the order of Provenance, which is PROVENANCE_KEYS
      [PROVENANCE_FILE]: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`),
      [KNOWN_ANSWERS_FILE]: Buffer.from(`${JSON.stringify(knownAnswers)}\n`),
    };

    // nothing of this machine goes into a committed file
    const words = machineWords([tree, scratch, ROOT, realpathSync(tree), emcc.where]);
    for (const [name, bytes] of Object.entries(written)) {
      const word = findMachineWord(bytes, words);
      if (word !== undefined) {
        throw new Error(`build:dspsim: ${name} would have "${word}" in it, nothing written`);
      }
    }

    for (const [name, bytes] of Object.entries(written)) {
      writeFileSync(join(MODULE_DIR, name), bytes);
    }
    console.log(
      `build:dspsim: ${MODULE_FILES.map((name) => `${name} ${provenance.files[name].bytes} bytes`).join(", ")}; ` +
        `tree ${provenance.treeCommit.slice(0, 10)}${provenance.dirty ? " (dsp_core has changes)" : ""}, ` +
        `emscripten ${provenance.emscripten}, ${answers.known} known answers. Commit src/wasm/aica-dsp-core/.`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
