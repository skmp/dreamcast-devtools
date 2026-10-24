// The release files of the UI and its GitHub Release, in three invocations, each named on the command line (the CI
// jobs of .github/workflows/ci.yml call them; nothing is chosen from the environment):
//
//   release-files.ts pack --version <version> --native <dist-native> --wasm <dist-wasm> --out <directory>
//       (the job package, on every run.) Writes into <directory>, which must be new or empty:
//         dreamcast-devtools-<version>-dist-native.zip  dreamcast-devtools-<version>-dist-native/ with LICENSE and
//                                                       dist-native/ (the files bundle-info.json lists, and it)
//         dreamcast-devtools-<version>-dist-wasm.zip    the same of dist-wasm/
//         SHA256SUMS                                    the two zips, in sha256sum's format, sorted by name
//         release-notes.md                              from scripts/release-notes.template.md
//       Both builds must say <version> in their bundle-info.json and hold exactly the files it lists. The zips are
//       the same bytes for the same files: entries sorted, relative, one fixed time. pack never runs gh.
//
//   release-files.ts check --dir <directory> [--tag <tag>]
//       (the job release-check: pull requests and dispatches.) Creates nothing and never runs gh. The files of
//       <directory> are pack's, named with the version of this checkout, SHA256SUMS holds. Without a tag (a pull
//       request) nothing more is asked of the version; with one (a dispatch, its input tag) the tag without its v
//       must be the base, package.json's version, as publish will ask. Prints the gh commands publish would run on
//       the push of that tag (v<base> without one), and the notes, with the tag's version.
//
//   release-files.ts publish --dir <directory> --tag <tag>
//       (the job release, on the push of a tag v*, alone.) Refuses unless GITHUB_EVENT_NAME is push and
//       GITHUB_REF_TYPE is tag. Takes pack's files from <directory> (the job package's artifact; it zips nothing):
//       the tag without its v must be their version and the base; SHA256SUMS must hold. Then
//         gh release create <tag> --verify-tag --draft [--prerelease] --title "Dreamcast DevTools <version>"
//            --notes-file release-notes.md <the two zips> SHA256SUMS
//       (--prerelease for a version with a pre-release part), the draft's assets checked against the files and
//       SHA256SUMS, then gh release edit <tag> --draft=false. With the draft there already (a run again) it
//       uploads with --clobber and publishes; a Release already published is refused.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { BUNDLE_INFO_FILE, collectBundleInfo, type BundleInfo } from "./bundle-info";
import { readBase, ROOT, versionInfo } from "./version";

export const PRODUCT = "dreamcast-devtools";
export const KINDS = ["dist-native", "dist-wasm"] as const;
export type Kind = (typeof KINDS)[number];
export const SUMS_FILE = "SHA256SUMS";
export const NOTES_FILE = "release-notes.md";
export const LICENSE_FILE = "LICENSE";
export const NOTES_TEMPLATE = join(ROOT, "scripts", "release-notes.template.md");

/** The folder inside a zip, and the zip's name without .zip. */
export const folderName = (version: string, kind: Kind): string => `${PRODUCT}-${version}-${kind}`;
export const zipName = (version: string, kind: Kind): string => `${folderName(version, kind)}.zip`;

/** A SemVer version: what the file names and the title may carry. */
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const checkVersion = (version: string): string => {
  if (!SEMVER.test(version)) {
    throw new Error(`'${version}' is not a version (X.Y.Z, a pre-release part, build metadata)`);
  }
  return version;
};

/** The version a tag names: v<version>, without build metadata. */
export const tagVersion = (tag: string): string => {
  const match = /^v(.+)$/.exec(tag);
  if (!match || match[1].includes("+") || !SEMVER.test(match[1])) {
    throw new Error(`'${tag}' is not a version tag (v<X.Y.Z>, a pre-release part allowed)`);
  }
  return match[1];
};

/** A pre-release (3.0.0-pre) makes a pre-release on GitHub; 3.0.1 a release. */
export const isPrerelease = (version: string): boolean => version.split("+")[0].includes("-");

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

// ---- zip ------------------------------------------------------------------------------------------------------------

export interface ZipEntry {
  /** relative, with forward slashes */
  name: string;
  data: Buffer;
}

