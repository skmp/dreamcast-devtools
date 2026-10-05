import { useState } from "react";
import { Button, Typography, type ButtonProps } from "@mui/material";

/**
 * Reloads the document, which is how code that could not be downloaded is requested
 * again (see lazyImport). The server is asked for the page first: while it is down, a
 * reload would replace the application with the error page of the browser.
 */
export const ReloadPageButton = (props: Omit<ButtonProps, "onClick" | "disabled" | "children">) => {
  const [state, setState] = useState<"idle" | "asking" | "no-answer">("idle");

  const reload = async () => {
    setState("asking");
    try {
      const response = await fetch(window.location.href.replace(/#.*$/, ""), {
        cache: "no-store",
        // an emulator that is stopped in a native debugger accepts the connection and stays silent
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // no answer
    }
    setState("no-answer");
  };

  return (
    <>
      <Button {...props} disabled={state === "asking"} onClick={() => void reload()}>
        Reload page
      </Button>
      {state === "no-answer" && (
        <Typography variant="body2" role="status">
          The server does not answer, so the page was not reloaded.
        </Typography>
      )}
    </>
  );
};
