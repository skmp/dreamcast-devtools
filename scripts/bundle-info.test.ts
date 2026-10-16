import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLE_INFO_FILE, collectBundleInfo, writeBundleInfo } from "./bundle-info";

const directories: string[] = [];

const makeBundle = (files: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), "bundle-info-test-"));
  directories.push(directory);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return directory;
};

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("bundle-info.json", () => {
  const meta = { version: "3.0.0-pre+6a66d23", protocol: 3, gitRev: "6a66d23f0c1e" };

  it("lists every file of the bundle with its size and sha256, sorted, with forward slashes", () => {
    const directory = makeBundle({
      "index.html": "<!doctype html>",
      "assets/index-abc.js": "console.log(1)",
      "assets/empty.txt": "",
      "nulldc_logo.png": "png",
    });
    const info = collectBundleInfo(directory, meta);
    expect(Object.keys(info)).toEqual(["version", "protocol", "gitRev", "files"]);
    expect(info).toMatchObject(meta);
    expect(info.files.map((file) => file.path)).toEqual(["assets/empty.txt", "assets/index-abc.js", "index.html", "nulldc_logo.png"]);
    expect(info.files[0]).toEqual({ path: "assets/empty.txt", bytes: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    expect(info.files[2]).toEqual({
      path: "index.html",
      bytes: 15,
      sha256: createHash("sha256").update("<!doctype html>").digest("hex"),
    });
  });

  it("does not list itself, nor hidden files and directories", () => {
    const directory = makeBundle({
      "index.html": "x",
      [BUNDLE_INFO_FILE]: "{}",
      ".DS_Store": "x",
      ".vite/manifest.json": "{}",
      "assets/.hidden": "x",
    });
    expect(collectBundleInfo(directory, meta).files.map((file) => file.path)).toEqual(["index.html"]);
  });

  it("is written as JSON that reads back, and a second build replaces it", () => {
    const directory = makeBundle({ "index.html": "one" });
    writeBundleInfo(directory, meta);
    const first = JSON.parse(readFileSync(join(directory, BUNDLE_INFO_FILE), "utf8"));
    expect(first.files).toHaveLength(1);
    writeFileSync(join(directory, "index.html"), "two!");
    const second = writeBundleInfo(directory, { ...meta, protocol: 4 });
    expect(JSON.parse(readFileSync(join(directory, BUNDLE_INFO_FILE), "utf8"))).toEqual(second);
    expect(second.protocol).toBe(4);
    expect(second.files[0].bytes).toBe(4);
    expect(second.files[0].sha256).not.toBe(first.files[0].sha256);
  });

  it("keeps version and gitRev to the characters the emulator's build can embed", () => {
    const info = collectBundleInfo(makeBundle({ "index.html": "x" }), { version: '3.0.0+tag"with\\quotes@x', protocol: 3, gitRev: "abc\ndef" });
    expect(info.version).toBe("3.0.0+tag_with_quotes_x");
    expect(info.gitRev).toBe("abc_def");
    expect(info.version).toMatch(/^[A-Za-z0-9_.+~:/ -]*$/);
  });
});
