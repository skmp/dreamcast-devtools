import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AICA_DSP_API_VERSION, loadAicaDsp } from "../wasm/aica-dsp-core/aica_dsp_core.mjs";
import type { AicaDspCore, AicaDspReg } from "../wasm/aica-dsp-core/aica_dsp_core.mjs";

// The committed module (src/wasm/aica-dsp-core/aica_dsp_core.wasm, loaded from its bytes by its loader) against
// the emulator's DSP core compiled natively: known-answers.json is what that core answered to its own known-answer
// programs (the emulator's tests/aica_dsp/dsp_known.cpp: the shifter, the address of a memory step, the ring, the
// read latch, the MIXS banks), call for call, written by `npm run build:dspsim` with scripts/dspsim-known.cpp from
// the same tree as the module. The same calls are made here and every answer has to be the same.

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm", "aica-dsp-core");

// The operations of the trace, as scripts/dspsim-known.cpp has them
const K = {
  CREATE: 1,
  RESET: 2,
  REG_WRITE: 3,
  REG_READ: 4,
  SET: 5,
  GET: 6,
  RAM_WRITE: 7,
  RAM_READ: 8,
  RAM_USED: 9,
  INPUTS: 10,
  STEPS: 11,
  RUN_SAMPLE: 12,
  SWEEP_BEGIN: 13,
  MIXS_SEND: 14,
  MIXS_SEND_LATE: 15,
  CHANNEL_FETCH: 16,
  BUS_READ: 17,
  GROUP: 18,
  CHECK: 19,
  END: 20,
} as const;

const FNV_START = 2166136261;

interface KnownAnswers {
  about: string;
  module: { "aica_dsp_core.wasm": string };
  treeCommit: string;
  apiVersion: number;
  known: number;
  groups: string[];
  trace: number[];
}

const fnv = (hash: number, bytes: Uint8Array): number => {
  for (let i = 0; i < bytes.length; i++) {
    hash = Math.imul(hash ^ bytes[i], 16777619) >>> 0;
  }
  return hash;
};

// An array as the numbers it holds: of every element its value in 32 bit, little endian, and whether it is negative
const numbers = (hash: number, array: ArrayLike<number>): number => {
  const bytes = new Uint8Array(5);
  for (let i = 0; i < array.length; i++) {
    const value = array[i];
    const low = value >>> 0;
    bytes[0] = low & 0xff;
    bytes[1] = (low >>> 8) & 0xff;
    bytes[2] = (low >>> 16) & 0xff;
    bytes[3] = low >>> 24;
    bytes[4] = value < 0 ? 1 : 0;
    hash = fnv(hash, bytes);
  }
  return hash;
};

const answers = JSON.parse(readFileSync(join(MODULE_DIR, "known-answers.json"), "utf8")) as KnownAnswers;
const wasm = readFileSync(join(MODULE_DIR, "aica_dsp_core.wasm"));

