import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { InMemoryPendingSettlementStore, PendingSettlementStore } from "@x402/core/facilitator";
import { getAddress } from "viem";
import type { FacilitatorHederaBatchSigner } from "../signer";
import type { BatchSettlementDepositPayload } from "../types";
import { batchSettlementABI } from "../abi";
import {
  CHANNEL_STATE_POLL_MS,
  CHANNEL_STATE_POLL_INTERVAL_MS,
  HEDERA_GAS,
  HTS_ALLOWANCE_TRANSFER_METHOD,
  getBatchSettlementDeployment,
} from "../constants";
import * as Errors from "../errors";
import {
  HederaContractRevertError,
  runContractSettlement,
  truncate,
  withPendingSettlementStore,
} from "../transport";
import {
  readChannelState,
  readTokenBalance,
  resolveTokenId,
  signatureCheckErrorCode,
  toContractChannelConfig,
  validateChannelConfig,
  verifyVoucherSignature,
} from "./utils";
import {
  buildHederaAllowanceDepositCollectorData,
  getHederaAllowanceCollectorAddress,
  verifyHederaAllowanceAuthorization,
} from "./deposit-hederaAllowance";

/** Facilitator options that affect deposit handling. */
export type DepositExecutionOptions = {
  /**
   * How long to poll the Mirror Node after a confirmed deposit before answering with the
   * optimistic state (default `CHANNEL_STATE_POLL_MS`). `0` skips the read entirely: the
   * transaction has reached consensus, so `balance + amount` is already the truth on chain.
   */
  pollMs?: number;
  /** Run a Mirror Node simulation of `deposit` before accepting/broadcasting (default true). */
  simulateBeforeSend?: boolean;
  /** Gas limit override for the deposit transaction. */
  gas?: bigint;
};

/**
 * Verifies a deposit payload (allowance authorization + voucher) without executing any
 * onchain transaction.
 *
 * Performs the following validations:
 * - Channel config binds to the claimed channel id and matches the payment requirements.
 * - `assetTransferMethod` is `hts-allowance` (the only Hedera method).
 * - The allowance authorization is well-formed, unexpired, unused, signed by the payer, and
 *   backed by an HTS allowance to the collector.
 * - The accompanying voucher signature is valid.
 * - The payer has sufficient token balance and the escrow can hold the token.
 * - `maxClaimableAmount` fits the effective balance and exceeds `totalClaimed`.
 * - The deposit call simulates successfully (unless disabled).
 *
 * @param signer - Facilitator signer for onchain reads and signature verification.
 * @param payment - Full payment envelope.
 * @param payload - The full deposit payload.
 * @param requirements - Server payment requirements.
 * @param options - Simulation / gas options.
 * @returns A {@link VerifyResponse} with channel state in `extra` on success.
 */
export async function verifyDeposit(
  signer: FacilitatorHederaBatchSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  options: DepositExecutionOptions = {},
): Promise<VerifyResponse> {
  void payment;
  const payer = payload.channelConfig.payer;

  const configErr = validateChannelConfig(
    payload.channelConfig,
    payload.voucher.channelId,
    requirements,
  );
  if (configErr) {
    return { isValid: false, invalidReason: configErr, payer };
  }

  const method = requirements.extra?.assetTransferMethod ?? HTS_ALLOWANCE_TRANSFER_METHOD;
  if (method !== HTS_ALLOWANCE_TRANSFER_METHOD) {
    return { isValid: false, invalidReason: Errors.ErrUnsupportedAssetTransferMethod, payer };
  }

  const authErr = await verifyHederaAllowanceAuthorization(signer, payload, requirements);
  if (authErr) {
    return authErr;
  }

  const shared = await verifySharedDepositState(signer, payload, requirements);
  if (!shared.ok) {
    return shared.response;
  }
  const { depositAmount, chBalance, chTotalClaimed, wdInitiatedAt, refundNonceVal } = shared;

  if (options.simulateBeforeSend ?? true) {
    try {
      await signer.simulateContract({
        address: getAddress(getBatchSettlementDeployment(requirements.network).settlement),
        abi: batchSettlementABI,
        functionName: "deposit",
        args: [
          toContractChannelConfig(payload.channelConfig),
          depositAmount,
          getHederaAllowanceCollectorAddress(requirements.network),
          buildHederaAllowanceDepositCollectorData(payload),
        ],
      });
    } catch (e) {
      return {
        isValid: false,
        invalidReason: Errors.ErrDepositSimulationFailed,
        invalidMessage: e instanceof Error ? e.message : String(e),
        payer,
      };
    }
  }

  return {
    isValid: true,
    payer,
    extra: {
      channelId: payload.voucher.channelId,
      balance: chBalance.toString(),
      totalClaimed: chTotalClaimed.toString(),
      withdrawRequestedAt: Number(wdInitiatedAt),
      refundNonce: refundNonceVal.toString(),
    },
  };
}

