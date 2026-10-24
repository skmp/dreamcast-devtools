// npm run print-version
//
// The version of the UI, made from git at every build (vite.config.ts) and printed by `npm run print-version`:
//
//   on the tag v<T>, clean                 <T>                     3.0.0-pre
//   N commits after it, clean              <T>+N.g<h>              3.0.0-pre+2.g1a2b3c4d5e
//   on the tag, dirty                      <T>+dirty               3.0.0-pre+dirty
//   N after it, dirty                      <T>+N.g<h>.dirty        3.0.0-pre+2.g1a2b3c4d5e.dirty
//   a checkout with no tag reachable       <base>+g<h>[.dirty]     3.0.0-pre+g1a2b3c4d5e
//   no git, or not a checkout              <base>+nogit            3.0.0-pre+nogit
//
// <base> is the `version` of package.json. <h> is the first 10 characters of `git rev-parse HEAD`, always 10 (never
// describe's abbreviation, which is only a minimum: a full and a shallow clone could disagree). The tag is found only
// by `git describe --tags --long --match v[0-9]*`, whose output is read from the right as v<T>-<N>-g<hash>; an output
// that does not read so is no tag. Dirty is a change of a tracked file (`git status --porcelain
// --untracked-files=no`); untracked and ignored files never count. A checkout is a directory at the top of a work
// tree (`git rev-parse --show-prefix` prints an empty line): a clone, a worktree, a submodule; a copy of the tree
// inside another repository is none, and has no version of its own from git.
//
// git is run with an argument list, never through a shell (a shell such as cmd.exe would keep the quotes of a quoted
// pattern), with GIT_OPTIONAL_LOCKS=0, so that a build never holds index.lock against a commit made at the same time.
// The emulator, nullDC, makes its own version by the same rule.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What git says of a directory. */
export interface GitFacts {
  /** the directory is the top of a work tree, and git could name its commit */
  isCheckout: boolean;
  /** the output of `git describe --tags --long --match v[0-9]*`, null when it failed (no tag reachable) */
  describe: string | null;
  /** `git rev-parse HEAD`, "" when it is no checkout */
  fullHash: string;
  /** a tracked file differs from HEAD */
  dirty: boolean;
}

export interface VersionFacts extends GitFacts {
  /** the `version` of package.json */
  base: string;
}

export interface VersionInfo {
  /** the version: __APP_VERSION__, the `version` of bundle-info.json */
  version: string;
  /** the commit, with "-dirty" by the same rule as the version; "" without git: the `gitRev` of bundle-info.json */
  gitRev: string;
}

/** A tag that describe found, read from the right of its output. */
export interface DescribedTag {
  /** the tag without its "v" */
  version: string;
  /** commits since the tag */
  count: number;
  /** describe's abbreviation of HEAD (not used for the version) */
  abbreviation: string;
}

/** The pattern of the version tags: one argument of describe, never quoted. */
export const TAG_PATTERN = "v[0-9]*";

/** The length of <h>. */
export const HASH_DIGITS = 10;

const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * v<T>-<N>-g<hash>, read from the right: <T> may itself hold hyphens (3.0.0-pre). <T> starts with a digit (the
 * pattern of describe) and has the characters of a SemVer version without build metadata.
 */
const DESCRIBED = /^v([0-9][0-9A-Za-z.-]*)-([0-9]+)-g([0-9a-f]{4,64})$/;

export const parseDescribe = (describe: string): DescribedTag | null => {
  const match = DESCRIBED.exec(describe.trim());
  if (!match) {
    return null;
  }
  return { version: match[1], count: Number(match[2]), abbreviation: match[3] };
};

export const deriveVersion = (facts: VersionFacts): string => {
  if (!facts.isCheckout || !FULL_HASH.test(facts.fullHash)) {
    return `${facts.base}+nogit`;
  }
  const h = facts.fullHash.slice(0, HASH_DIGITS);
  const tag = facts.describe === null ? null : parseDescribe(facts.describe);
  if (tag === null) {
    return `${facts.base}+g${h}${facts.dirty ? ".dirty" : ""}`;
  }
  if (tag.count === 0) {
    return facts.dirty ? `${tag.version}+dirty` : tag.version;
  }
  return `${tag.version}+${tag.count}.g${h}${facts.dirty ? ".dirty" : ""}`;
};

export const deriveGitRev = (facts: GitFacts): string => {
  if (!facts.isCheckout || !FULL_HASH.test(facts.fullHash)) {
    return "";
  }
  return facts.dirty ? `${facts.fullHash}-dirty` : facts.fullHash;
};

/** The options of every git call: no shell, stdout as text, stderr kept out of the build's output. */
export interface GitCallOptions {
  env: NodeJS.ProcessEnv;
  encoding: "utf8";
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: true;
}

/** How git is run: execFileSync, or a recording stand-in in the tests. Throws when git fails or is missing. */
export type GitExec = (file: "git", args: string[], options: GitCallOptions) => string;

const runGit: GitExec = (file, args, options) => execFileSync(file, args, options);

/**
 * The environment of the git calls: the caller's, with GIT_OPTIONAL_LOCKS=0, and without the variables that would
 * point git at another repository than the one at `-C <root>` (set, for one, inside a git hook).
 */
export const gitEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
    delete result[name];
  }
  return result;
};

const NO_CHECKOUT: GitFacts = { isCheckout: false, describe: null, fullHash: "", dirty: false };

/** What git says of `root`; every failure is one of the cases of the version (no git, no checkout, no tag). */
export const gitFacts = (root: string, exec: GitExec = runGit, env: NodeJS.ProcessEnv = process.env): GitFacts => {
  const options: GitCallOptions = { env: gitEnvironment(env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
  const git = (...args: string[]): string => exec("git", ["-C", root, ...args], options);

  // no git, no repository, or a directory below the top of one
  let prefix: string;
  try {
    prefix = git("rev-parse", "--show-prefix");
  } catch {
    return NO_CHECKOUT;
  }
  if (prefix.replace(/\r?\n$/, "") !== "") {
    return NO_CHECKOUT;
  }
  // a repository without a commit names none
  let fullHash: string;
  try {
    fullHash = git("rev-parse", "HEAD").trim();
  } catch {
    return NO_CHECKOUT;
  }
  if (!FULL_HASH.test(fullHash)) {
    return NO_CHECKOUT;
  }
  let describe: string | null;
  try {
    describe = git("describe", "--tags", "--long", "--match", TAG_PATTERN).trim();
  } catch {
    describe = null;
  }
  // a tree whose state git cannot say is not called clean
  let dirty: boolean;
  try {
    dirty = git("status", "--porcelain", "--untracked-files=no").trim() !== "";
  } catch {
    dirty = true;
  }
  return { isCheckout: true, describe, fullHash, dirty };
};

/** The version and the commit of the UI in `root`, `base` being its package.json version. */
export const versionInfo = (root: string, base: string, exec: GitExec = runGit, env: NodeJS.ProcessEnv = process.env): VersionInfo => {
  const facts = gitFacts(root, exec, env);
  return { version: deriveVersion({ ...facts, base }), gitRev: deriveGitRev(facts) };
};

/** The `version` of `<root>/package.json`. */
export const readBase = (root: string): string => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error(`${join(root, "package.json")} has no version`);
  }
  return pkg.version;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(versionInfo(ROOT, readBase(ROOT)).version);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
