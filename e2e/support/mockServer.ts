import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";
import { REPO_ROOT } from "./paths";

/**
 * The watch every server of the suite starts with. A debugger server has no watches of its
 * own, and they belong to the server, not to a client: this one is added by a client that
 * is gone before the page connects, so the page finds it in its first tick.
 */
export const SEEDED_WATCH = "dc.sh4.cpu.pc";

export interface MockServer {
  readonly port: number;
  /** http://127.0.0.1:<port> */
  readonly baseURL: string;
  /** ws://127.0.0.1:<port>/ws */
  readonly wsURL: string;
  readonly pid: number;
  /** stdout + stderr of the server so far. */
  readonly output: () => string;
  /** Stops the process (by pid) and waits until it is gone. Idempotent. */
  readonly stop: (signal?: NodeJS.Signals) => Promise<void>;
}

/** Asks the kernel for a free TCP port on the loopback interface. */
export const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not determine a free port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });

const waitForExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });

const waitForHealth = async (baseURL: string, child: ChildProcess, output: () => string) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`mock server exited during start-up:\n${output()}`);
    }
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`mock server did not answer /health within 30 s:\n${output()}`);
};

/** Adds watches the way any client does: state.watch on a WebSocket of its own. */
const addWatches = (wsURL: string, expressions: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(wsURL);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("the mock server did not answer state.watch within 10 s"));
    }, 10_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("open", () => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state.watch", params: { expressions } }));
    });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        id?: number;
        result?: { error?: { message: string } };
        error?: { message: string };
      };
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timer);
      socket.close();
      const failure = message.error ?? message.result?.error;
      if (failure) {
        reject(new Error(`state.watch: ${failure.message}`));
      } else {
        resolve();
      }
    });
  });

/** One request to the server from a client of its own, as another debugger window would send it. */
export const requestAsAnotherClient = (wsURL: string, method: string, params: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(wsURL);
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: unknown };
      if (message.id === 1) {
        socket.close();
        resolve(message.result);
      }
    });
  });

/**
 * Starts the mock debugger server in production mode (it serves dist-native/ and
 * the WebSocket on one port). `port` restarts a server on a port a previous
 * instance used; without it a free port is picked. Before the function returns the
 * server is given the watches of `watches` (default: SEEDED_WATCH).
 *
 * The server runs as a single `node --import tsx` process so that it can be
 * stopped by pid without leaving a wrapper or a child behind.
 */
export const startMockServer = async (options: { port?: number; watches?: string[] } = {}): Promise<MockServer> => {
  const port = options.port ?? (await findFreePort());
  const baseURL = `http://127.0.0.1:${port}`;
  let log = "";

  const child = spawn(process.execPath, ["--import", "tsx", "server/mockServer.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      TSX_TSCONFIG_PATH: "tsconfig.server.json",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });

  const output = () => log;
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("failed to spawn the mock server");
  }

  const stop = async (signal: NodeJS.Signals = "SIGKILL") => {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(pid, signal);
    }
    await waitForExit(child);
  };

  const wsURL = `ws://127.0.0.1:${port}/ws`;
  try {
    await waitForHealth(baseURL, child, output);
    const watches = options.watches ?? [SEEDED_WATCH];
    if (watches.length > 0) {
      await addWatches(wsURL, watches);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return { port, baseURL, wsURL, pid, output, stop };
};
