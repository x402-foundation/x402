import type { KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  SCHEMA,
  type Action,
  type SignedDelegate,
  actionCreators,
  createTransaction,
} from "@near-js/transactions";
import { baseDecode } from "@near-js/utils";
import { deserialize } from "borsh";
import type { FacilitatorNearSigner, NearStorageBalanceResult } from "../signer";
import type {
  NearAccessKeyPermissionKind,
  NearAccessKeyView,
  NearAccountView,
  NearReceiptStatus,
  NearSettlementOutcome,
} from "../types";
import { fromBase64 } from "../utils";
import { type RpcUrlOverrides, createProviderFactory } from "./provider";

/**
 * A relayer account this facilitator controls.
 */
export type FacilitatorRelayerConfig = {
  accountId: string;
  /** Full-access secret key for the relayer, e.g. `ed25519:...`. */
  secretKey: KeyPairString;
};

/**
 * Configuration for the reference NEAR facilitator signer.
 */
export type FacilitatorNearSignerConfig = {
  /** One or more relayer accounts that sponsor settlement. */
  relayers: FacilitatorRelayerConfig[];
  /** Optional per-network RPC endpoint overrides. */
  rpcUrls?: RpcUrlOverrides;
};

/**
 * Best-effort classification of "account/key/method does not exist" errors so
 * the scheme can map them to `null`/`unsupported` rather than failing closed on
 * a benign "not found". Genuine RPC/transport errors are rethrown.
 *
 * @param error - The thrown value to classify.
 * @returns A normalized string form used for substring matching.
 */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}:${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const isAccountMissing = (e: unknown): boolean =>
  /UNKNOWN_ACCOUNT|does ?n.t exist|doesn't exist|does not exist/i.test(errorText(e));

const isAccessKeyMissing = (e: unknown): boolean =>
  /UNKNOWN_ACCESS_KEY|access key .* (not found|does not exist|doesn't exist)/i.test(errorText(e));

const isMethodNotFound = (e: unknown): boolean =>
  /MethodNotFound|MethodResolveError|MethodEmptyName/i.test(errorText(e));

const normalizeAccessKeyPermission = (permission: unknown): NearAccessKeyPermissionKind => {
  if (permission === "FullAccess") {
    return "FullAccess";
  }

  if (typeof permission === "object" && permission !== null) {
    if ("FunctionCall" in permission || "functionCall" in permission) {
      return "FunctionCall";
    }
  }

  return "Unknown";
};

/**
 * Subset of a final execution outcome that settlement inspects.
 */
type FinalExecutionOutcomeLike = {
  status: unknown;
  receipts_outcome?: Array<{ outcome?: { executor_id?: string; status?: unknown } }>;
};

/**
 * Interprets a final execution outcome for §7 settlement.
 *
 * Success requires observing a token-contract receipt with `SuccessValue`.
 * Outer transaction acceptance, outer transaction success, or lack of visible
 * receipt failures is not enough to release the protected resource.
 *
 * @param outcome - The final execution outcome from `sendTransactionUntil`.
 * @param tokenContractId - Token contract account expected to execute the inner `ft_transfer`.
 * @returns The inner-receipt status.
 */
export function interpretSettlementOutcome(
  outcome: FinalExecutionOutcomeLike,
  tokenContractId: string,
): NearReceiptStatus {
  const hasFailure = (status: unknown): boolean =>
    typeof status === "object" &&
    status !== null &&
    "Failure" in status &&
    Boolean((status as { Failure?: unknown }).Failure);

  if (hasFailure(outcome.status)) {
    return {
      kind: "failure",
      error: JSON.stringify((outcome.status as { Failure: unknown }).Failure),
    };
  }
  for (const receipt of outcome.receipts_outcome ?? []) {
    if (hasFailure(receipt.outcome?.status)) {
      return {
        kind: "failure",
        error: JSON.stringify((receipt.outcome!.status as { Failure: unknown }).Failure),
      };
    }
  }

  const tokenReceipt = (outcome.receipts_outcome ?? []).find(
    receipt => receipt.outcome?.executor_id === tokenContractId,
  );
  const tokenStatus = tokenReceipt?.outcome?.status;

  if (typeof tokenStatus === "object" && tokenStatus !== null && "SuccessValue" in tokenStatus) {
    return {
      kind: "success",
      value: (tokenStatus as { SuccessValue?: string }).SuccessValue ?? "",
    };
  }

  return { kind: "failure", error: "inner_ft_transfer_receipt_not_successful" };
}

/**
 * Backwards-compatible alias for older local tests/imports.
 *
 * @param outcome - The final execution outcome from `sendTransactionUntil`.
 * @param tokenContractId - Token contract account expected to execute the inner `ft_transfer`.
 * @returns The inner-receipt status.
 */
export function interpretOutcome(
  outcome: FinalExecutionOutcomeLike,
  tokenContractId: string,
): NearReceiptStatus {
  return interpretSettlementOutcome(outcome, tokenContractId);
}

/**
 * Reference {@link FacilitatorNearSigner} backed by NEAR JSON-RPC.
 *
 * Provides the chain-state reads required by verification (§5/§8/§9) pinned to
 * final finality, and a settlement path that wraps the client's
 * `SignedDelegate` in an outer relayer transaction (`Action::Delegate`), submits
 * it with `wait_until: "FINAL"`, and reports the inner `ft_transfer` receipt
 * status (§7).
 *
 * @param config - Relayer accounts and optional RPC configuration.
 * @returns A facilitator signer suitable for {@link ExactNearScheme}.
 */
export function createFacilitatorNearSigner(
  config: FacilitatorNearSignerConfig,
): FacilitatorNearSigner {
  const getProvider = createProviderFactory(config.rpcUrls);
  const relayers = config.relayers.map(relayer => ({
    accountId: relayer.accountId,
    signer: KeyPairSigner.fromSecretKey(relayer.secretKey),
  }));
  const relayerById = new Map(relayers.map(relayer => [relayer.accountId, relayer]));

  return {
    getRelayerIds(): readonly string[] {
      return relayers.map(relayer => relayer.accountId);
    },

    async getCurrentBlockHeight(network: string): Promise<bigint> {
      const block = await getProvider(network).block({ finality: "final" });
      return BigInt(block.header.height);
    },

    async viewAccount({ network, accountId }): Promise<NearAccountView | null> {
      try {
        const account = await getProvider(network).viewAccount(accountId, { finality: "final" });
        return { codeHash: account.code_hash };
      } catch (error) {
        if (isAccountMissing(error)) {
          return null;
        }
        throw error;
      }
    },

    async viewAccessKey({ network, accountId, publicKey }): Promise<NearAccessKeyView | null> {
      try {
        const accessKey = await getProvider(network).viewAccessKey(accountId, publicKey, {
          finality: "final",
        });
        const permissionKind = normalizeAccessKeyPermission(accessKey.permission);
        return { nonce: BigInt(accessKey.nonce), permissionKind };
      } catch (error) {
        if (isAccessKeyMissing(error)) {
          return null;
        }
        throw error;
      }
    },

    async ftBalanceOf({ network, token, accountId }): Promise<bigint> {
      const result = await getProvider(network).callFunction(
        token,
        "ft_balance_of",
        { account_id: accountId },
        { finality: "final" },
      );
      if (typeof result !== "string" || !/^\d+$/.test(result)) {
        throw new Error("invalid_ft_balance_of_result");
      }
      return BigInt(result);
    },

    async storageBalanceOf({ network, token, accountId }): Promise<NearStorageBalanceResult> {
      try {
        const result = await getProvider(network).callFunction(
          token,
          "storage_balance_of",
          { account_id: accountId },
          { finality: "final" },
        );
        return { supported: true, registered: result != null };
      } catch (error) {
        if (isMethodNotFound(error)) {
          return { supported: false };
        }
        throw error;
      }
    },

    async submitSignedDelegateAction({
      network,
      relayerId,
      signedDelegateAction,
    }): Promise<NearSettlementOutcome> {
      const relayer = relayerById.get(relayerId);
      if (!relayer) {
        throw new Error(`unknown_relayer:${relayerId}`);
      }
      const provider = getProvider(network);

      // Decode the client SignedDelegate to wrap it and to address the outer
      // transaction to the delegate sender (NEP-366).
      const decoded = deserialize(SCHEMA.SignedDelegate, fromBase64(signedDelegateAction)) as {
        delegateAction: { receiverId: string; senderId: string };
      } & SignedDelegate;
      const tokenContractId = decoded.delegateAction.receiverId;
      const senderId = decoded.delegateAction.senderId;

      const publicKey = await relayer.signer.getPublicKey();
      const [accessKey, block] = await Promise.all([
        provider.viewAccessKey(relayer.accountId, publicKey, { finality: "final" }),
        provider.block({ finality: "final" }),
      ]);

      const delegateActionWrapper: Action = actionCreators.signedDelegate(decoded);
      const transaction = createTransaction(
        relayer.accountId,
        publicKey,
        senderId,
        BigInt(accessKey.nonce) + 1n,
        [delegateActionWrapper],
        baseDecode(block.header.hash),
      );

      const [, signedTransaction] = await relayer.signer.signTransaction(transaction);
      const outcome = await provider.sendTransactionUntil(signedTransaction, "FINAL");

      return {
        transaction: outcome.transaction_outcome.id,
        innerReceipt: interpretSettlementOutcome(outcome, tokenContractId),
      };
    },
  };
}
