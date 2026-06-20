import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Suppress WebView2's browser context menu everywhere except editable inputs
document.addEventListener(
  "contextmenu",
  (e) => {
    const target = e.target as Element | null;
    if (target?.closest('input:not([readonly]), textarea:not([readonly]), [contenteditable="true"]')) return;
    e.preventDefault();
  },
  true,
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
