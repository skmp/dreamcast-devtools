import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AICA_DSP_API_VERSION } from "../wasm/aica-dsp-core/aica_dsp_core.mjs";

// src/wasm/aica-dsp-core/PROVENANCE.json names the module beside it: the emulator tree it was built from, the
// emscripten version that built it, and the two files build.sh wrote, by size and sha256. The emulator reads it
// (aica.dsp.wasm.devtools), so its keys are fixed: these and no others.

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm", "aica-dsp-core");
const provenance = JSON.parse(readFileSync(join(MODULE_DIR, "PROVENANCE.json"), "utf8")) as Record<string, unknown>;

describe("PROVENANCE.json of the DSP module", () => {
  it("has the keys of the cut's 3.4 item 1, in their order, and no others", () => {
    expect(Object.keys(provenance)).toEqual(["repository", "treeCommit", "dspCoreCommit", "dirty", "emscripten", "apiVersion", "files"]);
    expect(provenance.repository).toBe("skmp/nulldc3");
    expect(provenance.treeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.dspCoreCommit).toMatch(/^[0-9a-f]{40}$/);
    // a committed module is built from a committed core
    expect(provenance.dirty).toBe(false);
    expect(provenance.emscripten).toMatch(/^\d+\.\d+\.\d+\S*$/);
    expect(provenance.apiVersion).toBe(AICA_DSP_API_VERSION);
    const files = provenance.files as Record<string, Record<string, unknown>>;
    expect(Object.keys(files)).toEqual(["aica_dsp_core.wasm", "aica_dsp_core.mjs"]);
    for (const entry of Object.values(files)) {
      expect(Object.keys(entry)).toEqual(["bytes", "sha256"]);
    }
  });

  it("names the bytes beside it", () => {
    const files = provenance.files as Record<string, { bytes: number; sha256: string }>;
    for (const [name, { bytes, sha256 }] of Object.entries(files)) {
      const content = readFileSync(join(MODULE_DIR, name));
      expect(content.length, name).toBe(bytes);
      expect(createHash("sha256").update(content).digest("hex"), name).toBe(sha256);
    }
  });

  it("is beside files with no path of a machine in them, the wasm included", () => {
    const words = ["/home/", "/Users/", "/tmp/", "\\Users\\", "C:\\", "emsdk", homedir(), tmpdir()].filter((word) => word.length > 1);
    for (const name of readdirSync(MODULE_DIR)) {
      const path = join(MODULE_DIR, name);
      if (!statSync(path).isFile()) {
        continue;
      }
      const text = readFileSync(path).toString("latin1");
      expect(words.filter((word) => text.includes(word)), name).toEqual([]);
    }
  });
});
