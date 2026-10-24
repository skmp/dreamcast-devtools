import { createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBundleInfo } from "./bundle-info";
import {
  check,
  createCommand,
  folderName,
  makeZip,
  NOTES_FILE,
  pack,
  parseSums,
  publish,
  readRelease,
  readZip,
  renderNotes,
  SUMS_FILE,
  tagVersion,
  zipName,
  type Gh,
} from "./release-files";
import { ROOT } from "./version";

// Every way of starting a program, recorded: pack and check run none (gh least of all), whatever the event.
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

const programsRun = (): string[] =>
  [childProcess.spawn, childProcess.spawnSync, childProcess.exec, childProcess.execSync, childProcess.execFile, childProcess.execFileSync, childProcess.fork].flatMap((fn) =>
    vi.mocked(fn).mock.calls.map((call) => String(call[0])),
  );

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const scratch = mkdtempSync(join(tmpdir(), "release-files-test-"));
let directories = 0;
const directory = (name: string): string => {
  const path = join(scratch, `${directories++}-${name}`);
  mkdirSync(path, { recursive: true });
  return path;
};

afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

/** A checkout's package.json (the base) and LICENSE. */
const checkout = (base: string): string => {
  const root = directory("root");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "dreamcast-devtools", version: base })}\n`);
  copyFileSync(join(ROOT, "LICENSE"), join(root, "LICENSE"));
  return root;
};

/** A build directory with its bundle-info.json, as vite's build leaves it. */
const build = (version: string, kind: string): string => {
  const dir = directory(kind);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>Dreamcast DevTools</title><!-- ${kind} -->`);
  writeFileSync(join(dir, "assets", "index-abc.js"), `console.log(${JSON.stringify(kind)});\n`.repeat(50));
  writeFileSync(join(dir, "assets", "random.bin"), Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 7919) & 0xff)));
  writeFileSync(join(dir, ".hidden"), "not served, not listed");
  writeBundleInfo(dir, { version, protocol: 3, gitRev: "0123456789abcdef0123456789abcdef01234567" });
  return dir;
};

const packed = (version: string, root: string): string => {
  const out = join(directory("out"), "release");
  pack({ version, native: build(version, "dist-native"), wasm: build(version, "dist-wasm"), out, root });
  return out;
};

describe("zip", () => {
  const entries = [
    { name: "b/two.txt", data: Buffer.from("two two two two two two two two\n") },
    { name: "a.txt", data: Buffer.from("") },
    { name: "b/a/one.bin", data: Buffer.from([0, 255, 1, 254, 2]) },
  ];

  it("holds its entries sorted by name, each as it was", () => {
    const zip = makeZip(entries);
    expect(readZip(zip)).toEqual([...entries].sort((a, b) => (a.name < b.name ? -1 : 1)));
  });

  it("is the same bytes for the same entries, in any order", () => {
    expect(makeZip(entries).equals(makeZip([...entries].reverse()))).toBe(true);
  });

  it("deflates what deflating makes smaller and stores the rest", () => {
    const zip = makeZip(entries);
    // the method of each entry in the central directory, in name order: a.txt and one.bin stored, two.txt deflated
    const methods: number[] = [];
    let at = zip.readUInt32LE(zip.length - 22 + 16);
    for (let i = 0; i < 3; i++) {
      methods.push(zip.readUInt16LE(at + 10));
      expect(zip.readUInt16LE(at + 4) >> 8).toBe(3); // made on Unix
      expect(zip.readUInt32LE(at + 38) >>> 16).toBe(0o100644);
      at += 46 + zip.readUInt16LE(at + 28);
    }
    expect(methods).toEqual([0, 0, 8]);
  });

  it("refuses a name that is not a relative path", () => {
    for (const name of ["/etc/passwd", "../up.txt", "a/../../b", "C:/Windows/x", "a\\b", "a//b", "./a", ""]) {
      expect(() => makeZip([{ name, data: Buffer.from("x") }]), name).toThrow(/no relative path/);
    }
    expect(() => makeZip([{ name: "a", data: Buffer.from("x") }, { name: "a", data: Buffer.from("y") }])).toThrow(/twice/);
  });

  it("is checked when read: a changed byte is found", () => {
    const zip = makeZip([{ name: "a.txt", data: Buffer.from("abcdefgh") }]);
    zip[30 + "a.txt".length] ^= 1;
    expect(() => readZip(zip)).toThrow(/CRC-32/);
  });
});

