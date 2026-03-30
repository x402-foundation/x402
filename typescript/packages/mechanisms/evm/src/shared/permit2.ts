import {
  PaymentPayload,
  PaymentPayloadResult,
  PaymentRequirements,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  extractEip2612GasSponsoringInfo,
  validateEip2612GasSponsoringInfo,
  extractErc20ApprovalGasSponsoringInfo,
  ERC20_APPROVAL_GAS_SPONSORING_KEY,
  type Eip2612GasSponsoringInfo,
  type Erc20ApprovalGasSponsoringFacilitatorExtension,
  type Erc20ApprovalGasSponsoringSigner,
} from "../exact/extensions";
import { getAddress, encodeFunctionData } from "viem";
import { PERMIT2_ADDRESS, eip3009ABI, erc20AllowanceAbi, permit2WitnessTypes } from "../constants";
import { multicall, ContractCall } from "../multicall";
import { createPermit2Nonce, getEvmChainId } from "../utils";
import {
  ErrPermit2612AmountMismatch,
  ErrPermit2InvalidAmount,
  ErrPermit2InvalidDestination,
  ErrPermit2InvalidNonce,
  ErrPermit2InvalidOwner,
  ErrPermit2InvalidSignature,
  ErrPermit2PaymentTooEarly,
  ErrPermit2AllowanceRequired,
  ErrPermit2SimulationFailed,
  ErrPermit2InsufficientBalance,
  ErrPermit2ProxyNotDeployed,
  ErrInvalidTransactionState,
  ErrTransactionFailed,
  ErrInvalidEip2612ExtensionFormat,
  ErrEip2612FromMismatch,
  ErrEip2612AssetMismatch,
  ErrEip2612SpenderNotPermit2,
  ErrEip2612DeadlineExpired,
  ErrErc20ApprovalTxFailed,
} from "../exact/facilitator/errors";
import { ClientEvmSigner, FacilitatorEvmSigner } from "../signer";
import { ExactPermit2Payload, Permit2Authorization, UptoPermit2Payload } from "../types";
import { validateErc20ApprovalForPayment } from "./erc20approval";
import {
  ErrUptoAmountExceedsPermitted,
  ErrUptoUnauthorizedFacilitator,
} from "../upto/facilitator/errors";

/**
 * Base type for Permit2 payloads shared between exact and upto schemes.
 * Both {@link ExactPermit2Payload} and {@link UptoPermit2Payload} satisfy this type.
 */
export type Permit2PayloadBase = ExactPermit2Payload | UptoPermit2Payload;

/**
 * Configuration for the Permit2 proxy contract used during settlement.
 * The exact and upto schemes use different proxy addresses and ABIs.
 */
export type Permit2ProxyConfig = {
  /** The deployed proxy contract address. */
  proxyAddress: `0x${string}`;
  /** The proxy contract ABI (must include settle and settleWithPermit functions). */
  proxyABI: readonly Record<string, unknown>[];
};

/**
 * Checks Permit2 allowance and validates gas sponsoring extensions if allowance is insufficient.
 *
 * When the on-chain ERC-20 allowance to the Permit2 contract is below the required amount,
 * this function falls back to validating EIP-2612 or ERC-20 approval gas sponsoring extensions
 * attached to the payment payload.
 *
 * @param signer - The facilitator signer for on-chain reads
 * @param payload - The payment payload
 * @param requirements - The payment requirements
 * @param payer - The payer address
 * @param tokenAddress - The token contract address
 * @param context - Optional facilitator context for extension lookup
 * @returns A VerifyResponse if verification should stop (failure), or null to continue
 */
