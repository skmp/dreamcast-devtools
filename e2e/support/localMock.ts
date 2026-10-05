import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { MockDebugger } from "../../server/mockDebugger";
import type { MockDebuggerOptions } from "../../server/mockDebugger";
import { attachMockDebugger } from "../../server/mockWebSocket";
import type { MockServer } from "./mockServer";
import { SEEDED_WATCH } from "./mockServer";
import { DIST_DIR } from "./paths";

/**
 * A mock server that runs inside the test's process: the page (dist-native/) and the mock
 * debugger module on /ws of one port, like the server the `mock` fixture spawns. What it adds:
 * the test chooses the options of the mock (`supports`, `protocol`, `startPaused`, ...) and
 * holds the machine itself, so it can do what the emulator's own window does (`setLifetime`).
 */
export interface LocalMock extends MockServer {
  readonly machine: MockDebugger;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

export const startLocalMock = async (options: MockDebuggerOptions & { watches?: string[] } = {}): Promise<LocalMock> => {
  const { watches = [SEEDED_WATCH], ...mockOptions } = options;
  const machine = new MockDebugger({ ui: "e2e", ...mockOptions });
  let log = "";

  const server = createServer((request, response) => {
    void (async () => {
      // the query string is ignored; a path without an extension is the page
      const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
      const relative = extname(path) ? normalize(path) : "index.html";
      const file = join(DIST_DIR, relative);
      if (request.method !== "GET" || !file.startsWith(DIST_DIR + sep)) {
        response.writeHead(405).end();
        return;
      }
      try {
        const body = await readFile(file);
        response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
      } catch {
        response.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
      }
    })();
  });
  const endpoint = attachMockDebugger(machine, server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  machine.start();
  const { port } = server.address() as AddressInfo;

  // The watches every server of the suite starts with belong to the server: they are added by
  // a client that is gone before the page connects.
  if (watches.length > 0) {
    const seeding = machine.connect({
      sendText: (text) => {
        log += `${text.slice(0, 200)}\n`;
      },
      sendBinary: () => undefined,
    });
    seeding.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state.watch", params: { expressions: watches } }));
    seeding.close();
  }

  let stopped = false;
  return {
    machine,
    port,
    baseURL: `http://127.0.0.1:${port}`,
    wsURL: `ws://127.0.0.1:${port}/ws`,
    pid: process.pid,
    output: () => log,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      machine.stop();
      endpoint.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
