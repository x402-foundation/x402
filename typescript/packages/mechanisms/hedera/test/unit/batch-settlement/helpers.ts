import { PrivateKey } from "@hiero-ledger/sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toBytes } from "viem";
import { vi } from "vitest";
import {
  BATCH_SETTLEMENT_SCHEME,
  HTS_ALLOWANCE_TRANSFER_METHOD,
  batchSettlementABI,
  entityIdToLongZeroAddress,
  isLongZeroAddress,
  keyTypeOf,
  longZeroAddressToEntityId,
  registerBatchSettlementDeployment,
  resolveSigningKeyFromKey,
  signDigestWithPrivateKey,
  verifyDigestSignature,
  type ClientHederaBatchSigner,
  type FacilitatorHederaBatchSigner,
  type HederaAuthorizerSigner,
  type HederaContractExecutionResult,
  type HederaContractLog,
  type HederaContractReadArgs,
} from "../../../src/batch-settlement";

export const NETWORK = "hedera:testnet";
export const USDC_ID = "0.0.429274";
export const USDC_ADDRESS = "0x0000000000000000000000000000000000068cDa" as const;
export const RECEIVER_ID = "0.0.5001";
export const RECEIVER_ADDRESS = entityIdToLongZeroAddress(RECEIVER_ID);
export const DEPLOYMENT = {
  settlement: "0x00000000000000000000000000000000009F0001" as `0x${string}`,
  settlementId: "0.0.10420225",
  collector: "0x00000000000000000000000000000000009F0002" as `0x${string}`,
  collectorId: "0.0.10420226",
};
registerBatchSettlementDeployment(NETWORK, DEPLOYMENT);

/** A test account: Hedera key + the EVM address the network would resolve it to. */
export type TestAccount = {
  key: PrivateKey;
  accountId: string;
  evmAddress: `0x${string}`;
};

let accountCounter = 7000;

/**
 * Creates a test account. ECDSA accounts get an EVM alias derived from the key; ED25519 accounts
 * get a long-zero address.
 *
 * @param type - Key algorithm.
 * @returns Test account.
 */
export function makeAccount(type: "ED25519" | "ECDSA"): TestAccount {
  const key = type === "ED25519" ? PrivateKey.generateED25519() : PrivateKey.generateECDSA();
  const accountId = `0.0.${accountCounter++}`;
  const evmAddress =
    type === "ECDSA"
      ? getAddress(`0x${key.publicKey.toEvmAddress().replace(/^0x/, "")}`)
      : entityIdToLongZeroAddress(accountId);
  return { key, accountId, evmAddress };
}

/**
 * Builds a client signer for a test account.
 *
 * @param account - Test account.
 * @param readContract - Optional read implementation.
 * @returns Client signer.
 */
export function clientSigner(
  account: TestAccount,
  readContract?: ClientHederaBatchSigner["readContract"],
): ClientHederaBatchSigner {
  const resolved = resolveSigningKeyFromKey(account.key.publicKey);
  return {
    accountId: account.accountId,
    evmAddress: account.evmAddress,
    keyType: keyTypeOf(account.key),
    signDigest: digest => signDigestWithPrivateKey(account.key, digest),
    verifyOwnSignature: async (digest, signature) =>
      resolved.ok ? verifyDigestSignature({ key: resolved.key, digest, signature }) : false,
    readContract,
  };
}

/**
 * Builds an authorizer signer for a test account.
 *
 * @param account - Test account.
 * @returns Authorizer signer.
 */
export function authorizerSigner(account: TestAccount): HederaAuthorizerSigner {
  return {
    address: account.evmAddress,
    accountId: account.accountId,
    keyType: keyTypeOf(account.key),
    signDigest: digest => signDigestWithPrivateKey(account.key, digest),
  };
}

/** Mutable onchain state simulated by the fake facilitator signer. */
export type FakeChain = {
  channels: Record<string, { balance: bigint; totalClaimed: bigint }>;
  pendingWithdrawals: Record<string, { amount: bigint; initiatedAt: bigint }>;
  refundNonces: Record<string, bigint>;
  receivers: Record<string, { totalClaimed: bigint; totalSettled: bigint }>;
  balances: Record<string, bigint>;
  usedNonces: Set<string>;
  allowances: Record<string, bigint>;
  associated: Set<string>;
  executions: { functionName: string; args: readonly unknown[]; gas: bigint }[];
  nextExecution?: () => Promise<HederaContractExecutionResult>;
  nextLogs?: HederaContractLog[];
  simulateError?: Error;
};

/**
 * Creates a fresh fake chain state.
 *
 * @returns Fake chain.
 */
export function makeChain(): FakeChain {
  return {
    channels: {},
    pendingWithdrawals: {},
    refundNonces: {},
    receivers: {},
    balances: {},
    usedNonces: new Set(),
    allowances: {},
    associated: new Set([DEPLOYMENT.settlementId, RECEIVER_ID]),
    executions: [],
  };
}

