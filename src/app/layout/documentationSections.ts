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
      "nullDC DevTools is the web debugger UI for nullDC 3.0.0, the Dreamcast emulator.",
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
          "The status bar of a workspace shows the connection state and the endpoint. Click the endpoint to pick another one, or to enter any `ws://` or `wss://` URL by hand; that URL is remembered and used first from then on.",
          "When the connection is lost the UI says so, shows no data as if it were live, and tries again after 1, 2, 5 and then every 10 seconds. `Stop` ends that; `Connect` and `Retry now` try at once. Every new connection is described again.",
          "Next to the run controls the UI shows whether the target runs and why it is stopped. What a server cannot do (`targets` and `capabilities` of `debugger.describe`) is said in the panel concerned, in place of its controls.",
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
          "The `+` button in a panel group's header adds another panel to that group.",
          "Device Tree shows the tree returned by `debugger.describe` with the register values of the latest tick. Its search box narrows the tree word by word (node, then register) and shows at most 200 matching rows. Watches lists the watched expressions, and Events: Log shows the event log of the latest tick.",
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
