import { Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { toFacilitatorAptosSigner } from "@x402/aptos";
import { ExactAptosScheme } from "@x402/aptos/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/facilitator";
import {
  EIP2612_GAS_SPONSORING,
  createErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { ExactSvmSchemeV1 } from "@x402/svm/exact/v1/facilitator";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/**
 * Initialize and configure the x402 facilitator with EVM, SVM, Aptos, and Stellar support
 * This is called lazily on first use to support Next.js module loading
 *
 * @returns A configured x402Facilitator instance
 */
async function createFacilitator(): Promise<x402Facilitator> {
  // Validate required environment variables
  if (!process.env.FACILITATOR_EVM_PRIVATE_KEY) {
    throw new Error("❌ FACILITATOR_EVM_PRIVATE_KEY environment variable is required");
  }

  if (!process.env.FACILITATOR_SVM_PRIVATE_KEY) {
    throw new Error("❌ FACILITATOR_SVM_PRIVATE_KEY environment variable is required");
  }

  // Initialize the EVM account from private key
  const evmAccount = privateKeyToAccount(process.env.FACILITATOR_EVM_PRIVATE_KEY as `0x${string}`);

  // Create a Viem client with both wallet and public capabilities
  const viemClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(),
  }).extend(publicActions);

  // Initialize the x402 Facilitator with EVM signer
  const evmSigner = toFacilitatorEvmSigner({
    address: evmAccount.address,
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) =>
      viemClient.readContract({
        ...args,
        args: args.args || [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    verifyTypedData: (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => viemClient.verifyTypedData(args as any),
    writeContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }) =>
      viemClient.writeContract({
        ...args,
        args: args.args || [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      viemClient.sendTransaction({ to: args.to, data: args.data } as any),
    waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
      viemClient.waitForTransactionReceipt(args),
    getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
  });

  // Initialize the SVM account from private key
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(process.env.FACILITATOR_SVM_PRIVATE_KEY as string),
  );

  // Initialize SVM signer - handles all Solana networks with automatic RPC creation
  const svmSigner = toFacilitatorSvmSigner(svmAccount);

  // Create and configure the facilitator with EVM and SVM
  const facilitator = new x402Facilitator()
    .register("eip155:84532", new ExactEvmScheme(evmSigner))
    .registerV1("base-sepolia" as Network, new ExactEvmSchemeV1(evmSigner))
    .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme(svmSigner))
    .registerV1("solana-devnet" as Network, new ExactSvmSchemeV1(svmSigner));

  // Optionally register Aptos if configured
  if (process.env.FACILITATOR_APTOS_PRIVATE_KEY) {
    const formattedAptosKey = PrivateKey.formatPrivateKey(
      process.env.FACILITATOR_APTOS_PRIVATE_KEY,
      PrivateKeyVariants.Ed25519,
    );
    const aptosPrivateKey = new Ed25519PrivateKey(formattedAptosKey);
    const aptosAccount = Account.fromPrivateKey({ privateKey: aptosPrivateKey });
    const aptosSigner = toFacilitatorAptosSigner(aptosAccount);
    facilitator.register("aptos:2", new ExactAptosScheme(aptosSigner));
  }

  // Optionally register Stellar if configured
  if (process.env.FACILITATOR_STELLAR_PRIVATE_KEY) {
    const stellarSigners = process.env.FACILITATOR_STELLAR_PRIVATE_KEY.split(",")
      .map(k => k.trim())
      .filter(k => k.length > 0)
      .map(k => createEd25519Signer(k));

    const feeBumpSigner = process.env.FACILITATOR_STELLAR_FEEBUMP_PRIVATE_KEY
      ? createEd25519Signer(process.env.FACILITATOR_STELLAR_FEEBUMP_PRIVATE_KEY)
      : undefined;

    facilitator.register(
      "stellar:testnet",
      new ExactStellarScheme(stellarSigners, { feeBumpSigner }),
    );
  }

  // Build ERC-20 approval signer with sendTransactions for Permit2 gas sponsoring
  const erc20ApprovalSigner = {
    ...evmSigner,
    sendTransactions: async (
      transactions: (`0x${string}` | { to: `0x${string}`; data: `0x${string}`; gas?: bigint })[],
    ): Promise<`0x${string}`[]> => {
      const hashes: `0x${string}`[] = [];
      for (const tx of transactions) {
        let hash: `0x${string}`;
        if (typeof tx === "string") {
          hash = await viemClient.sendRawTransaction({ serializedTransaction: tx });
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hash = await viemClient.sendTransaction(tx as any);
        }
        const receipt = await viemClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`transaction_failed: ${hash}`);
        }
        hashes.push(hash);
      }
      return hashes;
    },
  };

  // Register gas sponsorship extensions for Permit2 support
  facilitator
    .registerExtension(EIP2612_GAS_SPONSORING)
    .registerExtension(createErc20ApprovalGasSponsoringExtension(erc20ApprovalSigner));

  return facilitator;
}

// Lazy initialization
let _facilitatorPromise: Promise<x402Facilitator> | null = null;

/**
 * Get the configured facilitator instance
 * Uses lazy initialization to create the facilitator on first access
 *
 * @returns A promise that resolves to the configured facilitator
 */
export async function getFacilitator(): Promise<x402Facilitator> {
  if (!_facilitatorPromise) {
    _facilitatorPromise = createFacilitator();
  }
  return _facilitatorPromise;
}
