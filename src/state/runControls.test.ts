import { describe, expect, it } from "vitest";
import { arm7Held, hotkeyControl, runControlsOff, stepOff, RUN_CONTROL_IDS, RUN_CONTROL_KEYS, RUN_CONTROL_NAMES } from "./runControls";
import type { RunControlsInput } from "./runControls";
import { targetBeforeFirstServer, unlistedTarget } from "./targets";

const sh4 = targetBeforeFirstServer("sh4");
const arm7 = targetBeforeFirstServer("arm7");
const dsp = targetBeforeFirstServer("dsp");

/** A paused session of a server that can do everything, with the SH4 focused. */
const paused = (extra: Partial<RunControlsInput> = {}): RunControlsInput => ({
  connected: true,
  initialized: true,
  execution: { state: "paused", reason: "pause" },
  target: sh4,
  held: false,
  canReset: true,
  ...extra,
});
const running = (extra: Partial<RunControlsInput> = {}): RunControlsInput => paused({ execution: { state: "running" }, ...extra });

const key = (name: string, modifiers: Partial<Record<"shiftKey" | "ctrlKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  key: name,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...modifiers,
});

describe("the controls of the toolbar", () => {
  it("are six, each with a name, and five of them with a key", () => {
    expect(RUN_CONTROL_IDS.map((id) => [id, RUN_CONTROL_NAMES[id], RUN_CONTROL_KEYS[id]])).toEqual([
      ["run", "Run", "F5"],
      ["pause", "Pause", "F6"],
      ["step", "Step Into", "F11"],
      ["stepOver", "Step Over", "F10"],
      ["stepOut", "Step Out", "Shift+F11"],
      ["reset", "Reset", undefined],
    ]);
  });

  it("paused: everything but Pause", () => {
    expect(runControlsOff(paused())).toEqual({
      run: undefined,
      pause: "the target is paused",
      step: undefined,
      stepOver: undefined,
      stepOut: undefined,
      reset: undefined,
    });
  });

  it("running: Pause and Reset, and the steps say why not", () => {
    expect(runControlsOff(running())).toEqual({
      run: "the target is running",
      pause: undefined,
      step: "the target is running",
      stepOver: "the target is running",
      stepOut: "the target is running",
      reset: undefined,
    });
  });

  it.each([
    ["host-stopped", "stopped in the emulator's window"],
    ["guest-exit", "the program has exited"],
    ["no-game", "no game loaded"],
  ])("in the stop of the host %s nothing can be used: the server refuses all of it there", (reason, text) => {
    expect(runControlsOff(paused({ execution: { state: "paused", reason } }))).toEqual({
      run: text,
      pause: text,
      step: text,
      stepOver: text,
      stepOut: text,
      reset: text,
    });
  });

  it("a stop with a reason this build does not know is one of the debugger", () => {
    const off = runControlsOff(paused({ execution: { state: "paused", reason: "cosmic-ray" } }));
    expect([off.run, off.step, off.reset]).toEqual([undefined, undefined, undefined]);
    const none = runControlsOff(paused({ execution: { state: "paused" } }));
    expect([none.run, none.step, none.reset]).toEqual([undefined, undefined, undefined]);
  });

  it("without a connection nothing can be used, whatever the last tick said", () => {
    for (const input of [paused({ connected: false }), running({ connected: false }), paused({ connected: false, execution: undefined, initialized: false })]) {
      expect(Object.values(runControlsOff(input))).toEqual(Array(6).fill("not connected"));
    }
  });

  it("before the first tick nothing can be used", () => {
    expect(Object.values(runControlsOff(paused({ execution: undefined })))).toEqual(Array(6).fill("waiting for the server"));
  });

  it("Run and Pause go by the ticks; the steps and Reset wait for the server to describe itself", () => {
    // a tick can be in front of the answer to debugger.describe: what the server lists is not known yet
    expect(runControlsOff(paused({ initialized: false }))).toEqual({
      run: undefined,
      pause: "the target is paused",
      step: "waiting for the server",
      stepOver: "waiting for the server",
      stepOut: "waiting for the server",
      reset: "waiting for the server",
    });
    expect(runControlsOff(running({ initialized: false }))).toMatchObject({ run: "the target is running", pause: undefined, reset: "waiting for the server" });
  });

  it("a server without the capability has no reset, running or paused", () => {
    expect(runControlsOff(paused({ canReset: false })).reset).toBe("this server cannot reset the machine");
    expect(runControlsOff(running({ canReset: false })).reset).toBe("this server cannot reset the machine");
    // the rest is as it was
    expect(runControlsOff(paused({ canReset: false }))).toMatchObject({ run: undefined, step: undefined, stepOver: undefined, stepOut: undefined });
  });

  it("a target the server cannot step has no steps, and says so before anything else", () => {
    const m1 = { ...arm7, stepping: false };
    for (const input of [paused({ target: m1 }), running({ target: m1 }), paused({ target: m1, held: true }), paused({ target: m1, execution: { state: "paused", reason: "host-stopped" } })]) {
      const off = runControlsOff(input);
      expect([off.step, off.stepOver, off.stepOut]).toEqual(Array(3).fill("this server cannot step the ARM7"));
    }
    // Run, Pause and Reset are not the target's
    expect(runControlsOff(paused({ target: m1 }))).toMatchObject({ run: undefined, pause: "the target is paused", reset: undefined });
  });

  it("a target the server does not list has no steps", () => {
    const off = runControlsOff(paused({ target: unlistedTarget("dsp") }));
    expect([off.step, off.stepOver, off.stepOut]).toEqual(Array(3).fill("this server does not support the DSP target"));
    expect(off.run).toBeUndefined();
    expect(off.pause).toBe("the target is paused");
  });

  it("the DSP is stepped, and never over or out", () => {
    expect(runControlsOff(paused({ target: dsp }))).toMatchObject({
      step: undefined,
      stepOver: "the DSP has no calls to step over or out of",
      stepOut: "the DSP has no calls to step over or out of",
    });
    // also while it runs: it is not for the moment
    expect(runControlsOff(running({ target: dsp }))).toMatchObject({
      step: "the target is running",
      stepOver: "the DSP has no calls to step over or out of",
      stepOut: "the DSP has no calls to step over or out of",
    });
    // a server that cannot step it at all says that
    expect(runControlsOff(paused({ target: { ...dsp, stepping: false } }))).toMatchObject({
      step: "this server cannot step the DSP",
      stepOver: "this server cannot step the DSP",
      stepOut: "this server cannot step the DSP",
    });
    expect(runControlsOff(paused({ target: dsp, connected: false })).stepOver).toBe("not connected");
  });

  it("an ARM7 that is held in reset has no steps while it is the focused target; Run, Pause and Reset are as they were", () => {
    expect(runControlsOff(paused({ target: arm7, held: true }))).toEqual({
      run: undefined,
      pause: "the target is paused",
      step: "the ARM7 is held in reset",
      stepOver: "the ARM7 is held in reset",
      stepOut: "the ARM7 is held in reset",
      reset: undefined,
    });
    // while the target runs that is the reason: nothing steps then
    expect(runControlsOff(running({ target: arm7, held: true })).step).toBe("the target is running");
  });

  it("the label in a reason is the server's", () => {
    expect(stepOff(paused({ target: { ...arm7, label: "Sound CPU" }, held: true }))).toBe("the Sound CPU is held in reset");
    expect(stepOff(paused({ target: { ...arm7, label: "Sound CPU", stepping: false } }))).toBe("this server cannot step the Sound CPU");
  });
});

