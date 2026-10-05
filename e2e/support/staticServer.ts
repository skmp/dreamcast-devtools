import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFreePort } from "./mockServer";
import { DIST_DIR } from "./paths";

export interface StaticServer {
  /** URL of the UI: http://127.0.0.1:<port>/<mount>/ */
  readonly url: string;
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

/**
 * Serves dist-native/ with `python3 -m http.server`, the way a plain file server (and the
 * emulator) does: files only, no SPA fallback, no WebSocket. The build is mounted under a
 * sub-path, so anything in it that uses an absolute URL breaks.
 */
export const startStaticServer = async (mount = "ui"): Promise<StaticServer> => {
  const root = mkdtempSync(join(tmpdir(), "nulldc-devtools-static-"));
  symlinkSync(DIST_DIR, join(root, mount), "dir");
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  let log = "";

  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
  const pid = child.pid;

  const stop = async () => {
    if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      process.kill(pid, "SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  };

  const ready = (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`python3 -m http.server exited:\n${log}`);
      }
      try {
        if ((await fetch(`${origin}/${mount}/index.html`)).ok) {
          return;
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`python3 -m http.server did not start:\n${log}`);
  })();

  try {
    await Promise.race([ready, spawnError]);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url: `${origin}/${mount}/`, origin, stop };
};
