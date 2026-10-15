import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleInfoPlugin } from "./bundle-info";

// The UI is called "Dreamcast DevTools": the document title, the home page, the About dialog,
// the status bar, the documentation, the README, and the `client` of debugger.describe (from
// the UI and from the contract runner). The emulator it talks to is nullDC, and where the UI
// names the emulator it says so ("... for nullDC 3.0.0", "nullDC (mock)"), or gives the name
// the emulator reports ("<emulator name> @ <host>" in the connection picker).
// Identifiers that no one reads keep their nulldc spelling, since a rename would lose saved
// state: the localStorage keys nulldc-debugger-* and nulldc-theme-mode, the nulldc:crash-test
// event, environment and CMake variable names (NULLDC_*), fly.toml's app name, and the logo file
// public/nulldc_logo.png. None of them is an old name of the UI in the sense below, so none
// needs an exception. The BroadcastChannels of a wasm build are not kept: they are
// dreamcast-devtools-announce and dreamcast-devtools-<id>, and no file names the old ones
// (OLD_CHANNEL below) but where a test shows that nothing is heard or said on them.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The old names of the UI: "null DC" followed by "DevTools", "Debugger" or "contract runner",
 * in any case, with any blank between the words (a line break of wrapped prose too). A hyphen
 * or an underscore is no blank: nulldc-debugger-* and NULLDC_DEVTOOLS_DIR are identifiers.
 */
const OLD_UI_NAME = /\bnull\s*dc\s+(?:dev\s*tools|debugger|contract\s+runner)\b/gi;

/**
 * The names of the BroadcastChannels before the UI was called Dreamcast DevTools: the
 * announcements, and the channel of one emulator (`nulldc-debugger-${id}`, nulldc-debugger-<id>).
 * The localStorage keys share the prefix and are not matched: a word follows it.
 */
const OLD_CHANNEL = /nulldc-debugger-(?:announce\b|\$\{|<id>)/g;

/** Files that may name the old channels, each with why. */
const OLD_CHANNEL_EXCEPTIONS: Record<string, string> = {
  "scripts/uiName.test.ts": "this check: the samples its pattern is tested with",
  "src/services/transport.test.ts": "the tests that nothing is heard or said on the old channels",
};

/** Files that may say an old name, each with why. */
const EXCEPTIONS: Record<string, string> = {
  "scripts/uiName.test.ts": "this check: the samples its pattern is tested with",
};

/** Directories that are output or dependencies, never sources (for a tree that is not a git checkout). */
const NOT_SOURCES = new Set([".git", "node_modules", "dist-native", "dist-wasm", "dist-ssr", "test-results", "playwright-report", "target"]);

/** The files of the repository: what git tracks, and new files that it does not ignore. */
const repositoryFiles = (): string[] => {
  try {
    const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8");
    return listed.split("\0").filter((path) => path !== "");
  } catch {
    // not a git checkout (a tarball): every file that is not output or a dependency
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!NOT_SOURCES.has(entry.name)) {
            walk(path);
          }
        } else if (entry.isFile()) {
          files.push(relative(ROOT, path).split(sep).join("/"));
        }
      }
    };
    walk(ROOT);
    return files;
  }
};

/** Every place in `text` that matches `pattern`, as "<line>: <the words>". */
const places = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map((match) => `${text.slice(0, match.index).split("\n").length}: ${match[0].replace(/\s+/g, " ")}`);

/** Every place in `text` that calls the UI by an old name, as "<line>: <the words>". */
const oldUiNames = (text: string): string[] => places(text, OLD_UI_NAME);

/** The text of every file of the repository that is not binary, but the exceptions. */
const repositoryTexts = (exceptions: Record<string, string>): Array<{ path: string; text: string }> => {
  const texts: Array<{ path: string; text: string }> = [];
  for (const path of repositoryFiles()) {
    if (path in exceptions) {
      continue;
    }
    let bytes: Buffer;
    try {
      if (!statSync(join(ROOT, path)).isFile()) {
        continue;
      }
      bytes = readFileSync(join(ROOT, path));
    } catch {
      // listed by git and deleted in the working tree
      continue;
    }
    // images and the wasm module
    if (!bytes.includes(0)) {
      texts.push({ path, text: bytes.toString("utf8") });
    }
  }
  return texts;
};

