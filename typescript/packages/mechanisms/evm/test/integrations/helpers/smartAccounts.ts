/**
 * Integration-test helpers for real smart-account signature wrapping.
 *
 * Coinbase Smart Wallet (ERC-4337): replay-safe EIP-712 + SignatureWrapper.
 * Biconomy Nexus (ERC-7579): ERC-7739 nested EIP-712 + validator prefix.
 */

import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseAbiParameters,
  sliceHex,
  type Hex,
  type TypedDataDefinition,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapTypedDataSignature } from "viem/experimental/erc7739";
import type { ClientEvmSigner } from "../../../../src/signer";

/** Coinbase Smart Wallet Factory v1.1 (Base Sepolia). */
export const COINBASE_SMART_WALLET_FACTORY = "0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842" as const;

/** Biconomy Nexus Account Factory (MEE v1.3.1, Base Sepolia). */
export const NEXUS_ACCOUNT_FACTORY = "0x000000002c9A405a196f2dc766F2476B731693c3" as const;

/** Biconomy Nexus Bootstrap (MEE v1.3.0, Base Sepolia). */
export const NEXUS_BOOTSTRAP = "0x000000007BfEdA33ac982cb38eAaEf5D7bCC954c" as const;

/** MEE K1 validator / default validator module (Base Sepolia). */
export const NEXUS_K1_VALIDATOR = "0x0000000002d3cC5642A748B6783F32C032616E03" as const;

/**
 * ERC-7579 signature prefix for accounts initialized with initNexusWithDefaultValidator.
 * Nexus routes address(0) to the bootstrap default validator (see _handleValidator).
 */
export const NEXUS_DEFAULT_VALIDATOR_PREFIX = "0x0000000000000000000000000000000000000000" as const;

export const EIP1271_MAGIC = "0x1626ba7e" as const;

const SIGNATURE_WRAPPER_STRUCT = {
  components: [
    { name: "ownerIndex", type: "uint8" },
    { name: "signatureData", type: "bytes" },
  ],
  name: "SignatureWrapper",
  type: "tuple",
} as const;