/**
 * Verifies voucher, balance, association and cumulative amount invariants.
 *
 * @param signer - Facilitator signer for reads and voucher verification.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @returns Shared channel state on success, or a verification failure.
 */
async function verifySharedDepositState(
  signer: FacilitatorHederaBatchSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
): Promise<
  | {
      ok: true;
      depositAmount: bigint;
      payer: `0x${string}`;
      chBalance: bigint;
      chTotalClaimed: bigint;
      wdInitiatedAt: bigint;
      refundNonceVal: bigint;
    }
  | { ok: false; response: VerifyResponse }
> {
  const { deposit, voucher } = payload;
  const config = payload.channelConfig;
  const payer = config.payer;
  const network = requirements.network;

  const sigCheck = await verifyVoucherSignature(
    signer,
    {
      channelId: voucher.channelId,
      maxClaimableAmount: voucher.maxClaimableAmount,
      payerAuthorizer: config.payerAuthorizer,
      payer: config.payer,
      signature: voucher.signature,
    },
    network,
  );
  if (!sigCheck.ok) {
    return {
      ok: false,
      response: {
        isValid: false,
        invalidReason: signatureCheckErrorCode(sigCheck, Errors.ErrInvalidVoucherSignature),
        invalidMessage: sigCheck.message,
        payer,
      },
    };
  }

  let state;
  let payerBalance: bigint;
  try {
    [state, payerBalance] = await Promise.all([
      readChannelState(signer, voucher.channelId, network),
      readTokenBalance(signer, config.token, payer),
    ]);
  } catch (error) {
    return {
      ok: false,
      response: {
        isValid: false,
        invalidReason: Errors.ErrRpcReadFailed,
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer,
      },
    };
  }

  const depositAmount = BigInt(deposit.amount);
  if (payerBalance < depositAmount) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrInsufficientBalance, payer },
    };
  }

  // The escrow must be associated with the HTS token (or have auto-association capacity).
  const tokenId = resolveTokenId(requirements.asset) ?? resolveTokenId(config.token);
  if (tokenId) {
    try {
      const deployment = getBatchSettlementDeployment(network);
      const ok = await signer.mirror.canReceiveToken(deployment.settlementId, tokenId);
      if (!ok) {
        return {
          ok: false,
          response: {
            isValid: false,
            invalidReason: Errors.ErrTokenNotAssociated,
            invalidMessage: `escrow ${deployment.settlementId} is not associated with ${tokenId}`,
            payer,
          },
        };
      }
    } catch (error) {
      return {
        ok: false,
        response: {
          isValid: false,
          invalidReason: Errors.ErrRpcReadFailed,
          invalidMessage: error instanceof Error ? error.message : String(error),
          payer,
        },
      };
    }
  }

  const effectiveBalance = state.balance + depositAmount;
  const maxClaimableAmount = BigInt(voucher.maxClaimableAmount);

  if (maxClaimableAmount > effectiveBalance) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrCumulativeExceedsBalance, payer },
    };
  }

  if (maxClaimableAmount <= state.totalClaimed) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrCumulativeAmountBelowClaimed, payer },
    };
  }

  return {
    ok: true,
    depositAmount,
    payer,
    chBalance: state.balance,
    chTotalClaimed: state.totalClaimed,
    wdInitiatedAt: BigInt(state.withdrawRequestedAt),
    refundNonceVal: state.refundNonce,
  };
}

