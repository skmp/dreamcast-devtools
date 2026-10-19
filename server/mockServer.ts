import express from "express";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { MOCK_M1_SUPPORT, MOCK_M2_SUPPORT, MOCK_M3_SUPPORT, MockDebugger } from "./mockDebugger";
import { attachMockDebugger } from "./mockWebSocket";

/**
 * The mock debugger with its page: the UI (the Vite dev middleware, or the production
 * build in dist-native/) and the protocol v3 mock on /ws of one port. The protocol itself
 * is server/mockDebugger.ts; this file only hosts it.
 *
 * Options (command line; none is needed):
 *   --start-paused     start in the StartPaused stop instead of running
 *   --force-fallback   behave like an SH4 backend without native breakpoints (notice, capability)
 *   --stale-registers  behave like a backend whose running ticks cannot carry dc.sh4.cpu
 *   --m1               implement what the emulator does in milestone M1, and nothing more
 *   --m2               implement what the emulator does in milestone M2, and nothing more
 *   --m3               implement what the emulator does in milestone M3, and nothing more
 *   --arm7-held        start with the ARM7 held in reset, as behind a reset; the running machine releases it
 *   --testb0           TESTB0 of the AICA's word 0x2804 set (dc.aica.common.TESTB0 1, MDEC_CT in its test mode)
 */

const PORT = Number(process.env.PORT ?? 5173);
const WS_PATH = process.env.DEBUGGER_WS_PATH ?? "/ws";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const FLAGS = new Set(process.argv.slice(2));

/** `ui` of debugger.describe: the version of the bundle this server serves, if it serves one. */
const bundleVersion = async (distDir: string): Promise<string> => {
  try {
    const info = JSON.parse(await readFile(resolve(distDir, "bundle-info.json"), "utf8")) as { version?: unknown };
    return typeof info.version === "string" && info.version ? info.version : "none";
  } catch {
    return "none";
  }
};

const start = async () => {
  const app = express();
  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
  let ui = "none";

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (IS_PRODUCTION) {
    const distDir = resolve(process.cwd(), "dist-native");
    ui = await bundleVersion(distDir);
    app.use(express.static(distDir));
    app.use(async (req, res, next) => {
      if (req.method !== "GET") {
        return next();
      }
      try {
        const template = await readFile(resolve(distDir, "index.html"), "utf8");
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (error) {
        next(error);
      }
    });
  } else {
    vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: "custom",
    });

    app.use(vite.middlewares);

    app.use(async (req, res, next) => {
      try {
        const template = await readFile(resolve(process.cwd(), "index.html"), "utf8");
        const transformed = await vite!.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(transformed);
      } catch (error) {
        vite!.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
  }

  const mock = new MockDebugger({
    ui,
    startPaused: FLAGS.has("--start-paused"),
    forceFallback: FLAGS.has("--force-fallback"),
    sliceContext: !FLAGS.has("--stale-registers"),
    supports: FLAGS.has("--m1") ? MOCK_M1_SUPPORT : FLAGS.has("--m2") ? MOCK_M2_SUPPORT : FLAGS.has("--m3") ? MOCK_M3_SUPPORT : undefined,
    arm7Held: FLAGS.has("--arm7-held"),
    testb0: FLAGS.has("--testb0"),
  });
  const server = createHttpServer(app);
  const endpoint = attachMockDebugger(mock, server, WS_PATH);

  server.listen(PORT, () => {
    mock.start();
    console.log(`Mock debugger server running at http://localhost:${PORT}`);
    console.log(`WebSocket endpoint available at ws://localhost:${PORT}${WS_PATH}`);
  });

  const shutdown = async () => {
    mock.stop();
    endpoint.close();
    if (vite) {
      await vite.close();
    }
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

void start();
