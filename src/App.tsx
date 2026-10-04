import { AppLayout } from "./app/layout/AppLayout";
import { HomePage } from "./app/layout/HomePage";
import { DocsPage } from "./app/layout/DocsPage";
import { Sh4SimPage } from "./app/layout/Sh4SimPage";
import { Clx2TaLogAnalyzerPage } from "./app/layout/Clx2TaLogAnalyzerPage";
import { Clx2CoreLogAnalyzerPage } from "./app/layout/Clx2CoreLogAnalyzerPage";
import { DspPlaygroundPage } from "./app/layout/DspPlaygroundPage";
import { RouteBoundary } from "./app/layout/RouteBoundary";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";

const WORKSPACES = [
  { id: "sh4-debugger", name: "SH4 Debugger" },
  { id: "arm7-debugger", name: "ARM7 Debugger" },
  { id: "audio-debugger", name: "Audio Debugger" },
  { id: "mixed-mode-debugger", name: "Mixed Mode Debugger" },
] as const;

const App = () => {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<RouteBoundary id="home" name="Home"><HomePage /></RouteBoundary>} />
        <Route path="/docs" element={<RouteBoundary id="docs" name="Documentation"><DocsPage /></RouteBoundary>} />

        {/* Workspace routes - each has its own layout persistence */}
        {WORKSPACES.map(({ id, name }) => (
          <Route
            key={id}
            path={`/workspace/${id}`}
            element={<RouteBoundary id="workspace" name={name}><AppLayout workspaceId={id} /></RouteBoundary>}
          />
        ))}

        <Route path="/tool/sh4-sim" element={<RouteBoundary id="sh4-sim" name="SH4 Simulator"><Sh4SimPage /></RouteBoundary>} />
        <Route path="/tool/dsp-playground" element={<RouteBoundary id="dsp-playground" name="DSP Playground"><DspPlaygroundPage /></RouteBoundary>} />
        <Route path="/tool/holly-ta-log-analyzer" element={<RouteBoundary id="ta-log-analyzer" name="TA Log Analyzer"><Clx2TaLogAnalyzerPage /></RouteBoundary>} />
        <Route path="/tool/holly-core-log-analyzer" element={<RouteBoundary id="core-log-analyzer" name="CORE Log Analyzer"><Clx2CoreLogAnalyzerPage /></RouteBoundary>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
};

export default App;