describe("the name of the UI", () => {
  it("the pattern finds the old names in any spelling and leaves the identifiers and the emulator's name alone", () => {
    for (const old of [
      "nullDC DevTools",
      "nullDC Devtools",
      "nullDC Debugger 3.0.0-pre",
      "About NULLDC DEVTOOLS",
      "Welcome to the nullDC\n  DevTools",
      "null DC Dev Tools",
      "nullDC contract runner",
    ]) {
      expect(oldUiNames(old), old).toHaveLength(1);
    }
    for (const kept of [
      "Dreamcast DevTools 3.0.0-pre",
      "the web debugger UI for nullDC 3.0.0, the Dreamcast emulator",
      "nullDC @ 127.0.0.1:55543",
      "nullDC (mock)",
      "nulldc-debugger-dsp-source",
      "nulldc-debugger-endpoint",
      "nulldc-theme-mode",
      "nulldc:crash-test",
      "-DNULLDC_DEVTOOLS_DIST=<this checkout>/dist-native",
      "nulldc_logo.png",
    ]) {
      expect(oldUiNames(kept), kept).toEqual([]);
    }
  });

  it("no file of the repository calls the UI by an old name", () => {
    const files = repositoryFiles();
    // the check looks at the files that matter, not at an empty list
    for (const known of ["index.html", "README.md", "src/app/layout/AppLayout.tsx", "src/services/debuggerClient.ts", "scripts/contract/run.ts"]) {
      expect(files).toContain(known);
    }
    const found = repositoryTexts(EXCEPTIONS).flatMap(({ path, text }) => oldUiNames(text).map((place) => `${path}:${place}`));
    expect(found, "the UI is called Dreamcast DevTools").toEqual([]);
  });

  it("the channel pattern finds the old BroadcastChannel names and leaves the localStorage keys alone", () => {
    for (const old of ['new BroadcastChannel("nulldc-debugger-announce")', "`nulldc-debugger-${endpoint}`", "talks on `nulldc-debugger-<id>`"]) {
      expect(places(old, OLD_CHANNEL), old).toHaveLength(1);
    }
    for (const kept of ["dreamcast-devtools-announce", "`dreamcast-devtools-${id}`", "nulldc-debugger-endpoint", "`nulldc-debugger-layout-${workspaceId}`"]) {
      expect(places(kept, OLD_CHANNEL), kept).toEqual([]);
    }
  });

  it("no file of the repository names the BroadcastChannels by their old names", () => {
    const texts = repositoryTexts(OLD_CHANNEL_EXCEPTIONS);
    expect(texts.map(({ path }) => path)).toContain("src/services/transport.ts");
    const found = texts.flatMap(({ path, text }) => places(text, OLD_CHANNEL).map((place) => `${path}:${place}`));
    expect(found, "the channels are dreamcast-devtools-announce and dreamcast-devtools-<id>").toEqual([]);
  });

  it("every exception is a file of the repository", () => {
    const files = repositoryFiles();
    for (const path of [...Object.keys(EXCEPTIONS), ...Object.keys(OLD_CHANNEL_EXCEPTIONS)]) {
      expect(files).toContain(path);
    }
  });

  it("the package is dreamcast-devtools, in package.json, in the lock file and in the plugin that writes bundle-info.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string };
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { name: string; packages: Record<string, { name?: string }> };
    expect(pkg.name).toBe("dreamcast-devtools");
    expect(lock.name).toBe("dreamcast-devtools");
    expect(lock.packages[""].name).toBe("dreamcast-devtools");
    expect(bundleInfoPlugin({ version: "0", protocol: 3, gitRev: "" }).name).toBe("dreamcast-devtools-bundle-info");
  });
});
