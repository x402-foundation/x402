import type { ClientEvmSigner } from "@x402/evm";
import type { Account, WalletClient } from "viem";

/**
 * Converts a wagmi/viem WalletClient to a ClientEvmSigner for x402Client
 *
 * @param walletClient - The wagmi wallet client from useWalletClient()
 * @returns ClientEvmSigner compatible with ExactEvmClient
 */
export function wagmiToClientSigner(walletClient: WalletClient): ClientEvmSigner {
  if (!walletClient.account) {
    throw new Error("Wallet client must have an account");
  }

  return {
    address: walletClient.account.address,
    signTypedData: async message => {
      const signature = await walletClient.signTypedData({
        account: walletClient.account as Account,
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      });
      return signature;
    },
  };
}
