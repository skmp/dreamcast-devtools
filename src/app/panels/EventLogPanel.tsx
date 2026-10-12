import { useMemo } from "react";
import { Panel } from "../layout/Panel";
import { Box, List, ListItem, Typography } from "@mui/material";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { NoData } from "../components/PanelNotice";

const severityColor: Record<string, string> = {
  trace: "text.disabled",
  info: "text.primary",
  warn: "warning.main",
  error: "error.main",
};

export const EventLogPanel = () => {
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const entries = useDebuggerDataStore((state) => state.eventLog);
  const rendered = useMemo(() => (Array.isArray(entries) ? entries.slice().reverse() : []), [entries]);

  return (
    <Panel>
      {!initialized ? (
        <NoData />
      ) : rendered.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No runtime events yet.
        </Typography>
      ) : (
        <List dense disablePadding sx={{ maxHeight: "100%", fontFamily: "monospace" }}>
          {rendered.map((entry) => {
            const timestamp = new Date(entry.timestamp).toLocaleTimeString(undefined, {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              fractionalSecondDigits: 3
            });
            const tag = entry.subsystem.toUpperCase().padEnd(6, " ");
            // which event this is and when, in SH4 cycles, it was raised; an entry without
            // `metadata` is a row without the two
            const event = typeof entry.metadata?.event === "string" ? entry.metadata.event : undefined;
            const cycles = typeof entry.metadata?.cycles === "string" ? entry.metadata.cycles : undefined;

            return (
              <ListItem key={entry.eventId} sx={{ py: 0.25, px: 1 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                    fontSize: "0.75rem",
                    color: severityColor[entry.severity] ?? "text.primary",
                    whiteSpace: "pre",
                  }}
                >
                  {timestamp}{" "}
                  <Box
                    component="span"
                    sx={{
                      display: "inline-block",
                      backgroundColor: "action.selected",
                      borderRadius: 1,
                      px: 0.75,
                      py: 0.25,
                      textAlign: "center",
                      minWidth: "3.5rem",
                    }}
                  >
                    {tag.trim()}
                  </Box>{" "}
                  {cycles !== undefined && (
                    <>
                      <Box component="span" title="SH4 cycles when the event was raised" sx={{ color: "text.secondary" }}>
                        @{cycles}
                      </Box>{" "}
                    </>
                  )}
                  {event !== undefined && (
                    <>
                      <Box component="span" title="Event (the name an event breakpoint takes)" sx={{ color: "text.secondary" }}>
                        {event}
                      </Box>{" "}
                    </>
                  )}
                  {entry.message}
                </Typography>
              </ListItem>
            );
          })}
        </List>
      )}
    </Panel>
  );
};

