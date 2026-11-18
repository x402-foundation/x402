import type { ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { injected, coinbaseWallet } from "wagmi/connectors";
import * as allChains from "viem/chains";
import type { Chain } from "viem";
import { isEvmNetwork } from "./paywallUtils";

type ProvidersProps = {
  children: ReactNode;
};

// Create QueryClient for React Query
const queryClient = new QueryClient();

/**
 * Providers component for the paywall
 * Sets up Wagmi and React Query for wallet connectivity
 *
 * @param props - The component props
 * @param props.children - The children of the Providers component
 * @returns The Providers component
 */
export function Providers({ children }: ProvidersProps) {
  const { paymentRequired } = window.x402;

  // Determine which chain to connect to
  let targetChain: Chain = allChains.base; // Default to Base

  if (paymentRequired?.accepts?.[0]) {
    const firstRequirement = paymentRequired.accepts[0];
    const network = firstRequirement.network;

    if (isEvmNetwork(network)) {
      const chainId = parseInt(network.split(":")[1]);
      const chain: Chain | undefined = Object.values(allChains).find(c => c.id === chainId);
      if (chain) {
        targetChain = chain;
      }
    }
  }

  // Create Wagmi config
  const config = createConfig({
    chains: [targetChain],
    connectors: [
      injected(),
      coinbaseWallet({
        appName: window.x402.appName || "x402 Paywall",
      }),
    ],
    transports: {
      [targetChain.id]: http(),
    },
  });

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
