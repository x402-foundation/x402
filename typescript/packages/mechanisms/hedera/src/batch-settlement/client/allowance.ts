import {
  AccountAllowanceApproveTransaction,
  AccountId,
  Client,
  ContractId,
  PrivateKey,
  TokenId,
} from "@hiero-ledger/sdk";
import { HTS_INT64_MAX, getBatchSettlementDeployment } from "../constants";
import { createHederaMirrorNodeClient } from "../mirror";
import { mirrorNodeUrlForNetwork } from "../../preflight";
import { createHederaClient } from "../../signer";

/** Options for {@link approveHtsAllowance}. */
export type ApproveHtsAllowanceOptions = {
  /** CAIP-2 network (default `hedera:testnet`). */
  network?: string;
  /** Payer account id (`0.0.x`) that owns the tokens. */
  ownerAccountId: string;
  /** Payer private key used to sign the approval and pay its fee. */
  ownerPrivateKey: PrivateKey;
  /** HTS token id (`0.0.x`). Defaults to the network's default asset when omitted by callers. */
  tokenId: string;
  /** Allowance amount in token base units, or `"max"` for the HTS `int64` maximum. */
  amount: string | bigint | "max";
  /** Spender contract id; defaults to the network's deposit collector. */
  spenderId?: string;
  /** Custom Hiero client (defaults to the public network client). */
  client?: Client;
};

/**
 * Grants (or replaces) the HTS fungible-token allowance the payer gives the deposit collector.
 * This is the one-time, natively signed step that replaces Permit2 / ERC-3009 on Hedera; it can
 * be signed with any Hedera key type and costs a small HBAR fee.
 *
 * @param options - Approval parameters.
 * @returns Hedera transaction id of the approval.
 */
export async function approveHtsAllowance(options: ApproveHtsAllowanceOptions): Promise<string> {
  const network = options.network ?? "hedera:testnet";
  const amount = options.amount === "max" ? HTS_INT64_MAX : BigInt(options.amount);
  if (amount < 0n || amount > HTS_INT64_MAX) {
    throw new Error("allowance amount must be within the HTS int64 range");
  }
  const spender = options.spenderId ?? getBatchSettlementDeployment(network).collectorId;
  const client =
    options.client ??
    createHederaClient(network).setOperator(options.ownerAccountId, options.ownerPrivateKey);
  const shouldClose = options.client === undefined;
  try {
    const tx = await new AccountAllowanceApproveTransaction()
      .approveTokenAllowance(
        TokenId.fromString(options.tokenId),
        AccountId.fromString(options.ownerAccountId),
        ContractId.fromString(spender),
        amount,
      )
      .freezeWith(client)
      .sign(options.ownerPrivateKey);
    const response = await tx.execute(client);
    await response.getReceipt(client);
    return response.transactionId.toString();
  } finally {
    if (shouldClose) client.close();
  }
}

/**
 * Reads the remaining allowance the payer granted the deposit collector.
 *
 * @param params - Query parameters.
 * @param params.network - CAIP-2 network.
 * @param params.ownerAccountId - Payer account id or EVM address.
 * @param params.tokenId - HTS token id.
 * @param params.spenderId - Spender contract id (defaults to the network's collector).
 * @param params.mirrorNodeUrl - Mirror Node override.
 * @returns Remaining allowance in base units.
 */
export async function readHtsAllowance(params: {
  network: string;
  ownerAccountId: string;
  tokenId: string;
  spenderId?: string;
  mirrorNodeUrl?: string;
}): Promise<bigint> {
  const mirror = createHederaMirrorNodeClient({
    mirrorNodeUrl: params.mirrorNodeUrl ?? mirrorNodeUrlForNetwork(params.network),
  });
  const spender = params.spenderId ?? getBatchSettlementDeployment(params.network).collectorId;
  return mirror.getTokenAllowance(params.ownerAccountId, spender, params.tokenId);
}

/**
 * Ensures the payer's allowance to the collector covers `required`, approving `amount`
 * (default `"max"`) when it does not.
 *
 * @param options - Approval parameters plus the required minimum.
 * @param options.required - Minimum allowance that must be available.
 * @param options.visibilityTimeoutMs - Max wait for Mirror Node visibility after approving.
 * @returns The approval transaction id when an approval was sent, otherwise `undefined`.
 */
export async function ensureHtsAllowance(
  options: Omit<ApproveHtsAllowanceOptions, "amount"> & {
    required: string | bigint;
    amount?: ApproveHtsAllowanceOptions["amount"];
    mirrorNodeUrl?: string;
    /** How long to wait for the Mirror Node to reflect a new approval (default 30 s). */
    visibilityTimeoutMs?: number;
  },
): Promise<string | undefined> {
  const network = options.network ?? "hedera:testnet";
  const current = await readHtsAllowance({
    network,
    ownerAccountId: options.ownerAccountId,
    tokenId: options.tokenId,
    spenderId: options.spenderId,
    mirrorNodeUrl: options.mirrorNodeUrl,
  });
  if (current >= BigInt(options.required)) {
    return undefined;
  }
  const tx = await approveHtsAllowance({ ...options, network, amount: options.amount ?? "max" });

  // The facilitator reads allowances from the Mirror Node, which lags consensus by a few
  // seconds; wait until the new allowance is visible so the first deposit is not rejected.
  const deadline = Date.now() + (options.visibilityTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const visible = await readHtsAllowance({
      network,
      ownerAccountId: options.ownerAccountId,
      tokenId: options.tokenId,
      spenderId: options.spenderId,
      mirrorNodeUrl: options.mirrorNodeUrl,
    });
    if (visible >= BigInt(options.required)) break;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return tx;
}
