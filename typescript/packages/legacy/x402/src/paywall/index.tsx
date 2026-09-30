import { createRoot } from "react-dom/client";
import { Providers } from "./src/Providers";
import { PaywallApp } from "./src/PaywallApp";

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