/**
 * Returns the unique-per-payload key used for the `PendingSettlementStore`: the payer's
 * allowance authorization signature.
 *
 * @param payload - Batch deposit payload.
 * @returns The pending-settlement store key, or `undefined` when unavailable.
 */
function depositSettlementCacheKey(payload: BatchSettlementDepositPayload): string | undefined {
  return payload.deposit.authorization.hederaAllowanceAuthorization?.signature;
}

/**
 * Builds the `extra.channelState` snapshot for deposit responses.
 *
 * @param channelId - Channel id.
 * @param state - Channel state fields.
 * @param state.balance - Escrow balance.
 * @param state.totalClaimed - Claimed total.
 * @param state.withdrawRequestedAt - Pending withdrawal timestamp.
 * @param state.refundNonce - Refund nonce.
 * @returns Extra object.
 */
function channelStateExtra(
  channelId: `0x${string}`,
  state: {
    balance: bigint;
    totalClaimed: bigint;
    withdrawRequestedAt: number;
    refundNonce: bigint;
  },
): Record<string, unknown> {
  return {
    channelState: {
      channelId,
      balance: state.balance.toString(),
      totalClaimed: state.totalClaimed.toString(),
      withdrawRequestedAt: state.withdrawRequestedAt,
      refundNonce: state.refundNonce.toString(),
    },
  };
}

/**
 * Handles a `PendingSettlementStore` cache hit for {@link settleDeposit}: a prior call already
 * submitted `cachedTx` (its nonce is consumed onchain, so re-submitting would revert) but could
 * not confirm it. Reconciles against the current onchain state instead.
 *
 * @param signer - Facilitator signer.
 * @param payload - The deposit payload.
 * @param requirements - Server payment requirements.
 * @param cachedTx - The previously submitted Hedera transaction id.
 * @param store - Pending-settlement store to update.
 * @param cacheKey - The key this deposit is cached under.
 * @returns A {@link SettleResponse} reconciled against the cached transaction.
 */
async function reconcilePendingDeposit(
  signer: FacilitatorHederaBatchSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  cachedTx: string,
  store: PendingSettlementStore,
  cacheKey: string,
): Promise<SettleResponse> {
  const { deposit, voucher } = payload;
  const payer = payload.channelConfig.payer;
  const network = requirements.network;

  return withPendingSettlementStore(store, cacheKey, async () => {
    let result;
    try {
      result = await signer.mirror.getContractResult(cachedTx);
    } catch (error) {
      return {
        success: false,
        errorReason: Errors.ErrSettlementPending,
        errorMessage: truncate(error instanceof Error ? error.message : String(error)),
        transaction: cachedTx,
        network,
        payer,
      };
    }

    if (result.status !== "0x1" && result.status !== "SUCCESS") {
      return {
        success: false,
        errorReason: Errors.ErrDepositTransactionFailed,
        errorMessage: result.error_message ?? `status ${result.status}`,
        transaction: cachedTx,
        network,
        payer,
      };
    }

    let extra: Record<string, unknown> | undefined;
    try {
      const state = await readChannelState(signer, voucher.channelId, network);
      extra = channelStateExtra(voucher.channelId, state);
    } catch {
      // The transaction is confirmed; the snapshot is best-effort.
    }
    return {
      success: true,
      transaction: cachedTx,
      network,
      payer,
      amount: deposit.amount,
      ...(extra ? { extra } : {}),
    };
  });
}

/**
 * Executes a deposit onchain through the HTS-allowance collector.
 *
 * The deposit is first verified via {@link verifyDeposit}; if invalid the returned
 * {@link SettleResponse} will have `success: false` with the verification reason.
 *
 * `store` is consulted first (keyed by the allowance signature) to reconcile a
 * previously-submitted-but-unconfirmed deposit from a prior `settlement_pending` response.
 *
 * @param signer - Facilitator signer used to submit the onchain transaction.
 * @param payment - Full payment envelope.
 * @param payload - The deposit payload.
 * @param requirements - Server payment requirements.
 * @param options - Simulation / gas options.
 * @param store - Pending-settlement store (defaults to a fresh in-memory store).
 * @returns A {@link SettleResponse} with the transaction id and updated channel state in `extra`.
 */
