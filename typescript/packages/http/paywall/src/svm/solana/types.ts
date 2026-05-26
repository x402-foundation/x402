import type { WalletWithSolanaFeatures } from "@solana/wallet-standard-features";

export type WalletOption = {
  value: string;
  wallet: WalletWithSolanaFeatures;
};
