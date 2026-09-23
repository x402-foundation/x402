import { Client, PrivateKey, type Key } from "@hiero-ledger/sdk";
import { getAddress } from "viem";
import { createHederaClient, parseMirrorKey } from "../signer";
import { mirrorNodeUrlForNetwork } from "../preflight";
import { assertSupportedHederaNetwork } from "../utils";
import { entityIdToLongZeroAddress, resolveAccountEvmAddress } from "./addresses";
import { createHederaMirrorNodeClient, type HederaMirrorNodeClient } from "./mirror";
import {
  createAccountKeyResolver,
  keyTypeOf,
  resolveSigningKeyFromKey,
  signDigestWithPrivateKey,
  verifyDigestSignature,
  type AccountKeyResolver,
  type SigningKeyResolution,
} from "./signing";
import {
  createHieroContractExecutor,
  createMirrorNodeContractReader,
  type HederaContractExecuteArgs,
  type HederaContractExecutionResult,
  type HederaContractReadArgs,
} from "./transport";
import type { HederaAuthorizerSigner, HederaKeyType } from "./types";

/**
 * Client-side signer for the batch-settlement scheme: signs vouchers and deposit
 * authorizations with a Hedera account key and (optionally) reads channel state.
 */
export interface ClientHederaBatchSigner {
  /** Hedera account id (`0.0.x`). */
  readonly accountId: string;
  /** Account EVM address as the network sees it (alias or long-zero); used as `ChannelConfig.payer`. */
  readonly evmAddress: `0x${string}`;
  readonly keyType: HederaKeyType;
  /** Signs a 32-byte digest (raw ED25519 64-byte or ECDSA 65-byte signature). */
  signDigest(digest: `0x${string}`): Promise<`0x${string}`>;
  /** Verifies a signature produced by this signer's own key (used for corrective-402 recovery). */
  verifyOwnSignature(digest: `0x${string}`, signature: `0x${string}`): Promise<boolean>;
  /** Optional onchain read capability (Mirror Node) for channel recovery. */
  readContract?(args: HederaContractReadArgs): Promise<unknown>;
}

/** Facilitator-side signer: pays gas, executes and reads contracts, verifies account signatures. */
export interface FacilitatorHederaBatchSigner {
  /** Mirror Node helpers (allowances, associations, contract results). */
  readonly mirror: HederaMirrorNodeClient;
  /** Fee-payer account ids managed by the facilitator (`/supported.signers`). */
  getAddresses(): readonly string[];
  readContract(args: HederaContractReadArgs): Promise<unknown>;
  /** Throws when the call would revert. */
  simulateContract(args: HederaContractReadArgs): Promise<void>;
  executeContract(args: HederaContractExecuteArgs): Promise<HederaContractExecutionResult>;
  /** Verifies a raw account signature off-chain (mirrors HAS `isAuthorizedRaw`). */
  verifyDigestSignature(params: {
    account: `0x${string}` | string;
    digest: `0x${string}`;
    signature: `0x${string}`;
  }): Promise<{ ok: boolean; reason?: string; message?: string }>;
}

/** Options for {@link createClientHederaBatchSigner}. */
export type ClientHederaBatchSignerConfig = {
  /** CAIP-2 network (default `hedera:testnet`). */
  network?: string;
  /** Mirror Node base URL override. */
  mirrorNodeUrl?: string;
};

/**
 * Creates a client signer from account credentials. Resolves the account's EVM address from the
 * Mirror Node once so `ChannelConfig.payer` matches what HAS and HTS resolve on-chain.
 *
 * @param accountId - Payer account id.
 * @param privateKey - Account private key (ED25519 or ECDSA).
 * @param config - Network / Mirror Node options.
 * @returns Client batch signer.
 */
export async function createClientHederaBatchSigner(
  accountId: string,
  privateKey: PrivateKey,
  config: ClientHederaBatchSignerConfig = {},
): Promise<ClientHederaBatchSigner> {
  const network = config.network ?? "hedera:testnet";
  assertSupportedHederaNetwork(network);
  const mirrorNodeUrl = config.mirrorNodeUrl ?? mirrorNodeUrlForNetwork(network);
  const evmAddress = await resolveAccountEvmAddress(mirrorNodeUrl, accountId);
  const reader = createMirrorNodeContractReader({ mirrorNodeUrl, from: evmAddress });
  const ownKey = resolveSigningKeyFromKey(privateKey.publicKey as Key);

  return {
    accountId,
    evmAddress,
    keyType: keyTypeOf(privateKey),
    signDigest: digest => signDigestWithPrivateKey(privateKey, digest),
    verifyOwnSignature: async (digest, signature) =>
      ownKey.ok ? verifyDigestSignature({ key: ownKey.key, digest, signature }) : false,
    readContract: args => reader.readContract(args),
  };
}

/** Options for {@link createHederaAuthorizerSigner}. */
export type HederaAuthorizerSignerConfig = {
  /** CAIP-2 network used to resolve the account's EVM address (default `hedera:testnet`). */
  network?: string;
  /** Mirror Node base URL override. */
  mirrorNodeUrl?: string;
  /**
   * Explicit EVM address to commit as the authorizer. Must be the address the network resolves
   * for the account (its EVM alias when it has one, otherwise the long-zero address); HAS rejects
   * the long-zero form for accounts that carry an alias.
   */
  evmAddress?: `0x${string}`;
};

