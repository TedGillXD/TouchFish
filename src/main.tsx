import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import FloatingWindow from "./FloatingWindow";
import { initializeHolidayCalendar } from "./holiday-client";
import "./styles.css";
import "./floating.css";

const floating = new URLSearchParams(window.location.search).get("window") === "floating";
document.body.classList.toggle("floating-mode", floating);

// Cache hydration precedes all wage-plan normalization in either window.
await initializeHolidayCalendar();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {floating ? <FloatingWindow /> : <App />}
  </React.StrictMode>,
);
