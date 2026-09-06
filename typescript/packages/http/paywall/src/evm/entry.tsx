import React from "react";
import { createRoot } from "react-dom/client";
import { EvmPaywall } from "./EvmPaywall";
import { Providers } from "../Providers";
import type {} from "../window";

// EVM-specific paywall entry point
window.addEventListener("load", () => {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error("Root element not found");
    return;
  }

  const x402 = window.x402;
  const paymentRequired = x402.paymentRequired;

  if (!paymentRequired?.accepts?.[0]) {
    console.error("No payment requirements found");
    return;
  }

  const root = createRoot(rootElement);
  root.render(
    <Providers>
      <EvmPaywall
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
      />
    </Providers>,
  );
});