describe("the step buttons of a view", () => {
  it("go by the same rules as the steps of the toolbar", () => {
    for (const input of [
      paused(),
      running(),
      paused({ connected: false }),
      paused({ initialized: false }),
      paused({ execution: undefined }),
      paused({ target: arm7, held: true }),
      paused({ execution: { state: "paused", reason: "guest-exit" } }),
      paused({ target: { ...arm7, stepping: false } }),
      paused({ target: unlistedTarget("arm7") }),
    ]) {
      expect(stepOff(input)).toBe(runControlsOff(input).step);
    }
  });
});

describe("whether the ARM7 is held in reset", () => {
  const registers = (value: string | undefined) => ({
    "dc.aica.arm7": [{ name: "PC", value: "0x00000000", width: 32 }, ...(value === undefined ? [] : [{ name: "ENABLED", value, width: 1 }])],
  });

  it("is what ENABLED of its node says", () => {
    expect(arm7Held(registers("0x0"), arm7)).toBe(true);
    expect(arm7Held(registers("0"), arm7)).toBe(true);
    expect(arm7Held(registers("0x00000000"), arm7)).toBe(true);
    expect(arm7Held(registers("0x1"), arm7)).toBe(false);
    expect(arm7Held(registers("1"), arm7)).toBe(false);
  });

  it("is not assumed: no value, and a value that is no number, hold nothing", () => {
    expect(arm7Held(registers(undefined), arm7)).toBe(false);
    expect(arm7Held(registers("n/a"), arm7)).toBe(false);
    expect(arm7Held({}, arm7)).toBe(false);
  });

  it("is read from the node the server gives the ARM7", () => {
    const elsewhere = { ...arm7, pcPath: "board.sound.cpu" };
    expect(arm7Held(registers("0x0"), elsewhere)).toBe(false);
    expect(arm7Held({ "board.sound.cpu": [{ name: "ENABLED", value: "0x0", width: 1 }] }, elsewhere)).toBe(true);
  });
});

describe("the keys", () => {
  it("F5 runs, F6 pauses, F10 steps over, F11 steps into, Shift+F11 steps out", () => {
    expect(hotkeyControl(key("F5"))).toBe("run");
    expect(hotkeyControl(key("F6"))).toBe("pause");
    expect(hotkeyControl(key("F10"))).toBe("stepOver");
    expect(hotkeyControl(key("F11"))).toBe("step");
    expect(hotkeyControl(key("F11", { shiftKey: true }))).toBe("stepOut");
  });

  it("F8 and Shift+F8 do what F11 and Shift+F11 do", () => {
    expect(hotkeyControl(key("F8"))).toBe("step");
    expect(hotkeyControl(key("F8", { shiftKey: true }))).toBe("stepOut");
  });

  it("no key resets", () => {
    for (const name of ["F1", "F2", "F3", "F4", "F7", "F9", "F12", "r", "R", "Enter", " ", "Escape"]) {
      expect(hotkeyControl(key(name)), name).toBeUndefined();
      expect(hotkeyControl(key(name, { shiftKey: true })), `Shift+${name}`).toBeUndefined();
    }
  });

  it("a key with Ctrl, Alt or Meta is not one of them, and neither is Shift with a key that has no use for it", () => {
    for (const name of ["F5", "F6", "F8", "F10", "F11"]) {
      for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
        expect(hotkeyControl(key(name, { [modifier]: true })), `${modifier} ${name}`).toBeUndefined();
        expect(hotkeyControl(key(name, { [modifier]: true, shiftKey: true })), `${modifier} Shift ${name}`).toBeUndefined();
      }
    }
    for (const name of ["F5", "F6", "F10"]) {
      expect(hotkeyControl(key(name, { shiftKey: true })), `Shift+${name}`).toBeUndefined();
    }
  });
});