export async function settleDeposit(
  signer: FacilitatorHederaBatchSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  options: DepositExecutionOptions = {},
  store: PendingSettlementStore = new InMemoryPendingSettlementStore(),
): Promise<SettleResponse> {
  const { deposit, voucher } = payload;
  const config = payload.channelConfig;
  const payer = config.payer;
  const network = requirements.network;

  const cacheKey = depositSettlementCacheKey(payload);
  if (cacheKey) {
    const cachedTx = await store.get(cacheKey);
    if (cachedTx) {
      await store.delete(cacheKey);
      return reconcilePendingDeposit(signer, payload, requirements, cachedTx, store, cacheKey);
    }
  }

  const verified = await verifyDeposit(signer, payment, payload, requirements, options);
  if (!verified.isValid) {
    const reason = verified.invalidReason ?? Errors.ErrInvalidPayloadType;
    return {
      success: false,
      errorReason: reason,
      errorMessage: verified.invalidMessage ?? reason,
      transaction: "",
      network,
      payer: verified.payer,
    };
  }

  const deployment = getBatchSettlementDeployment(network);
  let collectorData: `0x${string}`;
  try {
    collectorData = buildHederaAllowanceDepositCollectorData(payload);
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrAllowanceAuthorizationRequired,
      errorMessage: truncate(e instanceof Error ? e.message : String(e)),
      transaction: "",
      network,
      payer,
    };
  }

  return withPendingSettlementStore(store, cacheKey, () =>
    runContractSettlement(
      () =>
        signer.executeContract({
          address: getAddress(deployment.settlement),
          abi: batchSettlementABI,
          functionName: "deposit",
          args: [
            toContractChannelConfig(config),
            BigInt(deposit.amount),
            getAddress(deployment.collector),
            collectorData,
          ],
          gas: options.gas ?? HEDERA_GAS.deposit,
        }),
      network,
      payer,
      {
        failedStatusReason: Errors.ErrDepositTransactionFailed,
        onSuccess: async result => {
          const optimistic = {
            balance: BigInt(String(verified.extra?.balance ?? "0")) + BigInt(deposit.amount),
            totalClaimed: BigInt(String(verified.extra?.totalClaimed ?? "0")),
            withdrawRequestedAt: Number(verified.extra?.withdrawRequestedAt ?? 0),
            refundNonce: BigInt(String(verified.extra?.refundNonce ?? "0")),
          };
          let extra = channelStateExtra(voucher.channelId, optimistic);

          // Poll until the Mirror Node reflects the confirmed deposit so later verify reads see it.
          // Servers that verify vouchers locally can set `pollMs: 0` and skip the wait.
          const pollMs = options.pollMs ?? CHANNEL_STATE_POLL_MS;
          if (pollMs > 0) {
            const deadline = Date.now() + pollMs;
            try {
              let postState = await readChannelState(signer, voucher.channelId, network);
              while (postState.balance < optimistic.balance && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, CHANNEL_STATE_POLL_INTERVAL_MS));
                postState = await readChannelState(signer, voucher.channelId, network);
              }
              if (postState.balance >= optimistic.balance) {
                extra = channelStateExtra(voucher.channelId, postState);
              }
            } catch {
              // Keep the optimistic snapshot when post-deposit reads fail.
            }
          }

          return {
            success: true,
            transaction: result.transactionId,
            network,
            payer,
            amount: deposit.amount,
            extra,
          };
        },
      },
    ),
  ).catch(e => ({
    success: false,
    errorReason: Errors.ErrDepositTransactionFailed,
    errorMessage: truncate(e instanceof Error ? e.message : String(e)),
    transaction: e instanceof HederaContractRevertError ? (e.transactionId ?? "") : "",
    network,
    payer,
  }));
}