/** 1980-01-01 00:00, the first time a zip can say: every entry has it, so the same files give the same zip. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
/** a regular file, rw-r--r-- */
const UNIX_MODE = 0o100644;
const UTF8_NAMES = 0x0800;

const checkEntryName = (name: string): void => {
  const segments = name.split("/");
  if (name === "" || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`'${name}' is no relative path for a zip entry`);
  }
};

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** A zip of `entries`, sorted by name, each deflated (or stored when that is not smaller), one fixed time. */
export const makeZip = (entries: ZipEntry[]): Buffer => {
  const sorted = [...entries].sort(byName);
  if (sorted.length > 0xfffe) {
    throw new Error(`${sorted.length} entries: more than a zip without zip64 holds`);
  }
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  sorted.forEach((entry, i) => {
    checkEntryName(entry.name);
    if (i > 0 && sorted[i - 1].name === entry.name) {
      throw new Error(`'${entry.name}' twice in one zip`);
    }
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((UNIX_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    directory.push(central, name);
    offset += local.length + name.length + body.length;
    if (offset > 0xfffffffe) {
      throw new Error("the zip would be larger than a zip without zip64 holds");
    }
  });
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
};

/** The entries of a zip, in the order of its central directory, each checked against its CRC-32 and size. */
export const readZip = (zip: Buffer): ZipEntry[] => {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    throw new Error("not a zip: no end of central directory");
  }
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`not a zip: entry ${i} of the central directory`);
    }
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (zip.readUInt32LE(localAt) !== 0x04034b50) {
      throw new Error(`not a zip: the local header of ${name}`);
    }
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const body = zip.subarray(dataAt, dataAt + compressedSize);
    const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;
    if (data === null) {
      throw new Error(`${name}: compression method ${method}`);
    }
    if (data.length !== size || crc32(data) !== crc) {
      throw new Error(`${name}: its size or CRC-32 does not match`);
    }
    entries.push({ name, data });
  }
  return entries;
};

// ---- the files ------------------------------------------------------------------------------------------------------

/** The files of a build: those its bundle-info.json lists, and bundle-info.json; refused unless they are all there. */
export const bundleFiles = (directory: string, version: string): { path: string; data: Buffer }[] => {
  const infoPath = join(directory, BUNDLE_INFO_FILE);
  if (!existsSync(infoPath)) {
    throw new Error(`${infoPath} is missing: build first (npm run build:native, npm run build:wasm)`);
  }
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as BundleInfo;
  if (info.version !== version) {
    throw new Error(`${infoPath} says version ${info.version}, not ${version}: the build is of another commit or tree; build again`);
  }
  const found = collectBundleInfo(directory, info).files;
  if (JSON.stringify(found) !== JSON.stringify(info.files)) {
    const listed = new Set(info.files.map((file) => `${file.path} ${file.sha256}`));
    const there = new Set(found.map((file) => `${file.path} ${file.sha256}`));
    const missing = [...listed].filter((file) => !there.has(file)).map((file) => file.split(" ")[0]);
    const unlisted = [...there].filter((file) => !listed.has(file)).map((file) => file.split(" ")[0]);
    throw new Error(`${directory} does not hold the files its ${BUNDLE_INFO_FILE} lists (listed, missing or changed: ${missing.join(", ") || "none"}; there, not listed or changed: ${unlisted.join(", ") || "none"}); build again`);
  }
  if (!info.files.some((file) => file.path === "index.html")) {
    throw new Error(`${directory} has no index.html`);
  }
  return [
    ...info.files.map((file) => ({ path: file.path, data: readFileSync(join(directory, file.path)) })),
    { path: BUNDLE_INFO_FILE, data: readFileSync(infoPath) },
  ];
};

/** SHA256SUMS of `files`: "<sha256>  <name>" per line, sorted by name. */
export const sumsText = (files: { name: string; data: Buffer }[]): string =>
  [...files]
    .sort(byName)
    .map((file) => `${sha256(file.data)}  ${file.name}\n`)
    .join("");