export async function verifyPermit2Allowance(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
  context?: FacilitatorContext,
): Promise<VerifyResponse | null> {
  try {
    const allowance = (await signer.readContract({
      address: tokenAddress,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [payer, PERMIT2_ADDRESS],
    })) as bigint;

    if (allowance >= BigInt(requirements.amount)) {
      return null; // Sufficient allowance, continue verification
    }

    // Allowance insufficient — try EIP-2612 gas sponsoring first
    const eip2612Info = extractEip2612GasSponsoringInfo(payload);
    if (eip2612Info) {
      const result = validateEip2612PermitForPayment(eip2612Info, payer, tokenAddress);
      if (!result.isValid) {
        return { isValid: false, invalidReason: result.invalidReason!, payer };
      }
      return null; // EIP-2612 is valid, allowance will be set atomically during settlement
    }

    // Try ERC-20 approval gas sponsoring as fallback
    const erc20GasSponsorshipExtension =
      context?.getExtension<Erc20ApprovalGasSponsoringFacilitatorExtension>(
        ERC20_APPROVAL_GAS_SPONSORING_KEY,
      );
    if (erc20GasSponsorshipExtension) {
      const erc20Info = extractErc20ApprovalGasSponsoringInfo(payload);
      if (erc20Info) {
        const result = await validateErc20ApprovalForPayment(erc20Info, payer, tokenAddress);
        if (!result.isValid) {
          return { isValid: false, invalidReason: result.invalidReason!, payer };
        }
        return null; // ERC-20 approval is valid, will be broadcast before settlement
      }
    }

    return { isValid: false, invalidReason: "permit2_allowance_required", payer };
  } catch {
    // Allowance check failed — validate extensions if present; fail closed if none valid
    const eip2612Info = extractEip2612GasSponsoringInfo(payload);
    if (eip2612Info) {
      const result = validateEip2612PermitForPayment(eip2612Info, payer, tokenAddress);
      if (!result.isValid) {
        return { isValid: false, invalidReason: result.invalidReason!, payer };
      }
      return null;
    }

    const erc20GasSponsorshipExtension =
      context?.getExtension<Erc20ApprovalGasSponsoringFacilitatorExtension>(
        ERC20_APPROVAL_GAS_SPONSORING_KEY,
      );
    if (erc20GasSponsorshipExtension) {
      const erc20Info = extractErc20ApprovalGasSponsoringInfo(payload);
      if (erc20Info) {
        const result = await validateErc20ApprovalForPayment(erc20Info, payer, tokenAddress);
        if (!result.isValid) {
          return { isValid: false, invalidReason: result.invalidReason!, payer };
        }
        return null;
      }
    }

    return { isValid: false, invalidReason: "permit2_allowance_required", payer };
  }
}

/**
 * Waits for a transaction receipt and returns the appropriate SettleResponse.
 *
 * @param signer - Signer with waitForTransactionReceipt capability
 * @param tx - The transaction hash to wait for
 * @param payload - The payment payload (for network info)
 * @param payer - The payer address
 * @returns Promise resolving to a settlement response indicating success or failure
 */
export async function waitAndReturnSettleResponse(
  signer: Pick<FacilitatorEvmSigner, "waitForTransactionReceipt">,
  tx: `0x${string}`,
  payload: PaymentPayload,
  payer: `0x${string}`,
): Promise<SettleResponse> {
  const receipt = await signer.waitForTransactionReceipt({ hash: tx });

  if (receipt.status !== "success") {
    return {
      success: false,
      errorReason: ErrInvalidTransactionState,
      transaction: tx,
      network: payload.accepted.network,
      payer,
    };
  }

  return {
    success: true,
    transaction: tx,
    network: payload.accepted.network,
    payer,
  };
}

/**
 * Maps contract revert errors to structured SettleResponse error reasons.
 *
 * Inspects the error message for known contract revert strings and maps them
 * to the corresponding error reason constants. Falls back to a generic
 * "transaction_failed" reason with truncated message for unrecognized errors.
 *
 * @param error - The caught error (typically from a contract write)
 * @param payload - The payment payload (for network info)
 * @param payer - The payer address
 * @returns A failed SettleResponse with the mapped error reason
 */
