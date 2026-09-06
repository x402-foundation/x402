import type { Wallet } from "@wallet-standard/base";

/**
 * Algorand wallet with AVM signing features
 */
export interface WalletWithAvmFeatures extends Wallet {
  features: Wallet["features"] & {
    "algorand:signTransaction"?: {
      signTransaction: (params: {
        txns: Uint8Array[];
        indexesToSign?: number[];
      }) => Promise<(Uint8Array | null)[]>;
    };
  };
}

/**
 * Wallet option for dropdown selection
 */
export type WalletOption = {
  value: string;
  wallet: WalletWithAvmFeatures;
};

/**
 * Algorand account from wallet
 */
export interface AlgorandAccount {
  address: string;
  name?: string;
}