/** The lines of a SHA256SUMS, name to sha256; refused unless each is "<64 hex digits>  <name>", sorted, once. */
export const parseSums = (text: string): Map<string, string> => {
  const sums = new Map<string, string>();
  if (!text.endsWith("\n")) {
    throw new Error(`${SUMS_FILE} does not end with a line break`);
  }
  let last = "";
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([^/\\\s]+)$/.exec(line);
    if (!match || sums.has(match[2]) || match[2] <= last) {
      throw new Error(`${SUMS_FILE}: '${line}' is not a line of sha256sum's format, sorted by name, once`);
    }
    sums.set(match[2], match[1]);
    last = match[2];
  }
  return sums;
};

/** The notes of the Release of `version`, from the committed template. */
export const renderNotes = (version: string, template = readFileSync(NOTES_TEMPLATE, "utf8")): string => {
  const values: Record<string, string> = {
    version,
    tag: `v${version}`,
    native_zip: zipName(version, "dist-native"),
    native_folder: folderName(version, "dist-native"),
    wasm_zip: zipName(version, "dist-wasm"),
    wasm_folder: folderName(version, "dist-wasm"),
  };
  const notes = template.replace(/\{\{([a-z_]+)\}\}/g, (whole, key: string) => {
    if (!(key in values)) {
      throw new Error(`${NOTES_TEMPLATE}: no value for ${whole}`);
    }
    return values[key];
  });
  if (!notes.includes(`Dreamcast DevTools ${version}`)) {
    throw new Error(`${NOTES_TEMPLATE}: the notes do not say "Dreamcast DevTools ${version}"`);
  }
  return notes;
};

export interface PackOptions {
  version: string;
  native: string;
  wasm: string;
  out: string;
  /** the checkout whose LICENSE goes into the zips (this one by default) */
  root?: string;
}

/** pack: the two zips, SHA256SUMS and the notes into `out`. Runs no other program. */
export const pack = (options: PackOptions): string[] => {
  const version = checkVersion(options.version);
  const license = readFileSync(join(options.root ?? ROOT, LICENSE_FILE));
  if (existsSync(options.out) && readdirSync(options.out).length > 0) {
    throw new Error(`${options.out} is not empty: pack writes into a new or empty directory`);
  }
  const notes = renderNotes(version);
  const zips: { name: string; data: Buffer }[] = [];
  for (const kind of KINDS) {
    const files = bundleFiles(kind === "dist-native" ? options.native : options.wasm, version);
    const folder = folderName(version, kind);
    const entries = [{ name: `${folder}/${LICENSE_FILE}`, data: license }, ...files.map((file) => ({ name: `${folder}/${kind}/${file.path}`, data: file.data }))];
    zips.push({ name: zipName(version, kind), data: makeZip(entries) });
  }
  mkdirSync(options.out, { recursive: true });
  for (const zip of zips) {
    writeFileSync(join(options.out, zip.name), zip.data);
  }
  writeFileSync(join(options.out, SUMS_FILE), sumsText(zips));
  writeFileSync(join(options.out, NOTES_FILE), notes);
  return [
    ...zips.map((zip) => `${zip.name}: ${zip.data.length} bytes, ${readZip(zip.data).length} entries, sha256 ${sha256(zip.data)}`),
    `${SUMS_FILE}, ${NOTES_FILE}: written`,
  ];
};

export interface ReleaseFiles {
  version: string;
  /** the paths of the two zips and of SHA256SUMS, the files of the Release */
  files: string[];
  notes: string;
}

/**
 * The files pack made in `directory`, checked: the two zips of one version and nothing else but SHA256SUMS and the
 * notes; SHA256SUMS right; in each zip its folder alone, the UI's LICENSE, and the build at that version with the files
 * its bundle-info.json lists.
 */
