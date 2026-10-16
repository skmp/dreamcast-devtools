/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** `native` (WebSocket) or `wasm` (BroadcastChannel) */
  readonly VITE_TRANSPORT_MODE?: string;
  /** the WebSocket endpoint of a native build that is not served by the emulator, e.g. ws://localhost:55543/ws */
  readonly VITE_WS_URL?: string;
}
