import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { REPO_ROOT } from "./paths";

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

/**
 * Starts the mock debugger server in production mode (it serves dist-native/ and
 * the WebSocket on one port). `port` restarts a server on a port a previous
 * instance used; without it a free port is picked.
 *
 * The server runs as a single `node --import tsx` process so that it can be
 * stopped by pid without leaving a wrapper or a child behind.
 */
export const startMockServer = async (options: { port?: number } = {}): Promise<MockServer> => {
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

  try {
    await waitForHealth(baseURL, child, output);
  } catch (error) {
    await stop();
    throw error;
  }

  return { port, baseURL, wsURL: `ws://127.0.0.1:${port}/ws`, pid, output, stop };
};
