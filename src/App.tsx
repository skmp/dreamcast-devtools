import { HomePage } from "./app/layout/HomePage";
import { RouteBoundary } from "./app/layout/RouteBoundary";
import { lazyImport } from "./app/components/lazyImport";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";

// Only the home page is part of the initial bundle. Every other route is fetched when it
// is first visited (RouteBoundary shows a placeholder meanwhile, and the error with a
// button that reloads the page when the download fails).
const AppLayout = lazyImport(() => import("./app/layout/AppLayout").then((module) => ({ default: module.AppLayout })));
const DocsPage = lazyImport(() => import("./app/layout/DocsPage").then((module) => ({ default: module.DocsPage })));
const Sh4SimPage = lazyImport(() => import("./app/layout/Sh4SimPage").then((module) => ({ default: module.Sh4SimPage })));
const DspPlaygroundPage = lazyImport(() =>
  import("./app/layout/DspPlaygroundPage").then((module) => ({ default: module.DspPlaygroundPage })),
);
const Clx2TaLogAnalyzerPage = lazyImport(() =>
  import("./app/layout/Clx2TaLogAnalyzerPage").then((module) => ({ default: module.Clx2TaLogAnalyzerPage })),
);
const Clx2CoreLogAnalyzerPage = lazyImport(() =>
  import("./app/layout/Clx2CoreLogAnalyzerPage").then((module) => ({ default: module.Clx2CoreLogAnalyzerPage })),
);

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
