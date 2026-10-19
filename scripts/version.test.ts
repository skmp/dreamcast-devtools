import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  deriveGitRev,
  deriveVersion,
  gitEnvironment,
  gitFacts,
  parseDescribe,
  TAG_PATTERN,
  versionInfo,
  type GitCallOptions,
  type GitExec,
  type VersionFacts,
} from "./version";

// Every way of starting a program, recorded (each still runs): the default runner of gitFacts is execFileSync("git").
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec),
    execSync: vi.fn(actual.execSync),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    fork: vi.fn(actual.fork),
  };
});

const BASE = "3.0.0-pre";
const HASH = "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";
const H = HASH.slice(0, 10);

const facts = (overrides: Partial<VersionFacts>): VersionFacts => ({
  base: BASE,
  isCheckout: true,
  describe: null,
  fullHash: HASH,
  dirty: false,
  ...overrides,
});

describe("deriveVersion: the rows of the version table", () => {
  const rows: [string, Partial<VersionFacts>, string][] = [
    ["on the tag, clean", { describe: "v3.0.0-pre-0-g1a2b3c4" }, "3.0.0-pre"],
    ["N commits after it, clean", { describe: "v3.0.0-pre-5-g1a2b3c4" }, `3.0.0-pre+5.g${H}`],
    ["on the tag, dirty", { describe: "v3.0.0-pre-0-g1a2b3c4", dirty: true }, "3.0.0-pre+dirty"],
    ["N after it, dirty", { describe: "v3.0.0-pre-5-g1a2b3c4", dirty: true }, `3.0.0-pre+5.g${H}.dirty`],
    ["a checkout with no tag reachable", { describe: null }, `3.0.0-pre+g${H}`],
    ["no tag reachable, dirty", { describe: null, dirty: true }, `3.0.0-pre+g${H}.dirty`],
    ["an output that does not parse", { describe: "1a2b3c4" }, `3.0.0-pre+g${H}`],
    ["no git", { isCheckout: false, fullHash: "" }, "3.0.0-pre+nogit"],
    ["not a checkout (a copy inside another repository)", { isCheckout: false, fullHash: "" }, "3.0.0-pre+nogit"],
  ];
  it.each(rows)("%s", (_name, overrides, expected) => {
    expect(deriveVersion(facts(overrides))).toBe(expected);
  });

  it("takes <h> as the first 10 hexadecimal digits of the full hash, never describe's abbreviation", () => {
    for (const describe of ["v3.0.0-pre-2-g1a2b3c4", "v3.0.0-pre-2-g1a2b3c4d5e6f70", null]) {
      const version = deriveVersion(facts({ describe }));
      const h = /\.?g([0-9a-f]+)$/.exec(version)?.[1];
      expect(h).toBeDefined();
      expect(h).toMatch(/^[0-9a-f]{10}$/);
      expect(HASH.startsWith(h ?? "-")).toBe(true);
    }
    const sha256 = "ab".repeat(32);
    expect(deriveVersion(facts({ fullHash: sha256, describe: "v3.0.0-pre-3-gabab" }))).toBe(`3.0.0-pre+3.g${"ab".repeat(5)}`);
  });

  it("strips the v of the tag", () => {
    expect(deriveVersion(facts({ describe: "v3.0.0-pre-0-gabcdef0" }))).toBe("3.0.0-pre");
  });

  it("takes the leading part from the tag, whatever the base says: v3.0.1 over the base 3.0.0-pre is 3.0.1", () => {
    expect(deriveVersion(facts({ describe: "v3.0.1-0-g1a2b3c4" }))).toBe("3.0.1");
    expect(deriveVersion(facts({ describe: "v3.0.1-4-g1a2b3c4" }))).toBe(`3.0.1+4.g${H}`);
  });

  it("ignores a tag without the v, and takes any other form of output as no tag", () => {
    const others = [
      "foo-0-g1a2b3c4", // a tag not of the pattern (describe without --match)
      "3.0.0-pre-0-g1a2b3c4", // no v
      "release-v3.0.0-0-g1a2b3c4",
      "v3.0.0-pre", // not --long
      "v3.0.0-pre-dirty",
      "v3.0.0-pre-0-g1a2b3c4-dirty", // describe --dirty
      "v3.0.0-pre-x-g1a2b3c4",
      "v3.0.0-pre-1-1a2b3c4",
      "vx-1-g1a2b3c4",
      "v-1-g1a2b3c4",
      "v3.0.0+meta-1-g1a2b3c4",
      "",
      "1a2b3c4",
    ];
    for (const describe of others) {
      expect(parseDescribe(describe), describe).toBeNull();
      expect(deriveVersion(facts({ describe })), describe).toBe(`3.0.0-pre+g${H}`);
    }
  });

  it("reads describe's output from the right", () => {
    expect(parseDescribe("v3.0.0-pre-12-gabc1234")).toEqual({ version: "3.0.0-pre", count: 12, abbreviation: "abc1234" });
    expect(parseDescribe("v3.0.0-rc-1-2-gabc1234")).toEqual({ version: "3.0.0-rc-1", count: 2, abbreviation: "abc1234" });
    expect(parseDescribe("v3.0.0-pre-2-gdeadbee-0-gabc1234\n")).toEqual({ version: "3.0.0-pre-2-gdeadbee", count: 0, abbreviation: "abc1234" });
  });

  it("is a string of the characters the emulator embeds", () => {
    for (const describe of ["v3.0.0-pre-0-g1a2b3c4", "v3.0.0-pre-7-g1a2b3c4", null]) {
      for (const dirty of [false, true]) {
        expect(deriveVersion(facts({ describe, dirty }))).toMatch(/^[A-Za-z0-9_.+~:/ -]+$/);
      }
    }
  });
});