/**
 * Builds a fake facilitator signer that answers reads from `chain`, verifies signatures with
 * the registered test accounts' keys, and records executions.
 *
 * @param chain - Fake chain state.
 * @param accounts - Known accounts (for key resolution).
 * @returns Facilitator signer + spies.
 */
export function facilitatorSigner(
  chain: FakeChain,
  accounts: TestAccount[],
): FacilitatorHederaBatchSigner {
  const byAddress = new Map(accounts.map(a => [a.evmAddress.toLowerCase(), a]));
  const read = async (args: HederaContractReadArgs): Promise<unknown> => {
    const [a0, a1] = (args.args ?? []) as unknown[];
    switch (args.functionName) {
      case "channels": {
        const ch = chain.channels[String(a0).toLowerCase()];
        return [ch?.balance ?? 0n, ch?.totalClaimed ?? 0n];
      }
      case "pendingWithdrawals": {
        const w = chain.pendingWithdrawals[String(a0).toLowerCase()];
        return [w?.amount ?? 0n, w?.initiatedAt ?? 0n];
      }
      case "refundNonce":
        return chain.refundNonces[String(a0).toLowerCase()] ?? 0n;
      case "receivers": {
        const r = chain.receivers[`${String(a0).toLowerCase()}:${String(a1).toLowerCase()}`];
        return [r?.totalClaimed ?? 0n, r?.totalSettled ?? 0n];
      }
      case "balanceOf":
        return chain.balances[String(a0).toLowerCase()] ?? 0n;
      case "usedNonces":
        return chain.usedNonces.has(`${String(a0).toLowerCase()}:${String(a1)}`);
      default:
        throw new Error(`unexpected read ${args.functionName}`);
    }
  };
  return {
    mirror: {
      baseUrl: "http://mirror.test",
      getAccount: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      getTokenAllowance: vi.fn(
        async (owner: string) => chain.allowances[owner.toLowerCase()] ?? 0n,
      ),
      canReceiveToken: vi.fn(async (account: string) => {
        const id = isLongZeroAddress(account) ? longZeroAddressToEntityId(account) : account;
        return chain.associated.has(id) || chain.associated.has(account);
      }),
      getContractResult: vi.fn(async () => {
        throw new Error("not implemented");
      }),
    },
    getAddresses: () => ["0.0.9999"],
    readContract: vi.fn(read),
    simulateContract: vi.fn(async () => {
      if (chain.simulateError) throw chain.simulateError;
    }),
    executeContract: vi.fn(async args => {
      chain.executions.push({ functionName: args.functionName, args: args.args, gas: args.gas });
      if (chain.nextExecution) return chain.nextExecution();
      return { transactionId: `0.0.9999@${chain.executions.length}.0`, logs: chain.nextLogs ?? [] };
    }),
    verifyDigestSignature: vi.fn(async ({ account, digest, signature }) => {
      const acct = byAddress.get(String(account).toLowerCase());
      if (!acct) return { ok: false, reason: "account_not_found", message: "no such account" };
      const resolved = resolveSigningKeyFromKey(acct.key.publicKey);
      if (!resolved.ok) return { ok: false, reason: "unsupported_key" };
      const ok = await verifyDigestSignature({ key: resolved.key, digest, signature });
      return ok ? { ok: true } : { ok: false, reason: "signature_invalid" };
    }),
  };
}

/**
 * Builds payment requirements for the test route.
 *
 * @param receiverAuthorizer - Authorizer address.
 * @param amount - Per-request max amount.
 * @returns Payment requirements.
 */
export function requirements(
  receiverAuthorizer: `0x${string}`,
  amount = "1000",
): PaymentRequirements {
  return {
    scheme: BATCH_SETTLEMENT_SCHEME,
    network: NETWORK,
    amount,
    asset: USDC_ID,
    payTo: RECEIVER_ID,
    maxTimeoutSeconds: 600,
    extra: {
      assetTransferMethod: HTS_ALLOWANCE_TRANSFER_METHOD,
      receiverAuthorizer,
      withdrawDelay: 900,
      minDeposit: "10000",
    },
  };
}

/**
 * Encodes a `Settled(receiver, token, sender, amount)` log as emitted by the escrow.
 *
 * @param receiver - Receiver address.
 * @param token - Token address.
 * @param amount - Settled amount.
 * @returns Log entry.
 */
export function settledLog(
  receiver: `0x${string}`,
  token: `0x${string}`,
  amount: bigint,
): HederaContractLog {
  const topics = encodeEventTopics({
    abi: batchSettlementABI,
    eventName: "Settled",
    args: { receiver, token, sender: DEPLOYMENT.settlement },
  });
  return {
    address: DEPLOYMENT.settlement,
    topics: topics as HederaContractLog["topics"],
    data: encodeAbiParameters([{ type: "uint128" }], [amount]),
  };
}

/**
 * Deterministic digest helper for tests.
 *
 * @param label - Label.
 * @returns keccak digest.
 */
export function digestOf(label: string): `0x${string}` {
  return keccak256(toBytes(label));
}