/**
 * Creates a receiver-authorizer signer (server or facilitator role) from account credentials.
 * The committed `receiverAuthorizer` address is the account's EVM address as reported by the
 * Mirror Node (alias or long-zero), resolved once unless `evmAddress` is supplied.
 *
 * @param accountId - Authorizer account id.
 * @param privateKey - Authorizer private key (ED25519 or ECDSA).
 * @param config - Network / Mirror Node options.
 * @returns Authorizer signer.
 */
export async function createHederaAuthorizerSigner(
  accountId: string,
  privateKey: PrivateKey,
  config: HederaAuthorizerSignerConfig = {},
): Promise<HederaAuthorizerSigner> {
  const network = config.network ?? "hedera:testnet";
  assertSupportedHederaNetwork(network);
  const address =
    config.evmAddress ??
    (await resolveAccountEvmAddress(
      config.mirrorNodeUrl ?? mirrorNodeUrlForNetwork(network),
      accountId,
    ));
  return {
    address: getAddress(address),
    accountId,
    keyType: keyTypeOf(privateKey),
    signDigest: digest => signDigestWithPrivateKey(privateKey, digest),
  };
}

/** Options for {@link createFacilitatorHederaBatchSigner}. */
export type FacilitatorHederaBatchSignerConfig = {
  /** Operator (fee payer) account id. */
  accountId: string;
  /** Operator private key. */
  privateKey: PrivateKey;
  /** CAIP-2 network (default `hedera:testnet`). */
  network?: string;
  /** Mirror Node base URL override. */
  mirrorNodeUrl?: string;
  /** Custom Hiero client factory (defaults to `createHederaClient(network)` with the operator set). */
  buildClient?: () => Client;
  /** Use a consensus-node `ContractCallQuery` when the Mirror Node cannot simulate a call. */
  consensusReadFallback?: boolean;
  /** Custom account key resolver (defaults to a cached Mirror Node resolver). */
  keyResolver?: AccountKeyResolver;
};

/**
 * Creates a facilitator signer backed by the Hiero SDK (writes) and the Mirror Node (reads).
 *
 * @param config - Operator credentials and network options.
 * @returns Facilitator batch signer.
 */
export function createFacilitatorHederaBatchSigner(
  config: FacilitatorHederaBatchSignerConfig,
): FacilitatorHederaBatchSigner {
  const network = config.network ?? "hedera:testnet";
  assertSupportedHederaNetwork(network);
  const mirrorNodeUrl = config.mirrorNodeUrl ?? mirrorNodeUrlForNetwork(network);
  const buildClient =
    config.buildClient ??
    (() => createHederaClient(network).setOperator(config.accountId, config.privateKey));
  const operatorAddress = entityIdToLongZeroAddress(config.accountId);
  const reader = createMirrorNodeContractReader({
    mirrorNodeUrl,
    from: operatorAddress,
    ...(config.consensusReadFallback ? { fallbackClient: buildClient } : {}),
  });
  const executor = createHieroContractExecutor({ buildClient });
  const mirror = createHederaMirrorNodeClient({ mirrorNodeUrl });
  const resolveKey = config.keyResolver ?? createAccountKeyResolver({ mirrorNodeUrl });

  return {
    getAddresses: () => [config.accountId],
    readContract: args => reader.readContract(args),
    simulateContract: args => reader.simulateContract(args),
    executeContract: args => executor.executeContract(args),
    verifyDigestSignature: async ({ account, digest, signature }) => {
      const resolution: SigningKeyResolution = await resolveKey(account);
      if (!resolution.ok) {
        return { ok: false, reason: resolution.reason, message: resolution.message };
      }
      const ok = await verifyDigestSignature({ key: resolution.key, digest, signature });
      return ok ? { ok: true } : { ok: false, reason: "signature_invalid" };
    },
    mirror,
  };
}

/**
 * Identity helper mirroring `toFacilitatorHederaSigner` for custom implementations.
 *
 * @param base - Signer implementation.
 * @returns The same signer.
 */
export function toFacilitatorHederaBatchSigner(
  base: FacilitatorHederaBatchSigner,
): FacilitatorHederaBatchSigner {
  return base;
}

/**
 * Convenience: parses a Mirror Node key object into a signing-key resolution (re-exported for
 * custom facilitator signers).
 *
 * @param key - Mirror Node account key.
 * @returns Resolution.
 */
export function resolveSigningKeyFromMirror(
  key: Parameters<typeof parseMirrorKey>[0],
): SigningKeyResolution {
  return resolveSigningKeyFromKey(parseMirrorKey(key));
}

/**
 * Normalizes an account reference for logging / comparisons.
 *
 * @param address - EVM address.
 * @returns Checksummed address.
 */
export function normalizeEvmAddress(address: string): `0x${string}` {
  return getAddress(address);
}
