import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import FloatingWindow from "./FloatingWindow";
import "./styles.css";
import "./floating.css";

const floating = new URLSearchParams(window.location.search).get("window") === "floating";
document.body.classList.toggle("floating-mode", floating);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {floating ? <FloatingWindow /> : <App />}
  </React.StrictMode>,
);
