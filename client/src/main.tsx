import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { registerOhiyoServiceWorker } from "./lib/push";

const isBurrow = window.location.pathname.replace(/\/$/, "") === "/burrow";
const App = isBurrow ? lazy(() => import("./burrow/Burrow")) : lazy(() => import("./App"));
if (!isBurrow) void registerOhiyoServiceWorker();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={<p role="status">Opening…</p>}>
      <App />
    </Suspense>
  </React.StrictMode>
);
