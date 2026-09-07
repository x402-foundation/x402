import { useMemo } from "react";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import type { SignAuthEntry } from "@stellar/stellar-sdk/contract";
import type { Network } from "@x402/core/types";
import { parseError } from "./utils";
import { getNetworkPassphrase, type ClientStellarSigner } from "@x402/stellar";

export type UseSWKSignerParams = {
  address: string | null;
  network: Network;
  kitReady: boolean;
};

/**
 * Creates a Stellar signer that uses Stellar Wallet Kit for signing.
 *
 * @param params - Hook parameters.
 * @param params.address - Wallet address to sign with.
 * @param params.network - Network to sign with (CAIP-2 format).
 * @param params.kitReady - Whether Stellar Wallet Kit has been initialized.
 * @returns A Stellar client signer or null if not available.
 */
export function useSWKSigner({
  address,
  network,
  kitReady,
}: UseSWKSignerParams): ClientStellarSigner | null {
  return useMemo(() => {
    if (!address || !kitReady) {
      return null;
    }

    const signAuthEntryFunc: SignAuthEntry = async (
      authEntry: string,
      opts?: {
        networkPassphrase?: string;
        address?: string;
      },
    ) => {
      try {
        const signingResult = await StellarWalletsKit.signAuthEntry(authEntry, {
          address,
          networkPassphrase: opts?.networkPassphrase || getNetworkPassphrase(network),
        });

        const { signedAuthEntry } = signingResult;
        if (!signedAuthEntry) {
          const selectedModule = StellarWalletsKit.selectedModule;
          return {
            signedAuthEntry: "",
            error: {
              message: `Wallet ${selectedModule?.productName ?? "unknown"} did not return a signed auth entry.`,
              code: 0,
            },
          };
        }

        return {
          signedAuthEntry,
          signerAddress: signingResult.signerAddress || address,
        };
      } catch (error) {
        return {
          signedAuthEntry: "",
          error: {
            message: parseError(error, "Failed to sign auth entry."),
            code: 0,
          },
        };
      }
    };

    return {
      address,
      signAuthEntry: signAuthEntryFunc,
    };
  }, [address, network, kitReady]);
}
