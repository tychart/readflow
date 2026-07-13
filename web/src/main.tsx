import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { initTheme } from "./hooks/useTheme";
import "./styles.css";

// Synchronously apply the saved (or system-detected) theme before React hydrates.
// This prevents a flash of the wrong color scheme on first paint.
initTheme();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

