import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initApi } from "./api/client";
import "./styles/globals.css";

initApi();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