const COINBASE_FACTORY_ABI = [
  {
    name: "createAccount",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "owners", type: "bytes[]" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    name: "getAddress",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owners", type: "bytes[]" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const NEXUS_FACTORY_ABI = [
  {
    name: "createAccount",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "initData", type: "bytes" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    name: "computeAccountAddress",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "initData", type: "bytes" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const NEXUS_BOOTSTRAP_ABI = [
  {
    name: "initNexusWithDefaultValidator",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [],
  },
] as const;

/** Build Nexus initializeAccount initData for a single EOA owner (default K1 validator). */
export function buildNexusInitData(owner: `0x${string}`): Hex {
  const ownerData = encodePacked(["address"], [getAddress(owner)]);
  const bootstrapCall = encodeFunctionData({
    abi: NEXUS_BOOTSTRAP_ABI,
    functionName: "initNexusWithDefaultValidator",
    args: [ownerData],
  });
  return encodeAbiParameters(parseAbiParameters("address bootstrap, bytes bootstrapCall"), [
    getAddress(NEXUS_BOOTSTRAP),
    bootstrapCall,
  ]);
}

/** Deterministic salt for owner + index (matches integration-test deployment). */
export function nexusAccountSalt(owner: `0x${string}`, index = 0n): Hex {
  return keccak256(encodePacked(["address", "uint256"], [getAddress(owner), index]));
}

const EIP712_DOMAIN_ABI = [
  {
    name: "eip712Domain",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const IS_VALID_SIGNATURE_ABI = [
  {
    name: "isValidSignature",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
] as const;

/** Encode a single EOA owner for CoinbaseSmartWalletFactory.createAccount. */
export function encodeCoinbaseOwner(owner: `0x${string}`): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters("address"), [getAddress(owner)]);
}

/** Predict Coinbase Smart Wallet address for an owner + nonce. */
export async function predictCoinbaseSmartWalletAddress(
  owner: `0x${string}`,
  nonce = 0n,
  rpcUrl = "https://sepolia.base.org",
): Promise<`0x${string}`> {
  const pc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const owners = [encodeCoinbaseOwner(owner)];
  return pc.readContract({
    address: COINBASE_SMART_WALLET_FACTORY,
    abi: COINBASE_FACTORY_ABI,
    functionName: "getAddress",
    args: [owners, nonce],
  });
}

/** Deploy Coinbase Smart Wallet; returns the account address. */
export async function deployCoinbaseSmartWallet(
  deployerKey: `0x${string}`,
  owner: `0x${string}`,
  nonce = 0n,
  rpcUrl = "https://sepolia.base.org",
): Promise<`0x${string}`> {
  const deployer = privateKeyToAccount(deployerKey);
  const wc = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(rpcUrl) });
  const owners = [encodeCoinbaseOwner(owner)];
  return wc
    .writeContract({
      address: COINBASE_SMART_WALLET_FACTORY,
      abi: COINBASE_FACTORY_ABI,
      functionName: "createAccount",
      args: [owners, nonce],
    })
    .then(async hash => {
      const pc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
      await pc.waitForTransactionReceipt({ hash });
      return predictCoinbaseSmartWalletAddress(owner, nonce, rpcUrl);
    });
}

/** Predict Biconomy Nexus address for an owner + index. */
export async function predictNexusAccountAddress(
  owner: `0x${string}`,
  index = 0n,
  rpcUrl = "https://sepolia.base.org",
): Promise<`0x${string}`> {
  const pc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const initData = buildNexusInitData(owner);
  const salt = nexusAccountSalt(owner, index);
  return pc.readContract({
    address: NEXUS_ACCOUNT_FACTORY,
    abi: NEXUS_FACTORY_ABI,
    functionName: "computeAccountAddress",
    args: [initData, salt],
  });
}

/** Deploy Biconomy Nexus account; returns the account address. */
export async function deployNexusAccount(
  deployerKey: `0x${string}`,
  owner: `0x${string}`,
  index = 0n,
  rpcUrl = "https://sepolia.base.org",
): Promise<`0x${string}`> {
  const deployer = privateKeyToAccount(deployerKey);
  const wc = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(rpcUrl) });
  const initData = buildNexusInitData(owner);
  const salt = nexusAccountSalt(owner, index);
  return wc
    .writeContract({
      address: NEXUS_ACCOUNT_FACTORY,
      abi: NEXUS_FACTORY_ABI,
      functionName: "createAccount",
      args: [initData, salt],
    })
    .then(async hash => {
      const pc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
      await pc.waitForTransactionReceipt({ hash });
      return predictNexusAccountAddress(owner, index, rpcUrl);
    });
}

/** Wrap a 65-byte ECDSA signature in Coinbase Smart Wallet SignatureWrapper format. */
export function wrapCoinbaseSmartWalletSignature(signatureHex: Hex, ownerIndex = 0): Hex {
  const r = sliceHex(signatureHex, 0, 32);
  const s = sliceHex(signatureHex, 32, 64);
  const v = Number(`0x${signatureHex.slice(130, 132)}`);
  const signatureData = encodePacked(["bytes32", "bytes32", "uint8"], [r, s, v]);
  return encodeAbiParameters([SIGNATURE_WRAPPER_STRUCT], [{ ownerIndex, signatureData }]);
}

/** Create replay-safe typed data for Coinbase Smart Wallet signing. */
export function createCoinbaseReplaySafeTypedData(
  typedData: TypedDataDefinition,
  smartAccountAddress: `0x${string}`,
  chainId: number | bigint,
): TypedDataDefinition {
  const originalHash = hashTypedData(typedData);
  return {
    domain: {
      name: "Coinbase Smart Wallet",
      version: "1",
      chainId: Number(chainId),
      verifyingContract: getAddress(smartAccountAddress),
    },
    types: {
      CoinbaseSmartWalletMessage: [{ name: "hash", type: "bytes32" }],
    },
    primaryType: "CoinbaseSmartWalletMessage",
    message: { hash: originalHash },
  };
}

