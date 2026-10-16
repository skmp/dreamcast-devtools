// npm run build:dspsim: regenerates src/wasm/aica-dsp/ from crates/aica-dsp with wasm-pack.
// The absolute path of the cargo registry would end up in a panic location inside the wasm; it is remapped, so the
// committed file is the same whoever builds it (with the toolchain of the commit that last regenerated it).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const crate = join(root, "crates", "aica-dsp");
const out = join(root, "src", "wasm", "aica-dsp");
const registry = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry", "src");

// CARGO_ENCODED_RUSTFLAGS separates the flags with 0x1f, so a registry path with blanks stays one flag
const flags = (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
flags.push(`--remap-path-prefix=${registry}=/cargo-registry`);

const run = spawnSync("wasm-pack", ["build", "--target", "web", "--out-dir", "../../src/wasm/aica-dsp"], {
  cwd: crate,
  stdio: "inherit",
  env: { ...process.env, RUSTFLAGS: undefined, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
  shell: process.platform === "win32",
});
if (run.status !== 0) process.exit(run.status ?? 1);
// wasm-pack writes a .gitignore that would hide its output from git
rmSync(join(out, ".gitignore"), { force: true });
