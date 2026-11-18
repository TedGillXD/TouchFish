import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import FloatingWindow from "./FloatingWindow";
import BiliPlayer from "./BiliPlayer";
import HongguoWindowBar from "./HongguoWindowBar";
import { initializeHolidayCalendar } from "./holiday-client";
import "./styles.css";
import "./floating.css";

const surface = new URLSearchParams(window.location.search).get("window");
const floating = surface === "floating";
const player = surface === "player";
const hongguoChrome = surface === "hongguo-chrome";
document.body.classList.toggle("floating-mode", floating);
document.body.classList.toggle("player-mode", player);
document.body.classList.toggle("hongguo-window-mode", hongguoChrome);

// Cache hydration precedes all wage-plan normalization in either window.
if (!player && !hongguoChrome) await initializeHolidayCalendar();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {hongguoChrome ? <HongguoWindowBar /> : player ? <BiliPlayer /> : floating ? <FloatingWindow /> : <App />}
  </React.StrictMode>,
);