export const readRelease = (directory: string, license: Buffer): ReleaseFiles => {
  const names = readdirSync(directory).sort();
  const versionOf = (kind: Kind): string => {
    const pattern = new RegExp(`^${PRODUCT}-(.+)-${kind}\\.zip$`);
    const found = names.map((name) => pattern.exec(name)?.[1]).filter((version): version is string => version !== undefined);
    if (found.length !== 1) {
      throw new Error(`${directory}: ${found.length} zips of ${kind}, not one (${names.join(", ")})`);
    }
    return checkVersion(found[0]);
  };
  const version = versionOf("dist-native");
  if (versionOf("dist-wasm") !== version) {
    throw new Error(`${directory}: the zips are of two versions (${names.join(", ")})`);
  }
  const zips = KINDS.map((kind) => zipName(version, kind));
  const expected = [...zips, SUMS_FILE, NOTES_FILE].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`${directory} holds ${names.join(", ")}; pack's files are ${expected.join(", ")}`);
  }

  const sums = parseSums(readFileSync(join(directory, SUMS_FILE), "utf8"));
  if (JSON.stringify([...sums.keys()]) !== JSON.stringify(zips)) {
    throw new Error(`${SUMS_FILE} names ${[...sums.keys()].join(", ")}, not ${zips.join(", ")}`);
  }
  for (const kind of KINDS) {
    const name = zipName(version, kind);
    const data = readFileSync(join(directory, name));
    if (sha256(data) !== sums.get(name)) {
      throw new Error(`${name}: its sha256 is not the one of ${SUMS_FILE}`);
    }
    const folder = folderName(version, kind);
    const entries = new Map(readZip(data).map((entry) => [entry.name, entry.data]));
    if (!entries.get(`${folder}/${LICENSE_FILE}`)?.equals(license)) {
      throw new Error(`${name}: ${folder}/${LICENSE_FILE} is missing or is not the UI's LICENSE`);
    }
    const infoData = entries.get(`${folder}/${kind}/${BUNDLE_INFO_FILE}`);
    const info = infoData ? (JSON.parse(infoData.toString("utf8")) as BundleInfo) : null;
    if (!info || info.version !== version) {
      throw new Error(`${name}: ${folder}/${kind}/${BUNDLE_INFO_FILE} is missing or does not say version ${version}`);
    }
    const allowed = new Set([`${folder}/${LICENSE_FILE}`, `${folder}/${kind}/${BUNDLE_INFO_FILE}`]);
    for (const file of info.files) {
      const entry = `${folder}/${kind}/${file.path}`;
      allowed.add(entry);
      const content = entries.get(entry);
      if (!content || sha256(content) !== file.sha256) {
        throw new Error(`${name}: ${entry} is missing or is not the file its ${BUNDLE_INFO_FILE} lists`);
      }
    }
    const others = [...entries.keys()].filter((entry) => !allowed.has(entry));
    if (others.length > 0) {
      throw new Error(`${name}: entries that are not of the build: ${others.join(", ")}`);
    }
  }
  const notes = readFileSync(join(directory, NOTES_FILE), "utf8");
  if (!notes.includes(`Dreamcast DevTools ${version}`)) {
    throw new Error(`${NOTES_FILE} does not say "Dreamcast DevTools ${version}"`);
  }
  return { version, files: [...zips, SUMS_FILE].map((name) => join(directory, name)), notes: join(directory, NOTES_FILE) };
};

/** The gh command that makes the draft of `tag`. */
export const createCommand = (tag: string, version: string, notes: string, files: string[]): string[] => [
  "release",
  "create",
  tag,
  "--verify-tag",
  "--draft",
  ...(isPrerelease(version) ? ["--prerelease"] : []),
  "--title",
  `Dreamcast DevTools ${version}`,
  "--notes-file",
  notes,
  ...files,
];

const viewCommand = (tag: string): string[] => ["release", "view", tag, "--json", "tagName,isDraft,isPrerelease,assets"];
const uploadCommand = (tag: string, files: string[]): string[] => ["release", "upload", tag, "--clobber", ...files];
const publishCommand = (tag: string): string[] => ["release", "edit", tag, "--draft=false"];

/** A command line as a log shows it. */
const shown = (args: string[]): string => ["gh", ...args].map((arg) => (/^[A-Za-z0-9_.,:=/+@-]+$/.test(arg) ? arg : `"${arg}"`)).join(" ");

export interface CheckOptions {
  directory: string;
  /** the input tag of a dispatch; "" or absent on a pull request */
  tag?: string;
  /** GITHUB_EVENT_NAME and the like */
  env: NodeJS.ProcessEnv;
  root?: string;
  /** the version of this checkout (scripts/version.ts by default) */
  version?: string;
}

