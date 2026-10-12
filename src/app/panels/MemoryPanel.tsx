import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Panel } from "../layout/Panel";
import { CAPABILITIES, DebuggerErrorCode, type MemorySlice } from "../../lib/debuggerSchema";
import { JsonRpcException } from "../../lib/jsonRpc";
import { useSessionStore } from "../../state/sessionStore";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { useCapability, useNoDataText, useRunState, useTarget } from "../../state/debuggerSelectors";
import { formatAddress, parseAddress } from "../../state/targets";
import { BYTES_PER_ROW, memoryWrite } from "../components/memoryEdit";
import { MemoryView, type MemoryViewConfig, type MemoryViewCallbacks } from "../components/MemoryView";
import { PanelNotice } from "../components/PanelNotice";

const VISIBLE_ROWS = 60;
// what the bytes say of editing when the pointer rests on them: how to, or why not
const EDIT_HINT = "Double-click a byte to write memory from there";
const RUNNING_HINT = "Read-only while the target runs: pause it to write memory";
const NO_WRITES_HINT = "Read-only: this server cannot write memory";

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
  const reread = useDebuggerDataStore((state) => state.reread);
  const writeMemory = useDebuggerDataStore((state) => state.writeMemory);
  const showError = useDebuggerDataStore((state) => state.showError);
  // state.writeMemory is refused by a server without memory writes (-32004): the view then has
  // no editor. Editing is offered while the target is paused.
  const memoryWriteCapability = useCapability(CAPABILITIES.MEMORY_WRITE);
  const paused = useRunState() === "paused";

  // The view is mounted once a server that reads this memory has been described, because
  // where it opens is that server's to say. After that it stays, and keeps its place when the
  // connection is lost. (Once its first tick is in, so that a stop the server is already in
  // is not a new one.)
  //
  // A server that has a notice to show instead (no such target, or no memory) has said
  // nothing about where a view opens. The notice takes the view away and stays while the
  // connection of that server is away; the next view waits for a server that reads this
  // memory, as the first one did.
  const hasTick = useDebuggerDataStore((state) => state.ticks > 0);
  const readable = info.supported && info.memory && info.defaultMemoryAddress !== undefined;
  const noDataText = useNoDataText();
  const [described, setDescribed] = useState(false);
  if (!readable && described) {
    setDescribed(false);
  } else if (initialized && hasTick && readable && !described) {
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
      // A run of bytes typed in one go is one request. What cannot be one is said here and not
      // sent; what the server refuses is said by the store. Either way the editor stays open.
      onWriteMemory: async (address: number, text: string): Promise<void> => {
        const request = memoryWrite({ addressMax: info.addressMax, formatAddress: (value) => formatAddress(info, value) }, address, text);
        if (!request.ok) {
          showError(request.reason);
          throw new Error(request.reason);
        }
        await writeMemory(target, request.address, request.data);
      },
    }),
    [client, target, info, setSearchParams, writeMemory, showError],
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

  // said for as long as that server is the one of this page, connected or not
  if (!readable) {
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
  // Until a server has said where the view opens, the panel shows the frame of one, with a
  // toolbar that cannot be used yet. The view that has a place is another one.
  if (!described) {
    return (
      <Panel>
        <MemoryView key="unplaced" unplaced config={config} callbacks={callbacks} defaultAddress={0} initialized={false} noDataText={noDataText} />
      </Panel>
    );
  }

  return (
    <Panel>
      <MemoryView
        key="placed"
        config={config}
        callbacks={callbacks}
        defaultAddress={info.defaultMemoryAddress ?? 0}
        initialized={initialized}
        initialUrlAddress={initialUrlAddress}
        // A stop the client has not acted on yet, a game that was just loaded, a program counter
        // that was written, or a write of this client that the server accepted: the bytes on
        // screen are read again, where the view is.
        refreshSignal={`${epoch}:${refresh}:${reread}`}
        editable={memoryWriteCapability && paused}
        editHint={memoryWriteCapability ? (paused ? EDIT_HINT : RUNNING_HINT) : NO_WRITES_HINT}
        noDataText={noDataText}
      />
    </Panel>
  );
};

export const Sh4MemoryPanel = () => <MemoryPanel target="sh4" />;

export const Arm7MemoryPanel = () => <MemoryPanel target="arm7" />;
