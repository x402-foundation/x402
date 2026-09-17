import type { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { encodeFunctionData, getAddress } from "viem";
import type { FacilitatorHederaBatchSigner } from "../signer";
import type {
  AuthorizerSigner,
  BatchSettlementEnrichedRefundPayload,
  ChannelState,
} from "../types";
import { batchSettlementABI } from "../abi";
import {
  CHANNEL_STATE_POLL_MS,
  CHANNEL_STATE_POLL_INTERVAL_MS,
  HEDERA_GAS,
  getBatchSettlementDeployment,
} from "../constants";
import { computeChannelId } from "../utils";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import * as Errors from "../errors";
import { runContractSettlement, truncate } from "../transport";
import { buildVoucherClaimArgs, claimGasFor } from "./claim";
import { readChannelState, resolveTokenId, toContractChannelConfig } from "./utils";

/** Options for refund execution. */
export type RefundExecutionOptions = {
  simulateBeforeSend?: boolean;
  gas?: bigint;
};

type RefundSettlementExtra = {
  channelState: {
    channelId: `0x${string}`;
    balance: string;
    totalClaimed: string;
    withdrawRequestedAt: number;
    refundNonce: string;
  };
};

type RefundSettlementDetails = {
  amount: string;
  extra: RefundSettlementExtra;
};

/**
 * Computes the token amount that `refundWithSignature` would transfer after any bundled
 * claims are applied.
 *
 * @param payload - Refund payload containing requested refund amount and claims.
 * @param preState - Onchain channel state before the refund transaction.
 * @param channelId - Channel being refunded.
 * @param network - Network identifier used to compute claim channel ids.
 * @returns Refund amount if determinable, or `null` when claim data should be left to simulation.
 */
function getRefundableAmount(
  payload: BatchSettlementEnrichedRefundPayload,
  preState: ChannelState,
  channelId: `0x${string}`,
  network: string,
): bigint | null {
  const postClaimTotalClaimed = payload.claims.reduce((max, claim) => {
    const claimChannelId = computeChannelId(claim.voucher.channel, network);
    if (claimChannelId.toLowerCase() !== channelId.toLowerCase()) {
      return max;
    }
    const totalClaimed = BigInt(claim.totalClaimed);
    return totalClaimed > max ? totalClaimed : max;
  }, preState.totalClaimed);

  if (postClaimTotalClaimed > preState.balance) {
    return null;
  }

  const requestedAmount = BigInt(payload.amount);
  if (requestedAmount === 0n) {
    return null;
  }

  const available = preState.balance - postClaimTotalClaimed;
  return requestedAmount > available ? available : requestedAmount;
}

/**
 * Builds response details for a refund settlement from the pre-transaction state.
 *
 * @param payload - Refund payload containing claims and amount.
 * @param channelId - Canonical channel id for the refund.
 * @param preState - Onchain channel state before this refund, or null if unknown.
 * @returns Actual refund amount and extra fields for the settlement response.
 */
function buildRefundExtra(
  payload: BatchSettlementEnrichedRefundPayload,
  channelId: `0x${string}`,
  preState: ChannelState | null,
): RefundSettlementDetails {
  const preTotalClaimed = preState?.totalClaimed ?? 0n;
  const preBalance = preState?.balance ?? 0n;

  const lastClaimTotal =
    payload.claims.length > 0
      ? BigInt(payload.claims[payload.claims.length - 1].totalClaimed)
      : preTotalClaimed;
  const postClaimTotalClaimed = lastClaimTotal > preTotalClaimed ? lastClaimTotal : preTotalClaimed;

  const available = preBalance - postClaimTotalClaimed;
  const requestedAmount = BigInt(payload.amount);
  const actualRefund = requestedAmount > available ? available : requestedAmount;

  return {
    amount: actualRefund.toString(),
    extra: {
      channelState: {
        channelId,
        balance: (preBalance - actualRefund).toString(),
        totalClaimed: postClaimTotalClaimed.toString(),
        withdrawRequestedAt: 0,
        refundNonce: String((preState?.refundNonce ?? 0n) + 1n),
      },
    },
  };
}

/**
 * Reads the post-refund state once the Mirror Node reflects the advanced nonce.
 *
 * @param signer - Facilitator signer used for onchain reads.
 * @param channelId - Channel that was refunded.
 * @param submittedNonce - Nonce used for this refund transaction.
 * @param network - CAIP-2 network.
 * @returns Fresh channel state once the nonce advances, or `null` if reads lag.
 */
async function readPostRefundState(
  signer: FacilitatorHederaBatchSigner,
  channelId: `0x${string}`,
  submittedNonce: string,
  network: string,
): Promise<ChannelState | null> {
  const expectedNonce = BigInt(submittedNonce) + 1n;
  const deadline = Date.now() + CHANNEL_STATE_POLL_MS;

  do {
    let state: ChannelState;
    try {
      state = await readChannelState(signer, channelId, network);
    } catch {
      return null;
    }
    if (state.refundNonce >= expectedNonce) {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, CHANNEL_STATE_POLL_INTERVAL_MS));
  } while (Date.now() < deadline);

  return null;
}