/** check: pack's files against the version of this checkout and, on a dispatch, the base against the tag. Creates nothing. */
export const check = (options: CheckOptions): string[] => {
  const root = options.root ?? ROOT;
  const event = options.env.GITHUB_EVENT_NAME ?? "";
  const tag = options.tag ?? "";
  if (event === "workflow_dispatch" && tag === "") {
    throw new Error("a dispatch names the tag it checks (its input tag)");
  }
  if (event === "pull_request" && tag !== "") {
    throw new Error(`a pull request has no tag to check, and ${tag} was given`);
  }
  const base = readBase(root);
  const own = options.version ?? versionInfo(root, base).version;
  const release = readRelease(options.directory, readFileSync(join(root, LICENSE_FILE)));
  if (release.version !== own) {
    throw new Error(`the release files are named with ${release.version}, and this checkout is ${own}`);
  }
  const lines = [`${release.files.map((file) => basename(file)).join(", ")}: named with ${release.version}, ${SUMS_FILE} holds, each zip has the UI's ${LICENSE_FILE} and its build at ${release.version}`];
  let wouldTag = `v${base}`;
  if (tag === "") {
    lines.push(`no tag (${event || "no event"}): the version is not compared with a tag`);
  } else {
    if (tagVersion(tag) !== base) {
      throw new Error(`the tag ${tag} is not the base ${base} of package.json: publish would refuse it`);
    }
    wouldTag = tag;
    lines.push(`the tag ${tag} is the base ${base} of package.json`);
  }
  const version = tagVersion(wouldTag);
  const files = [...KINDS.map((kind) => zipName(version, kind)), SUMS_FILE];
  lines.push(
    `publish, on the push of the tag ${wouldTag}, would run (the files named with ${version}):`,
    `  ${shown(viewCommand(wouldTag))}`,
    `  ${shown(createCommand(wouldTag, version, NOTES_FILE, files))}`,
    `  (with the draft there already: ${shown(uploadCommand(wouldTag, files))})`,
    `  ${shown(viewCommand(wouldTag))}   (the draft's assets against the files and ${SUMS_FILE})`,
    `  ${shown(publishCommand(wouldTag))}`,
    `the notes:`,
    ...renderNotes(version).trimEnd().split("\n").map((line) => `  | ${line}`),
  );
  return lines;
};

/** How gh is run: spawnSync, or a stand-in in the tests. */
export type Gh = (args: string[]) => { status: number; stdout: string; stderr: string };