describe("pack", () => {
  const version = "3.0.0-pre+g0123456789";

  it("writes the two zips, SHA256SUMS and the notes, named with the version, and runs no program", () => {
    vi.stubEnv("GITHUB_EVENT_NAME", "push");
    vi.stubEnv("GITHUB_REF_TYPE", "tag");
    vi.stubEnv("GITHUB_REF_NAME", "v3.0.0-pre");
    const root = checkout("3.0.0-pre");
    const out = packed(version, root);
    expect(programsRun()).toEqual([]);
    const native = zipName(version, "dist-native");
    const wasm = zipName(version, "dist-wasm");
    expect(native).toBe("dreamcast-devtools-3.0.0-pre+g0123456789-dist-native.zip");
    expect(readdirSync(out).sort()).toEqual([native, wasm, SUMS_FILE, NOTES_FILE].sort());

    const sums = readFileSync(join(out, SUMS_FILE), "utf8");
    expect(sums).toBe([native, wasm].sort().map((name) => `${sha256(readFileSync(join(out, name)))}  ${name}\n`).join(""));
    expect([...parseSums(sums).keys()]).toEqual([native, wasm].sort());

    for (const kind of ["dist-native", "dist-wasm"] as const) {
      const folder = folderName(version, kind);
      const entries = readZip(readFileSync(join(out, zipName(version, kind))));
      expect(entries.map((entry) => entry.name)).toEqual([
        `${folder}/LICENSE`,
        `${folder}/${kind}/assets/index-abc.js`,
        `${folder}/${kind}/assets/random.bin`,
        `${folder}/${kind}/bundle-info.json`,
        `${folder}/${kind}/index.html`,
      ]);
      expect(entries[0].data.equals(readFileSync(join(ROOT, "LICENSE")))).toBe(true);
      expect(JSON.parse(entries[3].data.toString("utf8")).version).toBe(version);
      expect(entries[4].data.toString("utf8")).toContain(`<!-- ${kind} -->`);
    }
    const notes = readFileSync(join(out, NOTES_FILE), "utf8");
    expect(notes).toBe(renderNotes(version));
    expect(notes).toContain(`Dreamcast DevTools ${version}`);
    expect(notes).toContain(`${native}`);
    expect(notes).toContain("-DNULLDC_DEVTOOLS_DIST=");
    expect(notes).not.toMatch(/\{\{/);
  });

  it("makes the same zips from the same builds", () => {
    const root = checkout("3.0.0-pre");
    const native = build(version, "dist-native");
    const wasm = build(version, "dist-wasm");
    const first = join(directory("out"), "a");
    const second = join(directory("out"), "b");
    pack({ version, native, wasm, out: first, root });
    pack({ version, native, wasm, out: second, root });
    for (const name of readdirSync(first)) {
      expect(readFileSync(join(first, name)).equals(readFileSync(join(second, name))), name).toBe(true);
    }
  });

  it("refuses a build of another version, a build whose files are not its manifest's, and a directory with files in it", () => {
    const root = checkout("3.0.0-pre");
    const out = join(directory("out"), "release");
    expect(() => pack({ version: "3.0.0-pre+g9999999999", native: build(version, "dist-native"), wasm: build(version, "dist-wasm"), out, root })).toThrow(/says version 3\.0\.0-pre\+g0123456789, not 3\.0\.0-pre\+g9999999999/);

    const changed = build(version, "dist-native");
    writeFileSync(join(changed, "index.html"), "changed after the build");
    expect(() => pack({ version, native: changed, wasm: build(version, "dist-wasm"), out, root })).toThrow(/does not hold the files its bundle-info\.json lists.*index\.html/);

    const extra = build(version, "dist-wasm");
    writeFileSync(join(extra, "stray.txt"), "not of the build");
    expect(() => pack({ version, native: build(version, "dist-native"), wasm: extra, out, root })).toThrow(/stray\.txt/);
    expect(existsSync(out)).toBe(false);

    const full = directory("full");
    writeFileSync(join(full, "old.zip"), "");
    expect(() => pack({ version, native: build(version, "dist-native"), wasm: build(version, "dist-wasm"), out: full, root })).toThrow(/not empty/);
    expect(() => pack({ version: "v3.0.0-pre", native: build(version, "dist-native"), wasm: build(version, "dist-wasm"), out, root })).toThrow(/is not a version/);
  });
});

describe("check", () => {
  const root = checkout("3.0.0-pre");
  const version = "3.0.0-pre+2.g0123456789";
  const out = packed(version, root);

  it("on a pull request: the files named with the checkout's version, and what publish would run; no program run", () => {
    const lines = check({ directory: out, tag: "", env: { GITHUB_EVENT_NAME: "pull_request" }, root, version });
    expect(programsRun()).toEqual([]);
    expect(lines[0]).toContain(`${zipName(version, "dist-native")}, ${zipName(version, "dist-wasm")}, SHA256SUMS: named with ${version}`);
    expect(lines).toContain("no tag (pull_request): the version is not compared with a tag");
    expect(lines).toContain(
      '  gh release create v3.0.0-pre --verify-tag --draft --prerelease --title "Dreamcast DevTools 3.0.0-pre" --notes-file release-notes.md dreamcast-devtools-3.0.0-pre-dist-native.zip dreamcast-devtools-3.0.0-pre-dist-wasm.zip SHA256SUMS',
    );
    expect(lines).toContain("  gh release edit v3.0.0-pre --draft=false");
    expect(lines).toContain("  | Dreamcast DevTools 3.0.0-pre is the web debugger UI of nullDC, the Dreamcast emulator, built from the tag v3.0.0-pre of this repository.");
  });

  it("on a dispatch with the tag v3.0.0-pre: the base is the tag's version", () => {
    const lines = check({ directory: out, tag: "v3.0.0-pre", env: { GITHUB_EVENT_NAME: "workflow_dispatch" }, root, version });
    expect(lines).toContain("the tag v3.0.0-pre is the base 3.0.0-pre of package.json");
    expect(programsRun()).toEqual([]);
  });

  it("refuses a dispatch with the tag v3.0.1 over the base 3.0.0-pre, a dispatch without a tag, a pull request with one", () => {
    expect(() => check({ directory: out, tag: "v3.0.1", env: { GITHUB_EVENT_NAME: "workflow_dispatch" }, root, version })).toThrow(/the tag v3\.0\.1 is not the base 3\.0\.0-pre/);
    expect(() => check({ directory: out, tag: "", env: { GITHUB_EVENT_NAME: "workflow_dispatch" }, root, version })).toThrow(/a dispatch names the tag/);
    expect(() => check({ directory: out, env: { GITHUB_EVENT_NAME: "workflow_dispatch" }, root, version })).toThrow(/a dispatch names the tag/);
    expect(() => check({ directory: out, tag: "v3.0.0-pre", env: { GITHUB_EVENT_NAME: "pull_request" }, root, version })).toThrow(/a pull request has no tag/);
    expect(() => check({ directory: out, tag: "3.0.0-pre", env: { GITHUB_EVENT_NAME: "workflow_dispatch" }, root, version })).toThrow(/not a version tag/);
    expect(programsRun()).toEqual([]);
  });

  it("refuses files named with another version than the checkout's", () => {
    expect(() => check({ directory: out, env: { GITHUB_EVENT_NAME: "pull_request" }, root, version: "3.0.0-pre+3.g0123456789" })).toThrow(/named with 3\.0\.0-pre\+2\.g0123456789, and this checkout is 3\.0\.0-pre\+3\.g0123456789/);
  });

  it("refuses a SHA256SUMS that does not hold, a stray file, a zip without the UI's LICENSE", () => {
    const sums = packed(version, root);
    writeFileSync(join(sums, SUMS_FILE), readFileSync(join(sums, SUMS_FILE), "utf8").replace(/^[0-9a-f]/, (digit) => (digit === "0" ? "1" : "0")));
    expect(() => readRelease(sums, readFileSync(join(root, "LICENSE")))).toThrow(/is not the one of SHA256SUMS/);

    const stray = packed(version, root);
    writeFileSync(join(stray, "extra.txt"), "");
    expect(() => readRelease(stray, readFileSync(join(root, "LICENSE")))).toThrow(/pack's files are/);

    const otherLicense = packed(version, root);
    expect(() => readRelease(otherLicense, Buffer.from("another licence"))).toThrow(/is not the UI's LICENSE/);
  });
});

interface FakeAsset {
  name: string;
  size: number;
  digest: string | null;
  state: string;
}

/** gh with one Release (or none) of its own, recording each call. */
const fakeGh = (
  start: { isDraft: boolean; assets?: FakeAsset[] } | null,
  misbehave: { dropOnCreate?: boolean; alterOnCreate?: (asset: FakeAsset) => FakeAsset; viewError?: string } = {},
) => {
  const calls: string[][] = [];
  let release: { isDraft: boolean; isPrerelease: boolean; assets: FakeAsset[] } | null = start ? { isDraft: start.isDraft, isPrerelease: true, assets: start.assets ?? [] } : null;
  const asset = (path: string): FakeAsset => {
    const data = readFileSync(path);
    return { name: basename(path), size: data.length, digest: `sha256:${sha256(data)}`, state: "uploaded" };
  };
  const files = (args: string[]): string[] => {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--title" || args[i] === "--notes-file") {
        i++;
      } else if (!args[i].startsWith("--")) {
        result.push(args[i]);
      }
    }
    return result;
  };
  const ok = { status: 0, stdout: "", stderr: "" };
  const gh: Gh = (args) => {
    calls.push(args);
    const [, command, tag, ...rest] = args;
    if (command === "view") {
      if (misbehave.viewError) {
        return { status: 1, stdout: "", stderr: misbehave.viewError };
      }
      return release ? { status: 0, stdout: JSON.stringify({ tagName: tag, ...release }), stderr: "" } : { status: 1, stdout: "", stderr: "release not found\n" };
    }
    if (command === "create") {
      const assets = files(rest)
        .map(asset)
        .map(misbehave.alterOnCreate ?? ((same) => same));
      release = { isDraft: rest.includes("--draft"), isPrerelease: rest.includes("--prerelease"), assets: misbehave.dropOnCreate ? assets.slice(1) : assets };
      return ok;
    }
    if (command === "upload" && release) {
      for (const uploaded of files(rest).map(asset)) {
        release.assets = [...release.assets.filter((existing) => existing.name !== uploaded.name), uploaded];
      }
      return ok;
    }
    if (command === "edit" && release && rest.includes("--draft=false")) {
      release.isDraft = false;
      return ok;
    }
    return { status: 1, stdout: "", stderr: `the fake gh does not know ${args.join(" ")}` };
  };
  return { gh, calls, state: () => release };
};

const TAG_PUSH = { GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v3.0.0-pre" };

describe("publish", () => {
  const root = checkout("3.0.0-pre");
  const out = packed("3.0.0-pre", root);
  const files = [zipName("3.0.0-pre", "dist-native"), zipName("3.0.0-pre", "dist-wasm"), SUMS_FILE].map((name) => join(out, name));
  const quiet = () => {};

  it("on the push of the tag: creates the draft with the three files and the notes, checks its assets, publishes it", () => {
    const fake = fakeGh(null);
    publish({ directory: out, tag: "v3.0.0-pre", env: TAG_PUSH, root, gh: fake.gh, log: quiet });
    const view = ["release", "view", "v3.0.0-pre", "--json", "tagName,isDraft,isPrerelease,assets"];
    expect(fake.calls).toEqual([
      view,
      ["release", "create", "v3.0.0-pre", "--verify-tag", "--draft", "--prerelease", "--title", "Dreamcast DevTools 3.0.0-pre", "--notes-file", join(out, NOTES_FILE), ...files],
      view,
      ["release", "edit", "v3.0.0-pre", "--draft=false"],
      view,
    ]);
    expect(fake.state()).toMatchObject({ isDraft: false, isPrerelease: true });
    expect(fake.state()?.assets.map((asset) => asset.name).sort()).toEqual(files.map((file) => basename(file)).sort());
  });

  it("with the draft there already (a run again): uploads with --clobber and publishes", () => {
    const fake = fakeGh({ isDraft: true, assets: [{ name: SUMS_FILE, size: 1, digest: "sha256:00", state: "uploaded" }] });
    publish({ directory: out, tag: "v3.0.0-pre", env: TAG_PUSH, root, gh: fake.gh, log: quiet });
    expect(fake.calls.map((call) => call.slice(0, 4))).toEqual([
      ["release", "view", "v3.0.0-pre", "--json"],
      ["release", "upload", "v3.0.0-pre", "--clobber"],
      ["release", "view", "v3.0.0-pre", "--json"],
      ["release", "edit", "v3.0.0-pre", "--draft=false"],
      ["release", "view", "v3.0.0-pre", "--json"],
    ]);
    expect(fake.calls[1].slice(4)).toEqual(files);
    expect(fake.state()?.isDraft).toBe(false);
  });

  it("refuses a Release published already, and changes nothing", () => {
    const fake = fakeGh({ isDraft: false });
    expect(() => publish({ directory: out, tag: "v3.0.0-pre", env: TAG_PUSH, root, gh: fake.gh, log: quiet })).toThrow(/published already/);
    expect(fake.calls.map((call) => call[1])).toEqual(["view"]);
  });

  it("refuses unless the event is the push of a tag: a dispatch, on a tag ref too, creates nothing", () => {
    for (const env of [
      { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v3.0.0-pre" },
      { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
      { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF_TYPE: "branch" },
      { GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
      {},
    ]) {
      const fake = fakeGh(null);
      expect(() => publish({ directory: out, tag: "v3.0.0-pre", env, root, gh: fake.gh, log: quiet }), JSON.stringify(env)).toThrow(/on the push of a tag alone/);
      expect(fake.calls).toEqual([]);
    }
  });

  it("refuses the tag v3.0.1 over the base 3.0.0-pre, a tag that is not the one pushed, files of another version", () => {
    const fake = fakeGh(null);
    expect(() => publish({ directory: out, tag: "v3.0.1", env: { ...TAG_PUSH, GITHUB_REF_NAME: "v3.0.1" }, root, gh: fake.gh, log: quiet })).toThrow(/the tag v3\.0\.1 is not the base 3\.0\.0-pre/);
    expect(() => publish({ directory: out, tag: "v3.0.0-pre", env: { ...TAG_PUSH, GITHUB_REF_NAME: "v3.0.1" }, root, gh: fake.gh, log: quiet })).toThrow(/not the tag pushed/);
    const later = packed("3.0.0-pre+2.g0123456789", root);
    expect(() => publish({ directory: later, tag: "v3.0.0-pre", env: TAG_PUSH, root, gh: fake.gh, log: quiet })).toThrow(/the release files are of 3\.0\.0-pre\+2\.g0123456789/);
    expect(fake.calls).toEqual([]);
  });

  it("leaves a draft whose assets are not the files unpublished", () => {
    const fake = fakeGh(null, { dropOnCreate: true });
    expect(() => publish({ directory: out, tag: "v3.0.0-pre", env: TAG_PUSH, root, gh: fake.gh, log: quiet })).toThrow(/is not the release files: its assets are .*It stays a draft/);
    expect(fake.calls.map((call) => call[1])).toEqual(["view", "create", "view"]);
    expect(fake.state()?.isDraft).toBe(true);
  });

  it("leaves a draft unpublished whose asset under a file's name is not the file: another size, another digest", () => {
    const cases: [string, (asset: FakeAsset) => FakeAsset, RegExp][] = [
      // cut short, and no digest given for it: the size alone tells
      [SUMS_FILE, (asset) => ({ ...asset, size: asset.size - 1, digest: null }), /: SHA256SUMS has \d+ bytes, not \d+\. It stays a draft$/],
      // the same size, other bytes
      [
        zipName("3.0.0-pre", "dist-native"),
        (asset) => ({ ...asset, digest: `sha256:${"0".repeat(64)}` }),
        /: dreamcast-devtools-3\.0\.0-pre-dist-native\.zip has the digest sha256:0{64}, not sha256:[0-9a-f]{64} \(SHA256SUMS\)\. It stays a draft$/,
      ],
    ];
    for (const [name, alter, problem] of cases) {
      const fake = fakeGh(null, { alterOnCreate: (asset) => (asset.name === name ? alter(asset) : asset) });
      expect(() => publish({ directory: out, tag: "v3.0.0-pre", env: TAG_PUSH, root, gh: fake.gh, log: quiet }), name).toThrow(problem);
      expect(fake.calls.map((call) => call[1])).toEqual(["view", "create", "view"]);
      expect(fake.state()?.isDraft).toBe(true);
    }
  });

  it("stops at a view that fails for another reason than a missing Release", () => {
    const fake = fakeGh(null, { viewError: "HTTP 401: Bad credentials" });
    expect(() => publish({ directory: out, tag: "v3.0.0-pre", env: TAG_PUSH, root, gh: fake.gh, log: quiet })).toThrow(/Bad credentials/);
    expect(fake.calls.map((call) => call[1])).toEqual(["view"]);
  });

  it("makes a release, not a pre-release, of a tag without a pre-release part", () => {
    const releaseRoot = checkout("3.0.1");
    const releaseOut = packed("3.0.1", releaseRoot);
    const fake = fakeGh(null);
    publish({ directory: releaseOut, tag: "v3.0.1", env: { ...TAG_PUSH, GITHUB_REF_NAME: "v3.0.1" }, root: releaseRoot, gh: fake.gh, log: quiet });
    expect(fake.calls[1]).not.toContain("--prerelease");
    expect(fake.calls[1].slice(0, 7)).toEqual(["release", "create", "v3.0.1", "--verify-tag", "--draft", "--title", "Dreamcast DevTools 3.0.1"]);
  });
});

describe("tags and commands", () => {
  it("takes the version of a v tag, and nothing else as a tag", () => {
    expect(tagVersion("v3.0.0-pre")).toBe("3.0.0-pre");
    expect(tagVersion("v3.0.1")).toBe("3.0.1");
    for (const tag of ["3.0.0-pre", "v3.0", "v3.0.0+g1", "vfoo", "foo"]) {
      expect(() => tagVersion(tag), tag).toThrow(/not a version tag/);
    }
  });

  it("titles the Release Dreamcast DevTools <version>", () => {
    expect(createCommand("v3.0.0-pre", "3.0.0-pre", "n.md", ["a.zip"])).toEqual(["release", "create", "v3.0.0-pre", "--verify-tag", "--draft", "--prerelease", "--title", "Dreamcast DevTools 3.0.0-pre", "--notes-file", "n.md", "a.zip"]);
  });
});