/** Replays the trace on a module: the answers that are not the native core's, and how many checks there were. */
const replay = async (bytes: Uint8Array) => {
  const module = await loadAicaDsp(bytes);
  const trace = answers.trace;
  const differences: string[] = [];
  let dsp: AicaDspCore | null = null;
  let group = "";
  let at = 0;
  let operations = 0;
  let compared = 0;
  let checks = 0;
  let ended = false;

  const core = (): AicaDspCore => {
    if (!dsp) {
      throw new Error(`operation ${operations}: no core`);
    }
    return dsp;
  };
  const next = (): number => {
    if (at >= trace.length) {
      throw new Error("the trace ends without K_END");
    }
    return trace[at++];
  };
  const same = (what: string, got: number) => {
    const want = next();
    compared++;
    if (got >>> 0 !== want >>> 0 && differences.length < 20) {
      differences.push(`${group}, operation ${operations}: ${what} is ${(got >>> 0).toString(16)}, the native core's ${want.toString(16)}`);
    }
  };

  while (!ended) {
    const op = next();
    operations++;
    switch (op) {
      case K.CREATE:
        dsp?.destroy();
        dsp = module.create(next());
        dsp.setInputs({ on: false });
        break;
      case K.RESET:
        core().reset();
        break;
      case K.REG_WRITE: {
        const off = next();
        core().writeReg(off, next());
        break;
      }
      case K.REG_READ: {
        const off = next();
        same(`what the CPU reads at ${off.toString(16)}`, core().readReg(off));
        break;
      }
      case K.SET: {
        const index = next() as AicaDspReg;
        core().set(index, next() | 0);
        break;
      }
      case K.GET: {
        const index = next() as AicaDspReg;
        same(`the register of index ${index}`, core().get(index));
        break;
      }
      case K.RAM_WRITE: {
        const addr = next();
        const word = next();
        const ram = core().ram;
        ram[addr] = word & 0xff;
        ram[addr + 1] = (word >>> 8) & 0xff;
        break;
      }
      case K.RAM_READ: {
        const addr = next();
        const ram = core().ram;
        same(`the word of the wave RAM at ${addr.toString(16)}`, ram[addr] | (ram[addr + 1] << 8));
        break;
      }
      case K.RAM_USED: {
        const ram = core().ram;
        let used = 0;
        for (let i = 0; i < ram.length; i++) {
          if (ram[i] !== 0) {
            used++;
          }
        }
        same("the bytes of the wave RAM that are not 0", used);
        break;
      }
      case K.INPUTS: {
        const on = next() !== 0;
        const sent = next();
        const low = next();
        const high = next();
        const mixs = core().inputsMixs;
        for (let i = 0; i < 16; i++) {
          mixs[i] = next() | 0;
        }
        const words = core().inputsFetchWords;
        for (let k = 0; k < 64; k++) {
          words[k] = next();
        }
        core().setInputs({ on, sent, fetch: [low, high] });
        break;
      }
      case K.STEPS: {
        const count = next();
        let views = FNV_START;
        for (let i = 0; i < count; i++) {
          core().step();
          const view = core().view;
          views = fnv(views, new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        }
        same(`the views of ${count} single steps`, views);
        break;
      }
      case K.RUN_SAMPLE:
        core().runSample();
        break;
      case K.SWEEP_BEGIN:
        core().sweepBegin();
        break;
      case K.MIXS_SEND: {
        const bus = next();
        core().mixsSend(bus, next() | 0);
        break;
      }
      case K.MIXS_SEND_LATE: {
        const bus = next();
        core().mixsSendLate(bus, next() | 0);
        break;
      }
      case K.CHANNEL_FETCH:
        core().channelFetch(next());
        break;
      case K.BUS_READ:
        core().busRead(next());
        break;
      case K.GROUP:
        group = answers.groups[next()] ?? "?";
        break;
      case K.CHECK: {
        const d = core();
        checks++;
        same("the digest of the state", fnv(FNV_START, d.saveState()));
        same("TEMP", numbers(FNV_START, d.temp));
        same("MEMS", numbers(FNV_START, d.mems));
        same("MIXS, both banks", numbers(FNV_START, d.mixs));
        same("EFREG", numbers(FNV_START, d.efreg));
        same("COEF", numbers(FNV_START, d.coef));
        same("MADRS", numbers(FNV_START, d.madrs));
        same("MPRO", numbers(FNV_START, d.mpro));
        break;
      }
      case K.END:
        ended = true;
        break;
      default:
        throw new Error(`operation ${operations}: ${op} is no operation of the trace`);
    }
  }
  dsp?.destroy();

  return { differences, operations, compared, checks, rest: trace.length - at };
};

describe("the DSP module against the native core's known answers", () => {
  it("are the answers for the committed module: the fixture names its bytes", () => {
    expect(answers.apiVersion).toBe(AICA_DSP_API_VERSION);
    expect(answers.groups).toEqual(["shifter", "address", "ring", "rules", "mixs"]);
    expect(answers.known).toBeGreaterThan(800);
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(answers.module["aica_dsp_core.wasm"]);
  });

  it("gives every answer the native core gave, call for call", { timeout: 60_000 }, async () => {
    // the answers are those of the module they were written for
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(answers.module["aica_dsp_core.wasm"]);
    const result = await replay(wasm);
    expect(result.differences).toEqual([]);
    // the whole trace, and one check of the state at each known answer
    expect(result.rest).toBe(0);
    expect(result.checks).toBe(answers.known);
    expect(result.compared).toBeGreaterThan(answers.known * 8);
  });
});
