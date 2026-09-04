import { createRoot } from "react-dom/client";
import type {} from "../window";
import { StellarPaywall } from "./StellarPaywall";
import { validateX402Config } from "./validate";

// Stellar-specific paywall entry point
window.addEventListener("load", () => {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error("Root element not found");
    return;
  }

  const validationError = validateX402Config();
  if (validationError) {
    console.error("x402 config validation failed:", validationError);

    const container = document.createElement("div");
    container.style.cssText = "padding:2rem;font-family:system-ui,sans-serif;color:#b91c1c";

    const heading = document.createElement("h2");
    heading.textContent = "Payment Configuration Error";

    const message = document.createElement("p");
    message.textContent = validationError;

    container.appendChild(heading);
    container.appendChild(message);

    rootElement.innerHTML = "";
    rootElement.appendChild(container);
    return;
  }

  const x402 = window.x402;
  const paymentRequired = x402.paymentRequired;

  const root = createRoot(rootElement);
  root.render(
    <StellarPaywall
      paymentRequired={paymentRequired}
      onSuccessfulResponse={async (response: Response) => {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("text/html")) {
          document.documentElement.innerHTML = await response.text();
        } else {
          const blob = await response.blob();
          const url = window.URL.createObjectURL(blob);
          window.location.href = url;
        }
      }}
    />,
  );
});