export function mapSettleError(
  error: unknown,
  payload: PaymentPayload,
  payer: `0x${string}`,
): SettleResponse {
  let errorReason: string = ErrTransactionFailed;
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes("Permit2612AmountMismatch")) {
      errorReason = ErrPermit2612AmountMismatch;
    } else if (message.includes("InvalidAmount")) {
      errorReason = ErrPermit2InvalidAmount;
    } else if (message.includes("InvalidDestination")) {
      errorReason = ErrPermit2InvalidDestination;
    } else if (message.includes("InvalidOwner")) {
      errorReason = ErrPermit2InvalidOwner;
    } else if (message.includes("PaymentTooEarly")) {
      errorReason = ErrPermit2PaymentTooEarly;
    } else if (message.includes("InvalidSignature") || message.includes("SignatureExpired")) {
      errorReason = ErrPermit2InvalidSignature;
    } else if (message.includes("InvalidNonce")) {
      errorReason = ErrPermit2InvalidNonce;
    } else if (message.includes("erc20_approval_tx_failed")) {
      errorReason = ErrErc20ApprovalTxFailed;
    } else if (message.includes("AmountExceedsPermitted")) {
      errorReason = ErrUptoAmountExceedsPermitted;
    } else if (message.includes("UnauthorizedFacilitator")) {
      errorReason = ErrUptoUnauthorizedFacilitator;
    } else {
      errorReason = `${ErrTransactionFailed}: ${message.slice(0, 500)}`;
    }
  }
  return {
    success: false,
    errorReason,
    transaction: "",
    network: payload.accepted.network,
    payer,
  };
}

/**
 * Validates EIP-2612 permit extension data for a Permit2 payment.
 *
 * Checks that the permit extension has a valid format and that the from address,
 * asset address, spender address, and deadline all match expectations.
 *
 * @param info - The EIP-2612 gas sponsoring info extracted from the payment payload
 * @param payer - The expected payer address
 * @param tokenAddress - The expected token address
 * @returns Validation result with isValid flag and optional invalidReason string
 */
export function validateEip2612PermitForPayment(
  info: Eip2612GasSponsoringInfo,
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
): { isValid: boolean; invalidReason?: string } {
  if (!validateEip2612GasSponsoringInfo(info)) {
    return { isValid: false, invalidReason: ErrInvalidEip2612ExtensionFormat };
  }

  if (getAddress(info.from as `0x${string}`) !== getAddress(payer)) {
    return { isValid: false, invalidReason: ErrEip2612FromMismatch };
  }

  if (getAddress(info.asset as `0x${string}`) !== tokenAddress) {
    return { isValid: false, invalidReason: ErrEip2612AssetMismatch };
  }

  if (getAddress(info.spender as `0x${string}`) !== getAddress(PERMIT2_ADDRESS)) {
    return { isValid: false, invalidReason: ErrEip2612SpenderNotPermit2 };
  }

  const now = Math.floor(Date.now() / 1000);
  if (BigInt(info.deadline) < BigInt(now + 6)) {
    return { isValid: false, invalidReason: ErrEip2612DeadlineExpired };
  }

  return { isValid: true };
}

// ---------------------------------------------------------------------------
// Simulation helpers (shared across exact and upto)
// ---------------------------------------------------------------------------

/**
 * Simulates settle() via eth_call (readContract).
 * Returns true if simulation succeeded, false if it failed.
 *
 * @param config - The proxy contract configuration (address and ABI)
 * @param signer - EVM signer for contract reads
 * @param settleArgs - Pre-built settle function arguments (scheme-specific)
 * @returns true if simulation succeeded, false if it failed
 */
