import type { DebuggerClientConfig } from "./services/debuggerClient";

type TransportMode = DebuggerClientConfig["mode"];

type TransportConfig = {
  mode: TransportMode;
  websocketPath: string;
  clientName: string;
  clientVersion: string;
};

const TRANSPORT_MODE = (import.meta.env.VITE_TRANSPORT_MODE ?? "native") as TransportMode;

export const appConfig: TransportConfig = {
  mode: TRANSPORT_MODE,
  websocketPath: import.meta.env.VITE_WS_PATH ?? "/ws",
  clientName: "Dreamcast DevTools",
  clientVersion: "0.1.0",
};
