import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * `bundle-info.json`, written into the output directory of every build:
 *
 *   { "version", "protocol", "gitRev", "files": [{ "path", "bytes", "sha256" }] }
 *
 * The emulator embeds `dist-native/` in its debugger. Its build reads this file: a bundle
 * whose `protocol` differs from the emulator's protocol version stops the configure step,
 * `version` is what `debugger.describe` reports as `ui`, and every listed file is checked
 * against its `sha256` before it is embedded (a half-written or mixed-up build fails
 * there). The file is written last, after everything it lists.
 */
export const BUNDLE_INFO_FILE = "bundle-info.json";

export interface BundleFile {
  /** relative to the bundle directory, with forward slashes */
  path: string;
  bytes: number;
  /** lower-case hex */
  sha256: string;
}

export interface BundleInfo {
  /** the version the UI shows: package.json version, plus `+<git describe>` in a git checkout */
  version: string;
  /** PROTOCOL_VERSION of the UI */
  protocol: number;
  /** the commit the bundle was built from, with "-dirty" when the tree had changes; "" without git */
  gitRev: string;
  files: BundleFile[];
}

export interface BundleMeta {
  version: string;
  protocol: number;
  gitRev: string;
}

/** The emulator's build embeds `version` and `gitRev` as C string literals and accepts only these characters. */
const embeddable = (text: string): string => text.replace(/[^A-Za-z0-9_.+~:/ -]/g, "_");

/** Every file below `directory`, relative, sorted; without hidden names (the emulator serves no path that has one). */
const listFiles = (directory: string, prefix = ""): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(join(directory, entry.name), path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
};

export const collectBundleInfo = (directory: string, meta: BundleMeta): BundleInfo => ({
  version: embeddable(meta.version),
  protocol: meta.protocol,
  gitRev: embeddable(meta.gitRev),
  files: listFiles(directory)
    .filter((path) => path !== BUNDLE_INFO_FILE)
    .map((path) => {
      const content = readFileSync(join(directory, path));
      return { path, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
    }),
});

export const writeBundleInfo = (directory: string, meta: BundleMeta): BundleInfo => {
  const info = collectBundleInfo(directory, meta);
  writeFileSync(join(directory, BUNDLE_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
  return info;
};

/** Writes `bundle-info.json` at the end of `vite build`. */
export const bundleInfoPlugin = (meta: BundleMeta): Plugin => {
  let outDir = "";
  return {
    name: "nulldc-bundle-info",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      // a build that failed has written no page, and gets no manifest that says otherwise
      if (!existsSync(join(outDir, "index.html"))) {
        return;
      }
      const info = writeBundleInfo(outDir, meta);
      const bytes = info.files.reduce((sum, file) => sum + file.bytes, 0);
      console.log(`${outDir}/${BUNDLE_INFO_FILE}: version ${info.version}, protocol ${info.protocol}, ${info.files.length} files, ${bytes} bytes`);
    },
  };
};