/**
 * Builds refund response details from confirmed post-transaction state.
 *
 * @param channelId - Canonical channel id for the refund.
 * @param preState - Onchain state read before the transaction.
 * @param postState - Onchain state after the transaction.
 * @returns Actual refund amount and extra fields for the settlement response.
 */
function buildRefundExtraFromPostState(
  channelId: `0x${string}`,
  preState: ChannelState,
  postState: ChannelState,
): RefundSettlementDetails {
  const actualRefund =
    preState.balance > postState.balance ? preState.balance - postState.balance : 0n;

  return {
    amount: actualRefund.toString(),
    extra: {
      channelState: {
        channelId,
        balance: postState.balance.toString(),
        totalClaimed: postState.totalClaimed.toString(),
        withdrawRequestedAt: postState.withdrawRequestedAt,
        refundNonce: postState.refundNonce.toString(),
      },
    },
  };
}

/**
 * Executes a cooperative refund via `refundWithSignature`, bundling any outstanding claim
 * through the contract's `multicall` so both apply atomically.
 *
 * When `refundAuthorizerSignature` / `claimAuthorizerSignature` are present they are used
 * directly. When absent the facilitator signs the missing digests using `authorizerSigner`,
 * after verifying that `config.receiverAuthorizer` matches `authorizerSigner.address`.
 *
 * @param signer - Facilitator signer used to submit the onchain transaction.
 * @param payload - Refund payload with optional signatures, amount, and nonce.
 * @param requirements - Payment requirements for network identification.
 * @param authorizerSigner - Optional dedicated key for producing signatures.
 * @param options - Simulation / gas options.
 * @returns A {@link SettleResponse} with the transaction id on success.
 */
