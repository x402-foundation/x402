import {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
} from "@x402/core/types";
import { encodeFunctionData, getAddress } from "viem";
import {
  extractEip2612GasSponsoringInfo,
  extractErc20ApprovalGasSponsoringInfo,
  ERC20_APPROVAL_GAS_SPONSORING_KEY,
  resolveErc20ApprovalExtensionSigner,
  type Eip2612GasSponsoringInfo,
  type Erc20ApprovalGasSponsoringFacilitatorExtension,
  type Erc20ApprovalGasSponsoringSigner,
} from "../../exact/extensions";
import { validateErc20ApprovalForPayment } from "../../shared/erc20approval";
import { validateEip2612PermitForPayment, splitEip2612Signature } from "../../shared/permit2";
import { PERMIT2_ADDRESS, erc20AllowanceAbi } from "../../constants";
import { FacilitatorEvmSigner } from "../../signer";
import { batchSettlementABI } from "../abi";
import {
  BATCH_SETTLEMENT_ADDRESS,
  PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
  batchPermit2WitnessTypes,
} from "../constants";
import { buildEip2612PermitData, buildPermit2CollectorData } from "../encoding";
import { BatchSettlementDepositPayload } from "../types";
import { toContractChannelConfig } from "./utils";
import * as Errors from "../errors";

export type Permit2DepositBranch =
  | {
      kind: "standard";
      collectorData: `0x${string}`;
    }
  | {
      kind: "eip2612";
      collectorData: `0x${string}`;
    }
  | {
      kind: "erc20Approval";
      collectorData: `0x${string}`;
      signedTransaction: `0x${string}`;
      extensionSigner: Erc20ApprovalGasSponsoringSigner;
    };

/**
 * Returns the collector contract used for Permit2 deposits.
 *
 * @returns Permit2 deposit collector address.
 */
export function getPermit2DepositCollectorAddress(): `0x${string}` {
  return getAddress(PERMIT2_DEPOSIT_COLLECTOR_ADDRESS);
}

/**
 * Encodes collector data for a Permit2 deposit payload.
 *
 * @param payload - Deposit payload containing the Permit2 authorization.
 * @param eip2612PermitData - Optional encoded EIP-2612 permit segment.
 * @returns ABI-encoded collector data.
 */
export function buildPermit2DepositCollectorData(
  payload: BatchSettlementDepositPayload,
  eip2612PermitData: `0x${string}` = "0x",
): `0x${string}` {
  const auth = payload.deposit.authorization.permit2Authorization;
  if (!auth) {
    throw new Error(Errors.ErrPermit2AuthorizationRequired);
  }

  return buildPermit2CollectorData(auth.nonce, auth.deadline, auth.signature, eip2612PermitData);
}

/**
 * Verifies Permit2 authorization fields, setup branch, and approval-bundle simulation.
 *
 * @param signer - Facilitator signer for reads and signature verification.
 * @param payment - Full payment envelope containing optional extensions.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @param chainId - EVM chain id.
 * @param context - Optional facilitator extension context.
 * @returns A failure response, or `null` when valid.
 */
export async function verifyPermit2DepositAuthorization(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  chainId: number,
  context?: FacilitatorContext,
): Promise<VerifyResponse | null> {
  const authResult = await verifyPermit2TypedData(signer, payload, requirements, chainId);
  if (authResult) {
    return authResult;
  }

  const branchResult = await resolvePermit2DepositBranch(
    signer,
    payment,
    payload,
    requirements,
    context,
  );
  if ("isValid" in branchResult) {
    return branchResult;
  }

  if (branchResult.kind !== "erc20Approval" || !branchResult.extensionSigner.simulateTransactions) {
    return null;
  }

  const ok = await branchResult.extensionSigner.simulateTransactions([
    branchResult.signedTransaction,
    buildDepositTransaction(payload, branchResult.collectorData),
  ]);
  if (!ok) {
    return {
      isValid: false,
      invalidReason: Errors.ErrDepositSimulationFailed,
      payer: payload.channelConfig.payer,
    };
  }

  return null;
}

/**
 * Resolves the Permit2 setup branch and collector data for verification or settlement.
 *
 * @param signer - Facilitator signer for allowance reads.
 * @param payment - Full payment envelope containing optional extensions.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @param context - Optional facilitator extension context.
 * @returns Resolved branch, or a verification failure response.
 */
