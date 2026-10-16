// In-app documentation, shared by the /docs page and the Documentation panel.
// Keep it in sync with README.md: every script name and statement here must be true.

export type DocumentationSubsection = {
  id: string;
  title: string;
  level: 2 | 3;
  items: string[];
};

export type DocumentationSection = {
  id: string;
  title: string;
  level: 1;
  content: string[];
  subsections?: DocumentationSubsection[];
};

export const documentationSections: DocumentationSection[] = [
  {
    id: "overview",
    title: "Overview",
    level: 1,
    content: [
      "Dreamcast DevTools is the web debugger UI for nullDC 3.0.0, the Dreamcast emulator.",
      "It talks JSON-RPC 2.0 to the emulator, or to the mock server that ships in the DevTools repository.",
    ],
  },
  {
    id: "getting-started",
    title: "Getting Started",
    level: 1,
    content: [
      "The DevTools repository contains a mock debugger server, so the UI can be explored without an emulator. Node.js 22.13 or newer is required.",
    ],
    subsections: [
      {
        id: "launching-ui",
        title: "Launching the UI",
        level: 2,
        items: [
          "Run `npm ci` once, then `npm run dev`. One process serves the UI with hot reload and the mock debugger at http://localhost:5173, and restarts when the server sources change.",
          "`npm run mock:serve` runs the same server without the restart-on-change watcher. Set `PORT` to use another port.",
          "`npm run mock:prod` builds the UI into `dist-native/` and serves that build from the mock server.",
          "`npm run build:native` and `npm run build:wasm` build the WebSocket variant (`dist-native/`) and the BroadcastChannel variant (`dist-wasm/`).",
          "`npm run check` runs lint, type-check, the unit tests, the contract runner against the mock and the native build.",
          "`npm run contract` holds a debugger server to the protocol: the mock without arguments, an emulator with `--url ws://host:port/ws`.",
          "`npm run test:e2e` runs the browser tests: headless Chromium (Playwright) against the built UI and the mock server.",
        ],
      },
      {
        id: "connecting-emulator",
        title: "Connecting to the Emulator",
        level: 2,
        items: [
          "Native builds open one WebSocket. Its endpoint is the first of: `?ws=ws://host:port/ws` in the address bar (in front of the `#`), the last endpoint entered by hand, `VITE_WS_URL` of the build, and `/ws` on the host that served the page. Served by the emulator, there is nothing to configure.",
          "WASM builds use BroadcastChannel: the UI listens for emulator announcements and connects to the announced instance; with several it shows a connection picker.",
          "The status bar of a workspace shows the connection state and the endpoint. The endpoint is a button: click it, or press Enter on it, to pick another one, or to enter any `ws://` or `wss://` URL by hand; that URL is remembered and used first from then on.",
          "When the connection is lost the UI says so and tries the same endpoint again after 1, 2, 5 and then every 10 seconds. `Stop` ends that; `Connect` and `Retry now` try at once. Every new connection is described again.",
          "Without a connection the panels keep their boxes, their toolbars and the keyboard focus, and say `Not connected` where their data was. What is typed into a box meanwhile stays there, to be sent when the connection is back.",
          "When the emulator could not describe itself (it was busy, or did not answer) the UI says so and asks again on the same connection after 1, 2, 5 and then every 10 seconds; `Retry now` asks at once.",
          "Next to the run controls the UI shows whether the target runs and why it is stopped (under the toolbar in a window narrower than 1440 px). What a server cannot do (`targets` and `capabilities` of `debugger.describe`) is said in the panel concerned, in place of its controls, and in the tooltip of a run control that is off.",
        ],
      },
    ],
  },
  {
    id: "workspaces-and-tools",
    title: "Workspaces & Tools",
    level: 1,
    content: [
      "The home page lists four debugger workspaces and four standalone tools.",
    ],
    subsections: [
      {
        id: "workspaces",
        title: "Workspaces",
        level: 2,
        items: [
          "SH4 Debugger, ARM7 Debugger, Audio Debugger and Mixed Mode Debugger are dockable panel layouts.",
          "Each workspace stores its panel layout in the browser's localStorage. `Reset layout` in the top bar restores the default.",
          "The default is made for the window: side by side from 1600 px on; in a narrower window with both side docks open, the first view over the whole width and the others as tabs below it.",
          "The `+` button in a panel group's header adds another panel to that group.",
          "Device Tree shows the tree returned by `debugger.describe` with the register values of the latest tick. Its search box narrows the tree word by word (node, then register) and shows at most 200 matching rows. Watches lists the watched expressions, and Events: Log shows the event log of the latest tick.",
          "A memory view is moved through its addresses by the wheel, by the arrow keys in its hex column and by its address box; its listing is cut at the edge of the panel and is not scrolled. An address typed into the box is shown with ten rows above it, or with as many as a small panel has room for. At the end of an address space the view stands so that the last row is the last whole row of the panel, however few rows the panel shows. A panel made smaller takes the place of the keyboard up with its edge, and puts away an editor whose row it no longer shows.",
          "SH4: Registers, ARM7: Registers and the register panels of the SH4's on-chip modules (BSC, CCN, CPG, DMAC, INTC, RTC, SCI, SCIF, TMU, UBC) are one table each: name, value and width of the registers of the device tree node that offers the panel, and a `+` per row that adds the register to the watches. The device tree opens a panel with the button on its node; the panels of the two processors are a tab behind the breakpoints in their workspace.",
          "While the target is paused, a double click on a value writes a register (in a register panel and in Watches): type `0x` hex or decimal, Enter sends, Escape closes. A double click on a byte in the hex column of a memory view writes memory from that byte on: type the bytes in hex (`DE AD BE EF`), and the whole run is one write. With the keyboard, Tab stops on such a value, and in a memory view on a byte of the hex column that the arrow keys move; Enter, the space bar or F2 open the editor there. The expression of a watch is renamed the same way, by a double click or by Enter, the space bar or F2 on it, also while the target is paused only. Only registers the server can write have an editor, and what the server refuses is shown while the editor stays open. After a write the disassembly and memory views read again where they are; a written program counter moves the disassembly to it.",
        ],
      },
      {
        id: "run-control",
        title: "Run Control",
        level: 2,
        items: [
          "The toolbar of a workspace has Run, Pause, Step Into, Step Over, Step Out and Reset. Run and Pause are the machine's: every target runs and stops with it. (`Run to next breakpoint` is gone: it did what Run does.)",
          "The three steps act on the focused target, which the toolbar names in front of them. It is the target of the panel that last had the focus, by a click in the panel or on its tab or by the keyboard: a disassembly, memory, breakpoints, callstack or registers panel of the SH4, the ARM7 or the DSP. Until one of them had it, it is the target the workspace is for: the SH4 in the SH4 Debugger and the Mixed Mode Debugger, the ARM7 in the ARM7 Debugger, the DSP in the Audio Debugger. Every disassembly view keeps step buttons of its own, for its own target.",
          "Keys, on a workspace page wherever the focus is: F5 run, F6 pause, F10 step over, F11 step into, Shift+F11 step out; F8 and Shift+F8 do what F11 and Shift+F11 do. They are left alone while the focus is in a code editor (SH4 Simulator, DSP Playground; its Find box is a part of it) and while a dialog is open (one is closed from the Escape that closes it on, and while it fades out after a click on its button or beside it). A key that is held down is used once. F5 does not load the page again here; Ctrl+R and Ctrl+F5 do.",
          "A control that cannot be used is off, and its tooltip says why: the target is running or is paused already, the machine is stopped in the emulator's own window, the server cannot step that target or cannot reset, the DSP has no calls to step over or out of, or the ARM7 is held in reset. A key whose control is off does nothing.",
          "The ARM7 is held in reset while `ENABLED` of `dc.aica.arm7` reads 0: after a reset, and until the program releases it. It cannot be stepped then. The step buttons of the toolbar are off while it is the focused target, and so are those of its disassembly view; Run, and the steps of the SH4, are not.",
          "Reset resets the machine at once, without a question. A paused machine stays paused, in a new stop, and the views go where it is; a running one runs on, and the disassembly and memory views read again where they are. Breakpoints and watches are kept.",
          "What a write can do: a program counter, or bytes of code, written so that the guest reaches what is no instruction ends the emulator in its default build, as it does for a guest that gets there by itself. The emulator checks one thing about a program counter: one of the SH4 with bit 0 set is refused, because nothing executes at an odd address (the ARM7's is stored aligned). Whether there is code where it points is yours to know.",
        ],
      },
      {
        id: "breakpoints",
        title: "Breakpoints",
        level: 2,
        items: [
          "In a disassembly view, click the gutter to add or remove a breakpoint at that address.",
          "Ctrl, Cmd or Shift + click an existing breakpoint to enable or disable it. A filled red circle is enabled, an outlined one is disabled.",
          "Events: Breakpoints takes the event names of the device tree, such as `dc.holly.core.vblank`; SH4: Breakpoints and ARM7: Breakpoints take hex addresses such as `0x8C0000A0`, DSP: Breakpoints a step in decimal (or hex after `0x`).",
          "Breakpoints live on the server, and so do the mute and solo states of their categories. Every tick carries all of it, so all connected clients show the same.",
        ],
      },
      {
        id: "tools",
        title: "Tools",
        level: 2,
        items: [
          "SH4 Simulator: type SH4 assembly and inspect the simulated pipeline timing. It runs in the browser and needs no emulator connection.",
          "DSP Playground: write, compile, step and listen to AICA DSP programs on a DSP simulator compiled to WebAssembly. It needs no emulator connection.",
          "CORE Log Analyzer: load a refsw2 log file and click a pixel to see the ISP/TSP events and tile operations logged for it.",
          "TA Log Analyzer: placeholder, not implemented yet.",
          "Everything, including the Monaco editor of the SH4 Simulator and the DSP Playground, is part of the build: the UI requests nothing from any origin other than the one that served it and works without internet access.",
        ],
      },
    ],
  },
  {
    id: "protocol",
    title: "Protocol",
    level: 1,
    content: [
      "Protocol version 3: JSON-RPC 2.0 over a single connection, one message per frame. There is no subscribe/unsubscribe.",
      "The first request is `debugger.describe`; it returns the emulator name, version and build, the protocol version, the capabilities and targets of the server, and the device tree. The About dialog shows name, version and build next to the DevTools version.",
      "The server pushes `event.tick` notifications: after `debugger.describe`, after every change, and every 200 ms while the target runs. A tick carries the execution state (with a stop counter and the reason of a stop), breakpoints, event log, watches, callstacks and breakpoint categories completely, and registers per device-tree node: all nodes when paused, the program counters and the time in most running ticks.",
      "Memory, disassembly and callstacks are fetched on demand with `state.getMemorySlice`, `state.getDisassembly` and `state.getCallstack`. The zod schemas in `src/lib/debuggerSchema.ts` are the reference for every method, error code and bound.",
    ],
  },
];
