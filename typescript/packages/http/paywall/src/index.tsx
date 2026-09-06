import React from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "./Providers";
import { PaywallApp } from "./PaywallApp";

// Initialize the app when the window loads
window.addEventListener("load", () => {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error("Root element not found");
    return;
  }

  const root = createRoot(rootElement);
  root.render(
    <Providers>
      <PaywallApp />
    </Providers>,
  );
});
