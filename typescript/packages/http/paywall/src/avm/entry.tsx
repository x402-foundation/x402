import React from "react";
import { createRoot } from "react-dom/client";
import { WalletManager, WalletId, NetworkId } from "@txnlab/use-wallet";
import { AlgorandClient } from "@algorandfoundation/algokit-utils/algorand-client";
import { AvmPaywall } from "./AvmPaywall";
import type {} from "../window";
import { ALGORAND_NETWORK_REFS } from "../paywallUtils";

// AVM-specific paywall entry point
window.addEventListener("load", async () => {
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

  const network = paymentRequired.accepts[0].network;
  const isTestnet = network.includes(ALGORAND_NETWORK_REFS.TESTNET);

  // Create AlgorandClient using algokit-utils built-in network defaults
  const algorandClient = isTestnet ? AlgorandClient.testNet() : AlgorandClient.mainNet();

  // Initialize WalletManager with Algorand wallets
  // WalletManager v4 uses a networks record with algod config per network
  const networkKey = isTestnet ? NetworkId.TESTNET : NetworkId.MAINNET;
  const algodBaseServer = isTestnet
    ? "https://testnet-api.algonode.cloud"
    : "https://mainnet-api.algonode.cloud";

  const walletManager = new WalletManager({
    wallets: [WalletId.PERA, WalletId.DEFLY, WalletId.LUTE],
    defaultNetwork: networkKey,
    networks: {
      [networkKey]: {
        algod: {
          baseServer: algodBaseServer,
          token: "",
          port: "",
        },
      },
    },
  });

  const root = createRoot(rootElement);
  root.render(
    <AvmPaywall
      paymentRequired={paymentRequired}
      walletManager={walletManager}
      algorandClient={algorandClient}
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