export async function simulatePermit2Settle(
  config: Permit2ProxyConfig,
  signer: FacilitatorEvmSigner,
  settleArgs: readonly unknown[],
): Promise<boolean> {
  try {
    await signer.readContract({
      address: config.proxyAddress,
      abi: config.proxyABI,
      functionName: "settle",
      args: settleArgs,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Simulates settleWithPermit() via eth_call (readContract).
 * The contract atomically calls token.permit() then PERMIT2.permitTransferFrom(),
 * so simulation covers allowance + balance + nonces.
 *
 * @param config - The proxy contract configuration (address and ABI)
 * @param signer - EVM signer for contract reads
 * @param settleArgs - Pre-built settle function arguments (scheme-specific)
 * @param eip2612Info - EIP-2612 gas sponsoring info from the payload extension
 * @returns true if simulation succeeded, false if it failed
 */
export async function simulatePermit2SettleWithPermit(
  config: Permit2ProxyConfig,
  signer: FacilitatorEvmSigner,
  settleArgs: readonly unknown[],
  eip2612Info: Eip2612GasSponsoringInfo,
): Promise<boolean> {
  try {
    const { v, r, s } = splitEip2612Signature(eip2612Info.signature);

    await signer.readContract({
      address: config.proxyAddress,
      abi: config.proxyABI,
      functionName: "settleWithPermit",
      args: [
        {
          value: BigInt(eip2612Info.amount),
          deadline: BigInt(eip2612Info.deadline),
          r,
          s,
          v,
        },
        ...settleArgs,
      ],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delegates the full approve+settle simulation flow to the extension signer via simulateTransactions.
 * The signer owns execution strategy.
 *
 * @param config - The proxy contract configuration (address and ABI)
 * @param extensionSigner - The extension signer with simulateTransactions capability
 * @param settleArgs - Pre-built settle function arguments (scheme-specific)
 * @param erc20Info - Object containing the signed approval transaction
 * @param erc20Info.signedTransaction - The RLP-encoded signed ERC-20 approve transaction hex string
 * @returns true if the bundle simulation succeeded, false otherwise
 */
export async function simulatePermit2SettleWithErc20Approval(
  config: Permit2ProxyConfig,
  extensionSigner: Erc20ApprovalGasSponsoringSigner,
  settleArgs: readonly unknown[],
  erc20Info: { signedTransaction: string },
): Promise<boolean> {
  if (!extensionSigner.simulateTransactions) {
    return false;
  }

  try {
    const settleData = encodeFunctionData({
      abi: config.proxyABI,
      functionName: "settle",
      args: settleArgs,
    });

    return await extensionSigner.simulateTransactions([
      erc20Info.signedTransaction as `0x${string}`,
      { to: config.proxyAddress, data: settleData, gas: BigInt(300_000) },
    ]);
  } catch {
    return false;
  }
}

/**
 * Diagnoses a Permit2 simulation failure by performing a multicall to check the proxy deployment, balance and allowance.
 *
 * @param config - The proxy contract configuration (address and ABI)
 * @param signer - EVM signer for contract reads
 * @param tokenAddress - ERC-20 token contract address
 * @param permit2Payload - The Permit2 authorization payload
 * @param amountRequired - Required payment amount (as string)
 * @returns VerifyResponse with the most specific failure reason
 */
export async function diagnosePermit2SimulationFailure(
  config: Permit2ProxyConfig,
  signer: FacilitatorEvmSigner,
  tokenAddress: `0x${string}`,
  permit2Payload: Permit2PayloadBase,
  amountRequired: string,
): Promise<VerifyResponse> {
  const payer = permit2Payload.permit2Authorization.from;

  const diagnosticCalls: ContractCall[] = [
    {
      address: config.proxyAddress,
      abi: config.proxyABI,
      functionName: "PERMIT2",
    },
    {
      address: tokenAddress,
      abi: eip3009ABI,
      functionName: "balanceOf",
      args: [payer],
    },
    {
      address: tokenAddress,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [payer, PERMIT2_ADDRESS],
    },
  ];

  try {
    const results = await multicall(signer.readContract.bind(signer), diagnosticCalls);

    const [proxyResult, balanceResult, allowanceResult] = results;

    if (proxyResult.status === "failure") {
      return { isValid: false, invalidReason: ErrPermit2ProxyNotDeployed, payer };
    }

    if (balanceResult.status === "success") {
      const balance = balanceResult.result as bigint;
      if (balance < BigInt(amountRequired)) {
        return { isValid: false, invalidReason: ErrPermit2InsufficientBalance, payer };
      }
    }

    if (allowanceResult.status === "success") {
      const allowance = allowanceResult.result as bigint;
      if (allowance < BigInt(amountRequired)) {
        return { isValid: false, invalidReason: ErrPermit2AllowanceRequired, payer };
      }
    }
  } catch {
    // Diagnostic multicall itself failed — fall through to generic error
  }

  return { isValid: false, invalidReason: ErrPermit2SimulationFailed, payer };
}

/**
 * Targeted multicall for the ERC-20 approval path where simulation cannot be used
 * (the approval hasn't been broadcast yet, so settle() would fail for expected reasons).
 * Checks proxy deployment, payer token balance and payer ETH balance for gas.
 *
 * @param config - The proxy contract configuration (address and ABI)
 * @param signer - EVM signer for contract reads
 * @param tokenAddress - ERC-20 token contract address
 * @param payer - The payer address
 * @param amountRequired - Required payment amount (as string)
 * @returns VerifyResponse — valid if checks pass, otherwise the most specific failure
 */
export async function checkPermit2Prerequisites(
  config: Permit2ProxyConfig,
  signer: FacilitatorEvmSigner,
  tokenAddress: `0x${string}`,
  payer: `0x${string}`,
  amountRequired: string,
): Promise<VerifyResponse> {
  const diagnosticCalls: ContractCall[] = [
    {
      address: config.proxyAddress,
      abi: config.proxyABI,
      functionName: "PERMIT2",
    },
    {
      address: tokenAddress,
      abi: eip3009ABI,
      functionName: "balanceOf",
      args: [payer],
    },
  ];

  try {
    const results = await multicall(signer.readContract.bind(signer), diagnosticCalls);

    const [proxyResult, balanceResult] = results;

    if (proxyResult.status === "failure") {
      return { isValid: false, invalidReason: ErrPermit2ProxyNotDeployed, payer };
    }

    if (balanceResult.status === "success") {
      const balance = balanceResult.result as bigint;
      if (balance < BigInt(amountRequired)) {
        return { isValid: false, invalidReason: ErrPermit2InsufficientBalance, payer };
      }
    }
  } catch {
    // Multicall failed — fall through to valid (fail open for prerequisites-only check)
  }

  return { isValid: true, invalidReason: undefined, payer };
}

/**
 * Builds args for exact settle(permit, owner, witness, signature).
 *
 * @param permit2Payload - The Permit2 payload containing authorization and signature data
 * @returns Tuple of contract call arguments for the exact settle function
 */
export function buildExactPermit2SettleArgs(permit2Payload: Permit2PayloadBase) {
  return [
    {
      permitted: {
        token: getAddress(permit2Payload.permit2Authorization.permitted.token),
        amount: BigInt(permit2Payload.permit2Authorization.permitted.amount),
      },
      nonce: BigInt(permit2Payload.permit2Authorization.nonce),
      deadline: BigInt(permit2Payload.permit2Authorization.deadline),
    },
    getAddress(permit2Payload.permit2Authorization.from),
    {
      to: getAddress(permit2Payload.permit2Authorization.witness.to),
      validAfter: BigInt(permit2Payload.permit2Authorization.witness.validAfter),
    },
    permit2Payload.signature,
  ] as const;
}

/**
 * Builds args for upto settle(permit, amount, owner, witness, signature).
 * The upto contract's settle() takes an additional `amount` parameter and the witness
 * includes a `facilitator` field.
 *
 * @param permit2Payload - The upto Permit2 payload containing authorization and signature data
 * @param settlementAmount - The amount to settle on-chain
 * @param facilitatorAddress - The facilitator address authorized in the witness
 * @returns Tuple of contract call arguments for the upto settle function
 */
export function buildUptoPermit2SettleArgs(
  permit2Payload: UptoPermit2Payload,
  settlementAmount: bigint,
  facilitatorAddress: `0x${string}`,
) {
  return [
    {
      permitted: {
        token: getAddress(permit2Payload.permit2Authorization.permitted.token),
        amount: BigInt(permit2Payload.permit2Authorization.permitted.amount),
      },
      nonce: BigInt(permit2Payload.permit2Authorization.nonce),
      deadline: BigInt(permit2Payload.permit2Authorization.deadline),
    },
    settlementAmount,
    getAddress(permit2Payload.permit2Authorization.from),
    {
      to: getAddress(permit2Payload.permit2Authorization.witness.to),
      facilitator: getAddress(facilitatorAddress),
      validAfter: BigInt(permit2Payload.permit2Authorization.witness.validAfter),
    },
    permit2Payload.signature,
  ] as const;
}

/**
 * Splits a 65-byte EIP-2612 signature into v, r, s components.
 *
 * @param signature - The hex-encoded 65-byte signature (with or without 0x prefix)
 * @returns Object with v (uint8), r (bytes32 hex), s (bytes32 hex)
 * @throws Error if the signature is not exactly 65 bytes (130 hex chars)
 */
export function splitEip2612Signature(signature: string): {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
} {
  const sig = signature.startsWith("0x") ? signature.slice(2) : signature;

  if (sig.length !== 130) {
    throw new Error(
      `invalid EIP-2612 signature length: expected 65 bytes (130 hex chars), got ${sig.length / 2} bytes`,
    );
  }

  const r = `0x${sig.slice(0, 64)}` as `0x${string}`;
  const s = `0x${sig.slice(64, 128)}` as `0x${string}`;
  const v = parseInt(sig.slice(128, 130), 16);

  return { v, r, s };
}

// ---------------------------------------------------------------------------
// Client-side helpers
// ---------------------------------------------------------------------------

/**
 * Creates a Permit2 payload for any scheme (exact or upto).
 * The only scheme-specific input is the proxy address used as the spender.
 *
 * @param proxyAddress - The x402 proxy contract address to set as spender
 * @param signer - The EVM client signer
 * @param x402Version - The x402 protocol version
 * @param paymentRequirements - The payment requirements
 * @returns Promise resolving to a payment payload result
 */
export async function createPermit2PayloadForProxy(
  proxyAddress: `0x${string}`,
  signer: ClientEvmSigner,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
): Promise<PaymentPayloadResult> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = createPermit2Nonce();

  // Lower time bound - allow some clock skew
  const validAfter = (now - 600).toString();
  // Upper time bound is enforced by Permit2's deadline field
  const deadline = (now + paymentRequirements.maxTimeoutSeconds).toString();

  const permit2Authorization: Permit2Authorization & { from: `0x${string}` } = {
    from: signer.address,
    permitted: {
      token: getAddress(paymentRequirements.asset),
      amount: paymentRequirements.amount,
    },
    spender: proxyAddress,
    nonce,
    deadline,
    witness: {
      to: getAddress(paymentRequirements.payTo),
      validAfter,
    },
  };

  const signature = await signPermit2Authorization(
    signer,
    permit2Authorization,
    paymentRequirements,
  );

  return {
    x402Version,
    payload: { signature, permit2Authorization },
  };
}

/**
 * Signs a Permit2 authorization using EIP-712 with witness data.
 * The signature authorizes the proxy contract to transfer tokens on behalf of the signer.
 *
 * @param signer - The EVM client signer
 * @param permit2Authorization - The Permit2 authorization parameters
 * @param requirements - The payment requirements
 * @returns Promise resolving to the hex-encoded signature
 */
async function signPermit2Authorization(
  signer: ClientEvmSigner,
  permit2Authorization: Permit2Authorization & { from: `0x${string}` },
  requirements: PaymentRequirements,
): Promise<`0x${string}`> {
  const chainId = getEvmChainId(requirements.network);

  return await signer.signTypedData({
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: getAddress(permit2Authorization.permitted.token),
        amount: BigInt(permit2Authorization.permitted.amount),
      },
      spender: getAddress(permit2Authorization.spender),
      nonce: BigInt(permit2Authorization.nonce),
      deadline: BigInt(permit2Authorization.deadline),
      witness: {
        to: getAddress(permit2Authorization.witness.to),
        validAfter: BigInt(permit2Authorization.witness.validAfter),
      },
    },
  });
}