const runGh: Gh = (args) => {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (result.error) {
    throw new Error(`gh could not be run: ${result.error.message}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

interface Asset {
  name: string;
  size: number;
  digest?: string | null;
  state?: string;
}

interface ReleaseView {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
  assets: Asset[];
}

export interface PublishOptions {
  directory: string;
  tag: string;
  /** GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME */
  env: NodeJS.ProcessEnv;
  root?: string;
  gh?: Gh;
  log?: (line: string) => void;
}

/** publish: the draft Release of `tag` with pack's files, its assets checked, then published. Only on the push of a tag. */
export const publish = (options: PublishOptions): void => {
  const { env, tag } = options;
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF_TYPE !== "tag") {
    throw new Error(
      `publish runs on the push of a tag alone (GITHUB_EVENT_NAME push, GITHUB_REF_TYPE tag), and this is ${env.GITHUB_EVENT_NAME ?? "no event"}, ${env.GITHUB_REF_TYPE ?? "no ref type"}: nothing is created`,
    );
  }
  if (env.GITHUB_REF_NAME !== undefined && env.GITHUB_REF_NAME !== tag) {
    throw new Error(`the tag ${tag} is not the tag pushed, ${env.GITHUB_REF_NAME}: nothing is created`);
  }
  const root = options.root ?? ROOT;
  const gh = options.gh ?? runGh;
  const log = options.log ?? ((line: string) => console.log(line));
  const version = tagVersion(tag);
  const base = readBase(root);
  if (version !== base) {
    throw new Error(`the tag ${tag} is not the base ${base} of package.json: nothing is created`);
  }
  const release = readRelease(options.directory, readFileSync(join(root, LICENSE_FILE)));
  if (release.version !== version) {
    throw new Error(`the release files are of ${release.version}, and the tag is ${tag}: nothing is created`);
  }
  const expected = new Map(
    release.files.map((file) => {
      const data = readFileSync(file);
      return [basename(file), { size: data.length, sha256: sha256(data) }];
    }),
  );

  const run = (args: string[]): string => {
    log(shown(args));
    const result = gh(args);
    if (result.status !== 0) {
      throw new Error(`${shown(args)} failed (${result.status}): ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  const view = (): ReleaseView | null => {
    const args = viewCommand(tag);
    log(shown(args));
    const result = gh(args);
    if (result.status !== 0) {
      if (/release not found/i.test(result.stderr)) {
        return null;
      }
      throw new Error(`${shown(args)} failed (${result.status}): ${result.stderr.trim()}`);
    }
    return JSON.parse(result.stdout) as ReleaseView;
  };

  const existing = view();
  if (existing && !existing.isDraft) {
    throw new Error(`the Release ${tag} is published already: nothing is changed`);
  }
  if (existing) {
    log(`the draft of ${tag} is there already: its files are uploaded again`);
    run(uploadCommand(tag, release.files));
  } else {
    run(createCommand(tag, version, release.notes, release.files));
  }

  const draft = view();
  if (!draft || !draft.isDraft) {
    throw new Error(`the Release ${tag} is ${draft ? "not a draft" : "not there"} after it was made: not published`);
  }
  const problems: string[] = [];
  const names = draft.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expected.keys()].sort())) {
    problems.push(`its assets are ${names.join(", ") || "none"}, not ${[...expected.keys()].sort().join(", ")}`);
  }
  for (const asset of draft.assets) {
    const file = expected.get(asset.name);
    if (!file) {
      continue;
    }
    if (asset.size !== file.size) {
      problems.push(`${asset.name} has ${asset.size} bytes, not ${file.size}`);
    }
    if (typeof asset.digest === "string" && asset.digest !== `sha256:${file.sha256}`) {
      problems.push(`${asset.name} has the digest ${asset.digest}, not sha256:${file.sha256} (${SUMS_FILE})`);
    }
    if (asset.state !== undefined && asset.state !== "uploaded") {
      problems.push(`${asset.name} is ${asset.state}, not uploaded`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`the draft of ${tag} is not the release files: ${problems.join("; ")}. It stays a draft`);
  }
  log(`the draft of ${tag} holds ${names.join(", ")}, each of the size and sha256 of the files`);
  run(publishCommand(tag));
  const published = view();
  if (!published || published.isDraft) {
    throw new Error(`the Release ${tag} is still a draft`);
  }
  log(`the Release ${tag}, "Dreamcast DevTools ${version}", is published${published.isPrerelease ? " as a pre-release" : ""}`);
};

// ---- the command line -----------------------------------------------------------------------------------------------

const USAGE = `usage:
  release-files.ts pack --version <version> --native <dist-native> --wasm <dist-wasm> --out <directory>
  release-files.ts check --dir <directory> [--tag <tag>]
  release-files.ts publish --dir <directory> --tag <tag>`;

const required = (values: Record<string, string | undefined>, name: string): string => {
  const value = values[name];
  if (value === undefined || value === "") {
    throw new Error(`--${name} is missing\n${USAGE}`);
  }
  return value;
};

export const main = (argv: string[]): void => {
  const [command, ...rest] = argv;
  const options = { version: { type: "string" }, native: { type: "string" }, wasm: { type: "string" }, out: { type: "string" }, dir: { type: "string" }, tag: { type: "string" } } as const;
  const { values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false });
  if (command === "pack") {
    for (const line of pack({ version: required(values, "version"), native: required(values, "native"), wasm: required(values, "wasm"), out: required(values, "out") })) {
      console.log(line);
    }
  } else if (command === "check") {
    for (const line of check({ directory: required(values, "dir"), tag: values.tag, env: process.env })) {
      console.log(line);
    }
  } else if (command === "publish") {
    publish({ directory: required(values, "dir"), tag: required(values, "tag"), env: process.env });
  } else {
    throw new Error(USAGE);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(`release-files ${process.argv[2] ?? ""}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