/** Sign EIP-712 typed data for Coinbase Smart Wallet (replay-safe + SignatureWrapper). */
export async function signCoinbaseSmartWalletTypedData(
  ownerAccount: PrivateKeyAccount,
  smartAccountAddress: `0x${string}`,
  typedData: TypedDataDefinition,
): Promise<Hex> {
  const chainId =
    typeof typedData.domain?.chainId === "bigint"
      ? typedData.domain.chainId
      : BigInt(typedData.domain?.chainId ?? baseSepolia.id);
  const replaySafe = createCoinbaseReplaySafeTypedData(typedData, smartAccountAddress, chainId);
  const innerSig = await ownerAccount.signTypedData(replaySafe as never);
  return wrapCoinbaseSmartWalletSignature(innerSig);
}

/** Fetch Nexus eip712Domain for ERC-7739 verifierDomain. */
export async function fetchNexusVerifierDomain(
  accountAddress: `0x${string}`,
  rpcUrl = "https://sepolia.base.org",
) {
  const pc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const result = await pc.readContract({
    address: accountAddress,
    abi: EIP712_DOMAIN_ABI,
    functionName: "eip712Domain",
  });
  return {
    name: result[1],
    version: result[2],
    chainId: result[3],
    verifyingContract: getAddress(result[4] as `0x${string}`),
    salt: result[5],
  };
}

/** Sign EIP-712 typed data for Biconomy Nexus (ERC-7739 + validator prefix). */
export async function signNexusTypedData(
  ownerAccount: PrivateKeyAccount,
  nexusAddress: `0x${string}`,
  _validatorAddress: `0x${string}`,
  typedData: TypedDataDefinition,
  rpcUrl = "https://sepolia.base.org",
): Promise<Hex> {
  const verifierDomain = await fetchNexusVerifierDomain(nexusAddress, rpcUrl);
  const nestedSig = await ownerAccount.signTypedData({
    domain: typedData.domain,
    types: {
      ...(typedData.types as Record<string, unknown>),
      TypedDataSign: [
        { name: "contents", type: typedData.primaryType as string },
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
        { name: "salt", type: "bytes32" },
      ],
    },
    primaryType: "TypedDataSign",
    message: {
      contents: typedData.message,
      name: verifierDomain.name,
      version: verifierDomain.version,
      chainId: verifierDomain.chainId,
      verifyingContract: verifierDomain.verifyingContract,
      salt: verifierDomain.salt,
    },
  } as never);
  const wrapped = wrapTypedDataSignature({
    ...typedData,
    signature: nestedSig,
  } as never);
  return concat([NEXUS_DEFAULT_VALIDATOR_PREFIX, wrapped]);
}

/** Verify wrapped signature via on-chain isValidSignature eth_call. */
export async function verifyIsValidSignature(
  accountAddress: `0x${string}`,
  digest: Hex,
  signature: Hex,
  rpcUrl = "https://sepolia.base.org",
): Promise<boolean> {
  const pc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const result = await pc.readContract({
    address: accountAddress,
    abi: IS_VALID_SIGNATURE_ABI,
    functionName: "isValidSignature",
    args: [digest, signature],
  });
  return result.toLowerCase() === EIP1271_MAGIC;
}

/** ClientEvmSigner that presents a smart-account address and wraps signatures for Coinbase Smart Wallet. */
export function createCoinbaseSmartWalletClientSigner(
  ownerAccount: PrivateKeyAccount,
  smartAccountAddress: `0x${string}`,
): ClientEvmSigner {
  return {
    address: getAddress(smartAccountAddress),
    signTypedData: async typedData =>
      signCoinbaseSmartWalletTypedData(ownerAccount, smartAccountAddress, typedData),
  };
}

/** ClientEvmSigner that presents a Nexus address and wraps signatures with ERC-7739 + validator prefix. */
export function createNexusClientSigner(
  ownerAccount: PrivateKeyAccount,
  nexusAddress: `0x${string}`,
  validatorAddress: `0x${string}` = NEXUS_K1_VALIDATOR,
  rpcUrl = "https://sepolia.base.org",
): ClientEvmSigner {
  return {
    address: getAddress(nexusAddress),
    signTypedData: async typedData =>
      signNexusTypedData(ownerAccount, nexusAddress, validatorAddress, typedData, rpcUrl),
  };
}
