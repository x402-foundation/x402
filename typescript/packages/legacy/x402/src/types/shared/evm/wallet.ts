import { createPublicClient, createWalletClient, http, publicActions } from "viem";
import type {
  Chain,
  Transport,
  Client,
  Account,
  RpcSchema,
  PublicActions,
  WalletActions,
  PublicClient,
  LocalAccount,
} from "viem";
import {
  baseSepolia,
  avalancheFuji,
  base,
  sei,
  seiTestnet,
  polygon,
  polygonAmoy,
  peaq,
  avalanche,
  iotexTestnet,
  iotex,
  abstract,
  abstractTestnet,
  story,
  eduChain,
} from "viem/chains";
import { skaleBaseSepolia } from "../custom-chains";
import { privateKeyToAccount } from "viem/accounts";
import { Hex } from "viem";
import { eip712WalletActions } from "viem/zksync";

// Create a public client for reading data
export type SignerWallet<
  chain extends Chain = Chain,
  transport extends Transport = Transport,
  account extends Account = Account,
> = Client<
  transport,
  chain,
  account,
  RpcSchema,
  PublicActions<transport, chain, account> & WalletActions<chain, account>
>;

export type ConnectedClient<
  transport extends Transport = Transport,
  chain extends Chain | undefined = Chain,
  account extends Account | undefined = undefined,
> = PublicClient<transport, chain, account>;

export type EvmSigner = SignerWallet<Chain, Transport, Account> | LocalAccount;

/**
 * Creates a public client configured for the specified network
 *
 * @param network - The network to connect to
 * @returns A public client instance connected to the specified chain
 */
export function createConnectedClient(
  network: string,
): ConnectedClient<Transport, Chain, undefined> {
  const chain = getChainFromNetwork(network);

  return createPublicClient({
    chain,
    transport: http(),
  }).extend(publicActions);
}

/**
 * Creates a public client configured for the Base Sepolia testnet
 *
 * @deprecated Use `createConnectedClient("base-sepolia")` instead
 * @returns A public client instance connected to Base Sepolia
 */
export function createClientSepolia(): ConnectedClient<Transport, typeof baseSepolia, undefined> {
  return createConnectedClient("base-sepolia") as ConnectedClient<
    Transport,
    typeof baseSepolia,
    undefined
  >;
}

/**
 * Creates a public client configured for the Avalanche Fuji testnet
 *
 * @deprecated Use `createConnectedClient("avalanche-fuji")` instead
 * @returns A public client instance connected to Avalanche Fuji
 */
export function createClientAvalancheFuji(): ConnectedClient<
  Transport,
  typeof avalancheFuji,
  undefined
> {
  return createConnectedClient("avalanche-fuji") as ConnectedClient<
    Transport,
    typeof avalancheFuji,
    undefined
  >;
}

/**
 * Creates a wallet client configured for the specified chain with a private key
 *
 * @param network - The network to connect to
 * @param privateKey - The private key to use for signing transactions
 * @returns A wallet client instance connected to the specified chain with the provided private key
 */
export function createSigner(network: string, privateKey: Hex): SignerWallet<Chain> {
  const chain = getChainFromNetwork(network);

  const walletClient = createWalletClient({
    chain,
    transport: http(),
    account: privateKeyToAccount(privateKey),
  });

  if (isZkStackChain(chain)) {
    return walletClient.extend(publicActions).extend(eip712WalletActions());
  }

  return walletClient.extend(publicActions);
}

/**
 * Creates a wallet client configured for the Base Sepolia testnet with a private key
 *
 * @deprecated Use `createSigner("base-sepolia", privateKey)` instead
 * @param privateKey - The private key to use for signing transactions
 * @returns A wallet client instance connected to Base Sepolia with the provided private key
 */
export function createSignerSepolia(privateKey: Hex): SignerWallet<typeof baseSepolia> {
  return createSigner("base-sepolia", privateKey) as SignerWallet<typeof baseSepolia>;
}

/**
 * Creates a wallet client configured for the Avalanche Fuji testnet with a private key
 *
 * @deprecated Use `createSigner("avalanche-fuji", privateKey)` instead
 * @param privateKey - The private key to use for signing transactions
 * @returns A wallet client instance connected to Avalanche Fuji with the provided private key
 */
export function createSignerAvalancheFuji(privateKey: Hex): SignerWallet<typeof avalancheFuji> {
  return createSigner("avalanche-fuji", privateKey) as SignerWallet<typeof avalancheFuji>;
}

/**
 * Checks if a wallet is a signer wallet
 *
 * @param wallet - The wallet to check
 * @returns True if the wallet is a signer wallet, false otherwise
 */
export function isSignerWallet<
  TChain extends Chain = Chain,
  TTransport extends Transport = Transport,
  TAccount extends Account = Account,
>(
  wallet: SignerWallet<TChain, TTransport, TAccount> | LocalAccount,
): wallet is SignerWallet<TChain, TTransport, TAccount> {
  return (
    typeof wallet === "object" && wallet !== null && "chain" in wallet && "transport" in wallet
  );
}

/**
 * Checks if a wallet is an account
 *
 * @param wallet - The wallet to check
 * @returns True if the wallet is an account, false otherwise
 */
export function isAccount<
  TChain extends Chain = Chain,
  TTransport extends Transport = Transport,
  TAccount extends Account = Account,
>(wallet: SignerWallet<TChain, TTransport, TAccount> | LocalAccount): wallet is LocalAccount {
  const w = wallet as LocalAccount;
  return (
    typeof wallet === "object" &&
    wallet !== null &&
    typeof w.address === "string" &&
    typeof w.type === "string" &&
    // Check for essential signing capabilities
    typeof w.sign === "function" &&
    typeof w.signMessage === "function" &&
    typeof w.signTypedData === "function" &&
    // Check for transaction signing (required by LocalAccount)
    typeof w.signTransaction === "function"
  );
}

/**
 * Maps network strings to Chain objects
 *
 * @param network - The network string to convert to a Chain object
 * @returns The corresponding Chain object
 */
export function getChainFromNetwork(network: string | undefined): Chain {
  if (!network) {
    throw new Error("NETWORK environment variable is not set");
  }

  switch (network) {
    case "abstract":
      return abstract;
    case "abstract-testnet":
      return abstractTestnet;
    case "base":
      return base;
    case "base-sepolia":
      return baseSepolia;
    case "avalanche":
      return avalanche;
    case "avalanche-fuji":
      return avalancheFuji;
    case "sei":
      return sei;
    case "sei-testnet":
      return seiTestnet;
    case "polygon":
      return polygon;
    case "polygon-amoy":
      return polygonAmoy;
    case "peaq":
      return peaq;
    case "story":
      return story;
    case "educhain":
      return eduChain;
    case "iotex":
      return iotex;
    case "iotex-testnet":
      return iotexTestnet;
    case "skale-base-sepolia":
      return skaleBaseSepolia;
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

const ZKSTACK_CHAIN_IDS = new Set([
  2741, // Abstract Mainnet
  11124, // Abstract Sepolia Testnet
]);

/**
 * Checks whether the given chain is part of the zkstack stack
 *
 * @param chain - The chain to check
 * @returns True if the chain is a ZK stack chain
 */
export function isZkStackChain(chain: Chain): boolean {
  return ZKSTACK_CHAIN_IDS.has(chain.id);
}