describe("deriveGitRev", () => {
  it("is the full hash, with -dirty by the same rule, and empty without git", () => {
    expect(deriveGitRev(facts({}))).toBe(HASH);
    expect(deriveGitRev(facts({ dirty: true }))).toBe(`${HASH}-dirty`);
    expect(deriveGitRev(facts({ describe: "v3.0.0-pre-0-g1a2b3c4", dirty: true }))).toBe(`${HASH}-dirty`);
    expect(deriveGitRev(facts({ isCheckout: false, fullHash: "" }))).toBe("");
  });
});

interface Call {
  file: string;
  args: string[];
  options: GitCallOptions;
}

/** A stand-in for execFileSync that records each call and answers from `answers` (by the git subcommand). */
const recorder = (answers: Record<string, string | Error>) => {
  const calls: Call[] = [];
  const exec: GitExec = (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const key = args.slice(2).join(" ");
    const answer = answers[key];
    if (answer === undefined) {
      throw new Error(`unexpected git call: ${key}`);
    }
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { calls, exec };
};

const PREFIX = "rev-parse --show-prefix";
const HEAD = "rev-parse HEAD";
const DESCRIBE = `describe --tags --long --match ${TAG_PATTERN}`;
const STATUS = "status --porcelain --untracked-files=no";

describe("gitFacts: the git calls", () => {
  const root = join("some", "where", "ui");

  it("runs each as an argument vector: git -C <root> ..., the pattern one argument, no shell, GIT_OPTIONAL_LOCKS=0", () => {
    const { calls, exec } = recorder({ [PREFIX]: "\n", [HEAD]: `${HASH}\n`, [DESCRIBE]: "v3.0.0-pre-2-g1a2b3c4\n", [STATUS]: "" });
    expect(gitFacts(root, exec, {})).toEqual({ isCheckout: true, describe: "v3.0.0-pre-2-g1a2b3c4", fullHash: HASH, dirty: false });
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ["git", "-C", root, "rev-parse", "--show-prefix"],
      ["git", "-C", root, "rev-parse", "HEAD"],
      ["git", "-C", root, "describe", "--tags", "--long", "--match", "v[0-9]*"],
      ["git", "-C", root, "status", "--porcelain", "--untracked-files=no"],
    ]);
    for (const call of calls) {
      expect(call.options).not.toHaveProperty("shell");
      expect(call.options.env.GIT_OPTIONAL_LOCKS).toBe("0");
      expect(call.options.encoding).toBe("utf8");
    }
  });

  it("names no other repository than the one at -C: GIT_DIR and its kin are left out", () => {
    const env = gitEnvironment({ PATH: "/bin", GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", GIT_INDEX_FILE: "x", GIT_OPTIONAL_LOCKS: "1" });
    expect(env).toEqual({ PATH: "/bin", GIT_OPTIONAL_LOCKS: "0" });
  });

  it("is no checkout when git is missing (the first call fails), and asks nothing more", () => {
    const missing = Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" });
    const { calls, exec } = recorder({ [PREFIX]: missing });
    expect(gitFacts(root, exec, {})).toEqual({ isCheckout: false, describe: null, fullHash: "", dirty: false });
    expect(calls).toHaveLength(1);
    expect(versionInfo(root, BASE, recorder({ [PREFIX]: missing }).exec, {})).toEqual({ version: "3.0.0-pre+nogit", gitRev: "" });
  });

  it("is no checkout below the top of a work tree (a copy inside another repository)", () => {
    const { calls, exec } = recorder({ [PREFIX]: "agents/copy/\n" });
    expect(versionInfo(root, BASE, exec, {})).toEqual({ version: "3.0.0-pre+nogit", gitRev: "" });
    expect(calls).toHaveLength(1);
  });

  it("is no checkout in a repository without a commit", () => {
    const { exec } = recorder({ [PREFIX]: "\n", [HEAD]: new Error("ambiguous argument 'HEAD'") });
    expect(versionInfo(root, BASE, exec, {})).toEqual({ version: "3.0.0-pre+nogit", gitRev: "" });
  });

  it("takes a failed describe as no tag reachable", () => {
    const { exec } = recorder({ [PREFIX]: "\n", [HEAD]: `${HASH}\n`, [DESCRIBE]: new Error("No names found"), [STATUS]: "" });
    expect(versionInfo(root, BASE, exec, {})).toEqual({ version: `3.0.0-pre+g${H}`, gitRev: HASH });
  });

  it("is dirty when status lists a tracked change, and when status fails", () => {
    const changed = recorder({ [PREFIX]: "\n", [HEAD]: `${HASH}\n`, [DESCRIBE]: "v3.0.0-pre-0-g1a2b3c4\n", [STATUS]: " M src/App.tsx\n" });
    expect(versionInfo(root, BASE, changed.exec, {})).toEqual({ version: "3.0.0-pre+dirty", gitRev: `${HASH}-dirty` });
    const failed = recorder({ [PREFIX]: "\n", [HEAD]: `${HASH}\n`, [DESCRIBE]: "v3.0.0-pre-0-g1a2b3c4\n", [STATUS]: new Error("index file corrupt") });
    expect(versionInfo(root, BASE, failed.exec, {})).toEqual({ version: "3.0.0-pre+dirty", gitRev: `${HASH}-dirty` });
  });
});

// The same, with git itself, in scratch repositories of a few commits (where describe abbreviates to 7 digits). Their
// path holds a space, quotes and a $: a git call joined into a command line for a shell, by any runner, breaks on it.
describe("gitFacts with git", () => {
  const scratch = mkdtempSync(join(tmpdir(), "version test 'q' $x-"));
  const emptyConfig = join(scratch, "empty.gitconfig");
  writeFileSync(emptyConfig, "");
  // The environment of the tests' own git calls: through gitEnvironment, as gitFacts', so that the GIT_DIR,
  // GIT_INDEX_FILE, ... of a hook that runs the tests never send a commit or a tag to the repository of the hook. The
  // user's own configuration does not reach these repositories (signing, hooks, a default branch).
  const scratchEnvironment = (outer: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
    gitEnvironment({ ...outer, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: scratch });
  const env = scratchEnvironment(process.env);
  const identity = ["-c", "user.name=Version Test", "-c", "user.email=version-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
  const gitWith =
    (environment: NodeJS.ProcessEnv) =>
    (dir: string, ...args: string[]): string =>
      childProcess.execFileSync("git", ["-C", dir, ...identity, ...args], { env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = gitWith(env);
  let repositories = 0;
  const repository = (commits: number, run = git): string => {
    const dir = join(scratch, `repo${repositories++}`);
    mkdirSync(dir);
    run(dir, "init", "-q", "-b", "main");
    for (let i = 0; i < commits; i++) {
      writeFileSync(join(dir, "file.txt"), `${i}\n`);
      run(dir, "add", "file.txt");
      run(dir, "commit", "-q", "-m", `commit ${i}`);
    }
    return dir;
  };
  const commit = (dir: string, text: string) => {
    writeFileSync(join(dir, "file.txt"), text);
    git(dir, "commit", "-q", "-a", "-m", text);
  };
  const info = (dir: string) => versionInfo(dir, BASE, undefined, env);
  const h = (dir: string): string => {
    const full = git(dir, "rev-parse", "HEAD");
    expect(full).toMatch(/^[0-9a-f]{40}$/);
    return full.slice(0, 10);
  };

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("a repository without a tag: <base>+g<10 digits of HEAD>", () => {
    const dir = repository(3);
    expect(info(dir)).toEqual({ version: `3.0.0-pre+g${h(dir)}`, gitRev: git(dir, "rev-parse", "HEAD") });
  });

  it("an annotated tag v3.0.0-pre on HEAD, then two commits after it, then a tracked change, then an untracked file", () => {
    const dir = repository(2);
    git(dir, "tag", "-a", "v3.0.0-pre", "-m", "scratch tag");
    expect(info(dir).version).toBe("3.0.0-pre");
    commit(dir, "after 1\n");
    commit(dir, "after 2\n");
    const version = info(dir).version;
    expect(version).toBe(`3.0.0-pre+2.g${h(dir)}`);
    // describe abbreviates to 7 digits here; <h> keeps 10
    expect(git(dir, "describe", "--tags", "--long", "--match", TAG_PATTERN)).toMatch(/^v3\.0\.0-pre-2-g[0-9a-f]{7}$/);
    expect(/\.g([0-9a-f]+)$/.exec(version)?.[1]).toHaveLength(10);

    writeFileSync(join(dir, "untracked.txt"), "not added\n");
    expect(info(dir)).toEqual({ version: `3.0.0-pre+2.g${h(dir)}`, gitRev: git(dir, "rev-parse", "HEAD") });
    writeFileSync(join(dir, "file.txt"), "changed\n");
    expect(info(dir)).toEqual({ version: `3.0.0-pre+2.g${h(dir)}.dirty`, gitRev: `${git(dir, "rev-parse", "HEAD")}-dirty` });
  });

  it("on the tag with a tracked change: <T>+dirty; a staged change counts too", () => {
    const dir = repository(1);
    git(dir, "tag", "-a", "v3.0.0-pre", "-m", "scratch tag");
    writeFileSync(join(dir, "file.txt"), "staged\n");
    git(dir, "add", "file.txt");
    expect(info(dir).version).toBe("3.0.0-pre+dirty");
  });

  it("a tag not of the pattern is never taken: foo on HEAD after v3.0.0-pre", () => {
    const dir = repository(1);
    git(dir, "tag", "-a", "v3.0.0-pre", "-m", "scratch tag");
    commit(dir, "after 1\n");
    commit(dir, "after 2\n");
    git(dir, "tag", "-a", "foo", "-m", "not a version");
    expect(info(dir).version).toBe(`3.0.0-pre+2.g${h(dir)}`);
    const only = repository(2);
    git(only, "tag", "-a", "foo", "-m", "not a version");
    git(only, "tag", "3.0.0", "HEAD~1");
    expect(info(only).version).toBe(`3.0.0-pre+g${h(only)}`);
  });

  it("a lightweight tag v3.0.1 over the base 3.0.0-pre: 3.0.1", () => {
    const dir = repository(2);
    git(dir, "tag", "v3.0.1");
    expect(info(dir).version).toBe("3.0.1");
  });

  it("a directory inside a checkout is no checkout of its own; a directory outside any is none either", () => {
    const dir = repository(1);
    const inner = join(dir, "copy");
    mkdirSync(inner);
    writeFileSync(join(inner, "package.json"), "{}\n");
    expect(info(inner)).toEqual({ version: "3.0.0-pre+nogit", gitRev: "" });
    const outside = join(scratch, "no-repository");
    mkdirSync(outside);
    expect(info(outside)).toEqual({ version: "3.0.0-pre+nogit", gitRev: "" });
  });

  it("runs git by the default runner as execFileSync(\"git\", [...]): four argument vectors, no shell, no other way of starting a program", () => {
    const dir = repository(1);
    const head = git(dir, "rev-parse", "HEAD");
    vi.clearAllMocks();
    expect(info(dir)).toEqual({ version: `3.0.0-pre+g${head.slice(0, 10)}`, gitRev: head });
    const calls = vi.mocked(childProcess.execFileSync).mock.calls as unknown as [string, string[], GitCallOptions][];
    expect(calls.map(([file, args]) => [file, ...args])).toEqual([
      ["git", "-C", dir, "rev-parse", "--show-prefix"],
      ["git", "-C", dir, "rev-parse", "HEAD"],
      ["git", "-C", dir, "describe", "--tags", "--long", "--match", "v[0-9]*"],
      ["git", "-C", dir, "status", "--porcelain", "--untracked-files=no"],
    ]);
    for (const [, , options] of calls) {
      expect(options).not.toHaveProperty("shell");
      expect(options.env.GIT_OPTIONAL_LOCKS).toBe("0");
    }
    for (const other of [childProcess.spawn, childProcess.spawnSync, childProcess.exec, childProcess.execSync, childProcess.execFile, childProcess.fork]) {
      expect(vi.mocked(other)).not.toHaveBeenCalled();
    }
  });

  it("keeps the tests' own git calls in their scratch repositories when GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE name another (a hook)", () => {
    const outer = repository(1);
    const outerHead = git(outer, "rev-parse", "HEAD");
    const hooked = gitWith(
      scratchEnvironment({ ...process.env, GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: outer, GIT_INDEX_FILE: join(outer, ".git", "index"), GIT_PREFIX: "" }),
    );
    const dir = repository(2, hooked);
    hooked(dir, "tag", "-a", "v3.0.0-pre", "-m", "scratch tag");
    expect(git(outer, "rev-parse", "HEAD")).toBe(outerHead);
    expect(git(outer, "tag", "--list")).toBe("");
    expect(git(outer, "status", "--porcelain")).toBe("");
    expect(info(dir).version).toBe("3.0.0-pre");
  });
});