export async function resolvePermit2DepositBranch(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
): Promise<Permit2DepositBranch | VerifyResponse> {
  const payer = payload.channelConfig.payer;
  const tokenAddress = getAddress(requirements.asset);
  const eip2612Info = extractEip2612GasSponsoringInfo(payment);
  if (eip2612Info) {
    const result = validateBatchEip2612Permit(
      eip2612Info,
      payer,
      tokenAddress,
      payload.deposit.amount,
    );
    if (!result.isValid) {
      return { isValid: false, invalidReason: result.invalidReason, payer };
    }

    const { v, r, s } = splitEip2612Signature(eip2612Info.signature);
    return {
      kind: "eip2612",
      collectorData: buildPermit2DepositCollectorData(
        payload,
        buildEip2612PermitData({
          value: eip2612Info.amount,
          deadline: eip2612Info.deadline,
          v,
          r,
          s,
        }),
      ),
    };
  }

  const erc20Info = extractErc20ApprovalGasSponsoringInfo(payment);
  if (erc20Info) {
    const extensionSigner = resolveErc20ApprovalExtensionSigner(
      context?.getExtension<Erc20ApprovalGasSponsoringFacilitatorExtension>(
        ERC20_APPROVAL_GAS_SPONSORING_KEY,
      ),
      requirements.network,
    );
    if (!extensionSigner) {
      return { isValid: false, invalidReason: Errors.ErrErc20ApprovalUnavailable, payer };
    }

    const result = await validateErc20ApprovalForPayment(erc20Info, payer, tokenAddress);
    if (!result.isValid) {
      return {
        isValid: false,
        invalidReason: result.invalidReason,
        invalidMessage: result.invalidMessage,
        payer,
      };
    }

    return {
      kind: "erc20Approval",
      collectorData: buildPermit2DepositCollectorData(payload),
      signedTransaction: erc20Info.signedTransaction,
      extensionSigner,
    };
  }

  try {
    const allowance = (await signer.readContract({
      address: tokenAddress,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [payer, PERMIT2_ADDRESS],
    })) as bigint;

    if (allowance < BigInt(payload.deposit.amount)) {
      return { isValid: false, invalidReason: Errors.ErrPermit2AllowanceRequired, payer };
    }
  } catch {
    return { isValid: false, invalidReason: Errors.ErrPermit2AllowanceRequired, payer };
  }

  return {
    kind: "standard",
    collectorData: buildPermit2DepositCollectorData(payload),
  };
}

/**
 * Builds the unsigned batch `deposit` transaction used after a sponsored approval.
 *
 * @param payload - Batch deposit payload.
 * @param collectorData - Encoded Permit2 collector data.
 * @returns Transaction request for the extension signer.
 */
export function buildDepositTransaction(
  payload: BatchSettlementDepositPayload,
  collectorData: `0x${string}`,
): { to: `0x${string}`; data: `0x${string}`; gas: bigint } {
  return {
    to: getAddress(BATCH_SETTLEMENT_ADDRESS),
    data: encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "deposit",
      args: [
        toContractChannelConfig(payload.channelConfig),
        BigInt(payload.deposit.amount),
        getPermit2DepositCollectorAddress(),
        collectorData,
      ],
    }),
    gas: 300_000n,
  };
}

/**
 * Verifies the channel-bound Permit2 typed-data authorization.
 *
 * @param signer - Facilitator signer for typed-data verification.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for token matching.
 * @param chainId - EVM chain id.
 * @returns A failure response, or `null` when valid.
 */
async function verifyPermit2TypedData(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  chainId: number,
): Promise<VerifyResponse | null> {
  const auth = payload.deposit.authorization.permit2Authorization;
  const payer = payload.channelConfig.payer;

  if (!auth) {
    return { isValid: false, invalidReason: Errors.ErrPermit2AuthorizationRequired, payer };
  }

  if (getAddress(auth.from) !== getAddress(payer)) {
    return { isValid: false, invalidReason: Errors.ErrPermit2InvalidSignature, payer };
  }

  if (getAddress(auth.spender) !== getPermit2DepositCollectorAddress()) {
    return { isValid: false, invalidReason: Errors.ErrPermit2InvalidSpender, payer };
  }

  if (getAddress(auth.permitted.token) !== getAddress(requirements.asset)) {
    return { isValid: false, invalidReason: Errors.ErrTokenMismatch, payer };
  }

  if (BigInt(auth.permitted.amount) !== BigInt(payload.deposit.amount)) {
    return { isValid: false, invalidReason: Errors.ErrPermit2AmountMismatch, payer };
  }

  if (auth.witness.channelId !== payload.voucher.channelId) {
    return { isValid: false, invalidReason: Errors.ErrChannelIdMismatch, payer };
  }

  const now = Math.floor(Date.now() / 1000);
  if (BigInt(auth.deadline) < BigInt(now + 6)) {
    return { isValid: false, invalidReason: Errors.ErrPermit2DeadlineExpired, payer };
  }

  try {
    const ok = await signer.verifyTypedData({
      address: getAddress(auth.from),
      domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
      types: batchPermit2WitnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: {
          token: getAddress(auth.permitted.token),
          amount: BigInt(auth.permitted.amount),
        },
        spender: getAddress(auth.spender),
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
        witness: {
          channelId: auth.witness.channelId,
        },
      },
      signature: auth.signature,
    });
    if (!ok) {
      return { isValid: false, invalidReason: Errors.ErrPermit2InvalidSignature, payer };
    }
  } catch {
    return { isValid: false, invalidReason: Errors.ErrPermit2InvalidSignature, payer };
  }

  return null;
}

/**
 * Applies batch-specific EIP-2612 validation on top of the shared Permit2 checks.
 *
 * @param info - EIP-2612 sponsoring info from the payment envelope.
 * @param payer - Expected token owner.
 * @param tokenAddress - Expected token contract.
 * @param depositAmount - Required approval amount.
 * @returns Validation result.
 */
function validateBatchEip2612Permit(
  info: Eip2612GasSponsoringInfo,
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
  depositAmount: string,
): { isValid: true } | { isValid: false; invalidReason: string } {
  const baseline = validateEip2612PermitForPayment(info, payer, tokenAddress);
  if (!baseline.isValid) {
    return {
      isValid: false,
      invalidReason: baseline.invalidReason ?? Errors.ErrInvalidPayloadType,
    };
  }

  if (BigInt(info.amount) !== BigInt(depositAmount)) {
    return { isValid: false, invalidReason: Errors.ErrEip2612AmountMismatch };
  }

  return { isValid: true };
}
