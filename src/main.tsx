import React from "react";
import ReactDOM from "react-dom/client";
import { WorkspaceRoot } from "./WorkspaceRoot";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RendererErrorBoundary controllerFailed>
      <WorkspaceRoot />
    </RendererErrorBoundary>
  </React.StrictMode>,
);