export async function executeRefundWithSignature(
  signer: FacilitatorHederaBatchSigner,
  payload: BatchSettlementEnrichedRefundPayload,
  requirements: PaymentRequirements,
  authorizerSigner: AuthorizerSigner | undefined,
  options: RefundExecutionOptions = {},
): Promise<SettleResponse> {
  const network = requirements.network;
  const payer = payload.channelConfig.payer;

  try {
    const channelId = computeChannelId(payload.channelConfig, network);
    const preState = await readChannelState(signer, channelId, network);
    const contractAddr = getAddress(getBatchSettlementDeployment(network).settlement);
    const refundableAmount = getRefundableAmount(payload, preState, channelId, network);

    if (refundableAmount === 0n) {
      return {
        success: false,
        errorReason: Errors.ErrRefundNoBalance,
        errorMessage: "Nothing to refund",
        transaction: "",
        network,
        payer,
      };
    }

    const hasClientSig = payload.refundAuthorizerSignature !== undefined;

    if (!hasClientSig && !authorizerSigner) {
      return {
        success: false,
        errorReason: Errors.ErrAuthorizerNotConfigured,
        transaction: "",
        network,
        payer,
      };
    }

    if (
      !hasClientSig &&
      authorizerSigner &&
      getAddress(payload.channelConfig.receiverAuthorizer) !== getAddress(authorizerSigner.address)
    ) {
      return {
        success: false,
        errorReason: Errors.ErrAuthorizerAddressMismatch,
        transaction: "",
        network,
        payer,
      };
    }

    // The payer must be able to receive the refunded HTS token.
    const tokenId = resolveTokenId(payload.channelConfig.token);
    if (tokenId && !(await signer.mirror.canReceiveToken(payer, tokenId))) {
      return {
        success: false,
        errorReason: Errors.ErrTokenNotAssociated,
        errorMessage: `payer ${payer} is not associated with ${tokenId}`,
        transaction: "",
        network,
        payer,
      };
    }

    const refundSig =
      payload.refundAuthorizerSignature ??
      (await signRefund(
        authorizerSigner!,
        channelId,
        payload.amount,
        payload.refundNonce,
        network,
      ));

    const refundArgs = [
      toContractChannelConfig(payload.channelConfig),
      BigInt(payload.amount),
      BigInt(payload.refundNonce),
      refundSig,
    ] as const;

    let functionName: "multicall" | "refundWithSignature";
    let args: readonly unknown[];
    let gas = options.gas ?? HEDERA_GAS.refund;

    if (payload.claims.length > 0) {
      let claimSig = payload.claimAuthorizerSignature;
      if (!claimSig) {
        if (!authorizerSigner) {
          return {
            success: false,
            errorReason: Errors.ErrAuthorizerNotConfigured,
            transaction: "",
            network,
            payer,
          };
        }
        claimSig = await signClaimBatch(authorizerSigner, payload.claims, network);
      }
      const claimCalldata = encodeFunctionData({
        abi: batchSettlementABI,
        functionName: "claimWithSignature",
        args: [buildVoucherClaimArgs(payload.claims), claimSig],
      });
      const refundCalldata = encodeFunctionData({
        abi: batchSettlementABI,
        functionName: "refundWithSignature",
        args: refundArgs,
      });
      functionName = "multicall";
      args = [[claimCalldata, refundCalldata]];
      if (options.gas === undefined) {
        gas = HEDERA_GAS.refund + claimGasFor(payload.claims.length);
      }
    } else {
      functionName = "refundWithSignature";
      args = refundArgs;
    }

    if (options.simulateBeforeSend ?? true) {
      try {
        await signer.simulateContract({
          address: contractAddr,
          abi: batchSettlementABI,
          functionName,
          args,
        });
      } catch (e) {
        return {
          success: false,
          errorReason: Errors.ErrRefundSimulationFailed,
          errorMessage: truncate(e instanceof Error ? e.message : String(e)),
          transaction: "",
          network,
          payer,
        };
      }
    }

    return await runContractSettlement(
      () =>
        signer.executeContract({
          address: contractAddr,
          abi: batchSettlementABI,
          functionName,
          args,
          gas,
        }),
      network,
      payer,
      {
        failedStatusReason: Errors.ErrRefundTransactionFailed,
        onSuccess: async result => {
          const postState =
            preState.withdrawRequestedAt !== 0
              ? await readPostRefundState(signer, channelId, payload.refundNonce, network)
              : null;
          const refundDetails = postState
            ? buildRefundExtraFromPostState(channelId, preState, postState)
            : buildRefundExtra(payload, channelId, preState);

          return {
            success: true,
            transaction: result.transactionId,
            network,
            payer,
            amount: refundDetails.amount,
            extra: refundDetails.extra,
          };
        },
      },
    );
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrRefundTransactionFailed,
      errorMessage: truncate(e instanceof Error ? e.message : String(e)),
      transaction: "",
      network,
      payer,
    };
  }
}
