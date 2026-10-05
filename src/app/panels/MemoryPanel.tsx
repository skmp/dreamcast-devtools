import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Panel } from "../layout/Panel";
import { DebuggerErrorCode, type MemorySlice } from "../../lib/debuggerSchema";
import { JsonRpcException } from "../../lib/jsonRpc";
import { useSessionStore } from "../../state/sessionStore";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { useTarget } from "../../state/debuggerSelectors";
import { formatAddress, parseAddress } from "../../state/targets";
import { MemoryView, type MemoryViewConfig, type MemoryViewCallbacks } from "../components/MemoryView";
import { PanelNotice, PanelPlaceholder } from "../components/PanelNotice";

const BYTES_PER_ROW = 16;
const VISIBLE_ROWS = 60;

interface MemoryPanelProps {
  target: "sh4" | "arm7";
}

const MemoryPanel = ({ target }: MemoryPanelProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  // default address, last address and address format: what debugger.describe said
  const info = useTarget(target);
  const client = useSessionStore((state) => state.client);
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const epoch = useDebuggerDataStore((state) => state.epoch);
  const refresh = useDebuggerDataStore((state) => state.refresh);

  // The view is mounted once the server has been described, because where it opens is the
  // server's to say. After that it stays, and keeps its place when the connection is lost.
  // (Once its first tick is in, so that a stop the server is already in is not a new one.)
  const hasTick = useDebuggerDataStore((state) => state.ticks > 0);
  const [described, setDescribed] = useState(false);
  if (initialized && hasTick && !described) {
    setDescribed(true);
  }

  const length = VISIBLE_ROWS * BYTES_PER_ROW;

  // Build configuration
  const config: MemoryViewConfig = useMemo(
    () => ({
      formatAddress: (value: number) => formatAddress(info, value),
      parseAddress: (input: string) => parseAddress(info, input),
      maxAddress: Math.max(0, info.addressMax - (length - 1)),
      addressMax: info.addressMax,
      length,
    }),
    [info, length],
  );

  // Build callbacks
  const callbacks: MemoryViewCallbacks = useMemo(
    () => ({
      onFetchMemory: async (address: number, length: number): Promise<MemorySlice> => {
        if (!client) {
          throw new Error("Client not connected");
        }
        try {
          return await client.fetchMemorySlice({ target, address, length });
        } catch (error) {
          if (error instanceof JsonRpcException && error.code === DebuggerErrorCode.NOT_READABLE) {
            // Nothing in the range is readable. That is what the view shows, and it stays a
            // view: one that printed only the error could not be scrolled back out of the range.
            return { baseAddress: address, data: new Array<number>(length).fill(0), validity: "ok", unreadable: [[0, length]] };
          }
          throw error;
        }
      },
      onAddressChange: (address: number) => {
        setSearchParams({ address: formatAddress(info, address) });
      },
    }),
    [client, target, info, setSearchParams],
  );

  // Get initial URL address
  const initialUrlAddress = useMemo(() => {
    const addressParam = searchParams.get("address");
    if (addressParam) {
      const parsed = parseAddress(info, addressParam);
      if (parsed !== undefined) {
        return { address: parsed, fromUrl: true };
      }
    }
    return undefined;
  }, [searchParams, info]);

  if (initialized && (!info.supported || !info.memory || info.defaultMemoryAddress === undefined)) {
    return (
      <Panel>
        <PanelNotice>
          {info.supported
            ? `This server cannot read the memory of the ${info.label}.`
            : `This server does not support the ${info.label} target.`}
        </PanelNotice>
      </Panel>
    );
  }
  if (!described) {
    return (
      <Panel>
        <PanelPlaceholder>No Data</PanelPlaceholder>
      </Panel>
    );
  }

  return (
    <Panel>
      <MemoryView
        config={config}
        callbacks={callbacks}
        defaultAddress={info.defaultMemoryAddress ?? 0}
        initialized={initialized}
        initialUrlAddress={initialUrlAddress}
        // a stop the client has not acted on yet, or a game that was just loaded: the bytes on screen are read again
        refreshSignal={`${epoch}:${refresh}`}
      />
    </Panel>
  );
};

export const Sh4MemoryPanel = () => <MemoryPanel target="sh4" />;

export const Arm7MemoryPanel = () => <MemoryPanel target="arm7" />;
