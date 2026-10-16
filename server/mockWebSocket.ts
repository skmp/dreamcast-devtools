import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { PROTOCOL_BOUNDS } from "../src/lib/debuggerSchema";
import type { MockDebugger } from "./mockDebugger";

/** A further upgrade gets 503. */
export const MOCK_MAX_CLIENTS = 16;

export interface MockWebSocketEndpoint {
  /** Closes every connection of the endpoint. The HTTP server is the caller's. */
  close(): void;
}

/**
 * Serves the mock debugger on `path` of an HTTP server: one JSON-RPC message per text frame,
 * inbound messages of at most 1 MiB (the connection is closed above that), 16 clients.
 */
export const attachMockDebugger = (mock: MockDebugger, server: HttpServer, path = "/ws"): MockWebSocketEndpoint => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: PROTOCOL_BOUNDS.inboundMessageBytes });

  server.on("upgrade", (request, socket, head) => {
    // the query string is ignored
    const requested = (request.url ?? "").split("?")[0];
    if (requested !== path) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (wss.clients.size >= MOCK_MAX_CLIENTS) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const client = mock.connect({
        sendText: (text) => ws.send(text),
        sendBinary: (frame) => ws.send(frame, { binary: true }),
        queuedBytes: () => ws.bufferedAmount,
      });
      ws.on("message", (data, isBinary) => {
        // the protocol has no binary frames from the client
        if (!isBinary) {
          client.receive(data.toString());
        }
      });
      ws.on("close", () => client.close());
      ws.on("error", () => client.close());
    });
  });

  return {
    close() {
      for (const ws of wss.clients) {
        ws.terminate();
      }
      wss.close();
    },
  };
};

export interface MockListener {
  readonly port: number;
  /** ws://127.0.0.1:<port>/ws */
  readonly url: string;
  /** Stops the mock's timers, closes every connection and the listening socket. */
  close(): Promise<void>;
}

/**
 * The mock debugger on a WebSocket of its own, without a page: what the contract runner and
 * the tests connect to. `port` 0 asks the OS for a free port.
 */
export const listenMockDebugger = async (
  mock: MockDebugger,
  options: { port?: number; host?: string; path?: string } = {},
): Promise<MockListener> => {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/ws";
  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain" }).end("the mock debugger serves only its WebSocket here\n");
  });
  const endpoint = attachMockDebugger(mock, server, path);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  mock.start();
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `ws://${host}:${port}${path}`,
    async close() {
      mock.stop();
      endpoint.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
