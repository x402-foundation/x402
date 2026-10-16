import { createRoot } from "react-dom/client";
import type {} from "../window";
import { CardanoPaywall } from "./CardanoPaywall";
import { createAnchoredClock } from "./clock";
import { COLD_RELOAD_STORAGE_KEY } from "./components/ColdStart";
import { type StorageLike, webLocksRunner } from "./payment";

// Anchor the payment clock as early as possible, before the load event.
const clock = createAnchoredClock({
  serverTimeMs: window.x402?.cardano?.serverTimeMs ?? Date.now(),
});

/**
 * Returns localStorage, or a storage whose writes fail when the browser blocks
 * it (the controller then refuses to sign rather than risk a double charge).
 *
 * @returns Storage for payment records.
 */
function paymentStorage(): StorageLike {
  try {
    return window.localStorage;
  } catch {
    const unavailable = (): never => {
      throw new Error("storage unavailable");
    };
    return { getItem: () => null, setItem: unavailable, removeItem: unavailable };
  }
}

window.addEventListener("load", () => {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error("Root element not found");
    return;
  }
  const x402 = window.x402;
  const config = x402?.cardano;
  if (!config?.selectedRequirement) {
    console.error("No Cardano payment requirement found");
    return;
  }
  if (config.protocolParameters) {
    try {
      sessionStorage.removeItem(COLD_RELOAD_STORAGE_KEY);
    } catch {
      // Nothing to reset without storage.
    }
  }

  const storage = paymentStorage();
  // No storage-based fallback: it cannot be made atomic across tabs, so the
  // page refuses to sign where Web Locks are unavailable (non-secure contexts).
  const lock = webLocksRunner(navigator);

  createRoot(rootElement).render(
    <CardanoPaywall
      config={config}
      paymentRequired={x402.paymentRequired}
      currentUrl={x402.currentUrl}
      faucetUrls={x402.faucetUrls}
      clock={clock}
      storage={storage}
      lock={lock}
      onSuccessfulResponse={async (response: Response) => {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("text/html")) {
          document.documentElement.innerHTML = await response.text();
        } else {
          const blob = await response.blob();
          window.location.href = window.URL.createObjectURL(blob);
        }
      }}
    />,
  );
});
