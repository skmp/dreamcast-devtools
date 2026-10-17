import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkEmccVersion,
  findEmccVersion,
  findMachineWord,
  MODULE_DIR,
  parseArguments,
  PROVENANCE_FILE,
  PROVENANCE_KEYS,
  requiredEmccVersion,
} from "./build-dspsim";

// build:dspsim takes the emcc that the emulator's build.sh uses, found the way build.sh finds it (the PATH, else
// $EMSDK, else ~/emsdk, under upstream/emscripten), and refuses one whose `emcc -dumpversion` is not the version
// PROVENANCE.json names, unless --emcc-version names it. Here the emccs are scripts that print a version.

const directories: string[] = [];

const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "build-dspsim-test-"));
  directories.push(directory);
  return directory;
};

/** An emcc in `directory` that reports `version`. */
const fakeEmcc = (directory: string, version: string): string => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "emcc");
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
  return path;
};

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("build:dspsim: the emcc build.sh uses", () => {
  it("is the PATH's, ahead of the emsdk in $EMSDK", () => {
    const root = scratch();
    fakeEmcc(join(root, "bin"), "9.9.9");
    fakeEmcc(join(root, "emsdk", "upstream", "emscripten"), "6.0.8");
    const found = findEmccVersion({ PATH: join(root, "bin"), EMSDK: join(root, "emsdk"), HOME: join(root, "home") });
    expect(found.version).toBe("9.9.9");
    expect(found.where).toBe(join(root, "bin", "emcc"));
  });

  it("is the one of the emsdk in $EMSDK when the PATH has none", () => {
    const root = scratch();
    fakeEmcc(join(root, "emsdk", "upstream", "emscripten"), "7.1.0");
    fakeEmcc(join(root, "home", "emsdk", "upstream", "emscripten"), "6.0.8");
    const found = findEmccVersion({ PATH: join(root, "empty"), EMSDK: join(root, "emsdk"), HOME: join(root, "home") });
    expect(found.version).toBe("7.1.0");
  });

  it("is the one of ~/emsdk when the PATH has none and $EMSDK is not set", () => {
    const root = scratch();
    fakeEmcc(join(root, "home", "emsdk", "upstream", "emscripten"), "6.0.8");
    expect(findEmccVersion({ PATH: join(root, "empty"), HOME: join(root, "home") }).version).toBe("6.0.8");
  });

  it("is none: the lookup says so, as build.sh does", () => {
    const root = scratch();
    expect(() => findEmccVersion({ PATH: join(root, "empty"), EMSDK: join(root, "emsdk"), HOME: join(root, "home") })).toThrow(
      `no emcc on the PATH and no emsdk in ${join(root, "emsdk")}`,
    );
  });
});

describe("build:dspsim: the pinned emscripten", () => {
  it("is the version PROVENANCE.json names, or the one --emcc-version names", () => {
    const provenance = JSON.parse(readFileSync(join(MODULE_DIR, PROVENANCE_FILE), "utf8")) as Record<string, unknown>;
    expect(Object.keys(provenance)).toEqual([...PROVENANCE_KEYS]);
    expect(requiredEmccVersion(undefined, provenance)).toBe(provenance.emscripten);
    expect(requiredEmccVersion(undefined, { emscripten: "6.0.8" })).toBe("6.0.8");
    expect(requiredEmccVersion("7.0.0", { emscripten: "6.0.8" })).toBe("7.0.0");
    expect(() => requiredEmccVersion(undefined, null)).toThrow("--emcc-version <version>");
  });

  it("refuses an emcc of another version, compared as strings", () => {
    expect(() => checkEmccVersion("6.0.8", "6.0.8", false)).not.toThrow();
    expect(() => checkEmccVersion("6.0.9", "6.0.8", false)).toThrow("emcc reports 6.0.9, PROVENANCE.json names 6.0.8");
    expect(() => checkEmccVersion("6.0.8-git", "6.0.8", false)).toThrow("--emcc-version 6.0.8-git");
    expect(() => checkEmccVersion("6.0.8", "6.0.10", true)).toThrow("emcc reports 6.0.8, --emcc-version asks for 6.0.10");
  });

  it("refuses an emcc that only $EMSDK names when its version is another", () => {
    const root = scratch();
    fakeEmcc(join(root, "emsdk", "upstream", "emscripten"), "5.0.0");
    const found = findEmccVersion({ PATH: join(root, "empty"), EMSDK: join(root, "emsdk"), HOME: join(root, "home") });
    expect(() => checkEmccVersion(found.version, "6.0.8", false)).toThrow("emcc reports 5.0.0");
  });
});

describe("build:dspsim: its arguments and what it writes", () => {
  it("takes the tree from --emulator or NULLDC_DIR", () => {
    expect(parseArguments(["--emulator", "/x/tree"], {})).toEqual({ tree: "/x/tree", emccVersion: undefined });
    expect(parseArguments([], { NULLDC_DIR: "/y/tree" })).toEqual({ tree: "/y/tree", emccVersion: undefined });
    expect(parseArguments(["--emulator", "/x/tree", "--emcc-version", "6.0.8"], { NULLDC_DIR: "/y" })).toEqual({
      tree: "/x/tree",
      emccVersion: "6.0.8",
    });
    expect(() => parseArguments([], {})).toThrow("no emulator tree");
    expect(() => parseArguments(["--emulator"], {})).toThrow("--emulator needs a value");
    expect(() => parseArguments(["--tree", "/x"], {})).toThrow("unknown argument --tree");
  });

  it("finds a word of the machine in a file's bytes", () => {
    expect(findMachineWord(Buffer.from("abc/home/someone/x"), ["/home/"])).toBe("/home/");
    expect(findMachineWord(new Uint8Array([0, 1, 2, 0x2f, 0x74, 0x6d, 0x70, 0x2f, 9]), ["/tmp/"])).toBe("/tmp/");
    expect(findMachineWord(Buffer.from("no path"), ["/home/", "/Users/"])).toBeUndefined();
  });
});
