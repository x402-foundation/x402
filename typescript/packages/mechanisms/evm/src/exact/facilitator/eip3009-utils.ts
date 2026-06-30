import { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { encodeFunctionData, getAddress, Hex, parseErc6492Signature, parseSignature } from "viem";
import { eip3009ABI } from "../../constants";
import { multicall, ContractCall, RawContractCall } from "../../multicall";
import { FacilitatorEvmSigner } from "../../signer";
import { ExactEIP3009Payload } from "../../types";
import * as Errors from "./errors";

export interface Eip6492Deployment {
  factoryAddress: `0x${string}`;
  factoryCalldata: `0x${string}`;
}

/**
 * Outcome of a transfer simulation. `error` is populated only when the underlying `eth_call`
 * threw (revert or transport), letting callers distinguish a contract revert from an RPC failure.
 */
export interface SimulateEip3009Result {
  ok: boolean;
  error?: unknown;
}

/**
 * Simulates transferWithAuthorization via eth_call.
 * Returns true if simulation succeeded, false if it failed.
 *
 * @param signer - EVM signer for contract reads
 * @param erc20Address - ERC-20 token contract address
 * @param payload - EIP-3009 transfer authorization payload
 * @param eip6492Deployment - Optional EIP-6492 factory info for undeployed smart wallets
 *
 * @returns true if simulation succeeded, false if it failed
 */
export async function simulateEip3009Transfer(
  signer: FacilitatorEvmSigner,
  erc20Address: `0x${string}`,
  payload: ExactEIP3009Payload,
  eip6492Deployment?: Eip6492Deployment,
): Promise<boolean> {
  return (await simulateEip3009TransferResult(signer, erc20Address, payload, eip6492Deployment)).ok;
}

/**
 * Like {@link simulateEip3009Transfer} but returns the thrown error (if any) alongside the
 * boolean outcome, so callers can tell a contract revert apart from a transport/RPC failure.
 *
 * @param signer - EVM signer for contract reads
 * @param erc20Address - ERC-20 token contract address
 * @param payload - EIP-3009 transfer authorization payload
 * @param eip6492Deployment - Optional EIP-6492 factory info for undeployed smart wallets
 * @returns The simulation outcome and, on failure via a thrown error, that error.
 */
export async function simulateEip3009TransferResult(
  signer: FacilitatorEvmSigner,
  erc20Address: `0x${string}`,
  payload: ExactEIP3009Payload,
  eip6492Deployment?: Eip6492Deployment,
): Promise<SimulateEip3009Result> {
  const auth = payload.authorization;
  const transferArgs = [
    getAddress(auth.from),
    getAddress(auth.to),
    BigInt(auth.value),
    BigInt(auth.validAfter),
    BigInt(auth.validBefore),
    auth.nonce,
  ] as const;

  if (eip6492Deployment) {
    const { signature: innerSignature } = parseErc6492Signature(payload.signature!);
    const transferCalldata = encodeFunctionData({
      abi: eip3009ABI,
      functionName: "transferWithAuthorization",
      args: [...transferArgs, innerSignature],
    });

    try {
      const results = await multicall(signer.readContract.bind(signer), [
        {
          address: getAddress(eip6492Deployment.factoryAddress),
          callData: eip6492Deployment.factoryCalldata,
        } satisfies RawContractCall,
        {
          address: erc20Address,
          callData: transferCalldata,
        } satisfies RawContractCall,
      ]);

      return { ok: results[1]?.status === "success" };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const sig = payload.signature!;
  const sigLength = sig.startsWith("0x") ? sig.length - 2 : sig.length;
  const isECDSA = sigLength === 130;

  try {
    if (isECDSA) {
      const parsedSig = parseSignature(sig);
      await signer.readContract({
        address: erc20Address,
        abi: eip3009ABI,
        functionName: "transferWithAuthorization",
        args: [
          ...transferArgs,
          (parsedSig.v as number | undefined) ?? parsedSig.yParity,
          parsedSig.r,
          parsedSig.s,
        ],
      });
    } else {
      await signer.readContract({
        address: erc20Address,
        abi: eip3009ABI,
        functionName: "transferWithAuthorization",
        args: [...transferArgs, sig],
      });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * After simulation fails, runs a single diagnostic multicall to determine the most specific error reason.
 * Checks balanceOf, name, version and authorizationState in one RPC round-trip.
 *
 * @param signer - EVM signer used for the payment
 * @param erc20Address - Address of the ERC-20 token contract
 * @param payload - The EIP-3009 transfer authorization payload
 * @param requirements - Payment requirements to validate against
 * @param amountRequired - Required amount for the payment (balance check)
 *
 * @returns Promise resolving to the verification result with validity and optional invalid reason
 */
export async function diagnoseEip3009SimulationFailure(
  signer: FacilitatorEvmSigner,
  erc20Address: `0x${string}`,
  payload: ExactEIP3009Payload,
  requirements: PaymentRequirements,
  amountRequired: string,
): Promise<VerifyResponse> {
  const payer = payload.authorization.from;

  const diagnosticCalls: ContractCall[] = [
    {
      address: erc20Address,
      abi: eip3009ABI,
      functionName: "balanceOf",
      args: [payload.authorization.from],
    },
    {
      address: erc20Address,
      abi: eip3009ABI,
      functionName: "name",
    },
    {
      address: erc20Address,
      abi: eip3009ABI,
      functionName: "version",
    },
    {
      address: erc20Address,
      abi: eip3009ABI,
      functionName: "authorizationState",
      args: [payload.authorization.from, payload.authorization.nonce],
    },
  ];

  try {
    const results = await multicall(signer.readContract.bind(signer), diagnosticCalls);

    const [balanceResult, nameResult, versionResult, authStateResult] = results;

    if (authStateResult.status === "failure") {
      return { isValid: false, invalidReason: Errors.ErrEip3009NotSupported, payer };
    }

    if (authStateResult.status === "success" && authStateResult.result === true) {
      return { isValid: false, invalidReason: Errors.ErrEip3009NonceAlreadyUsed, payer };
    }

    if (
      nameResult.status === "success" &&
      requirements.extra?.name &&
      nameResult.result !== requirements.extra.name
    ) {
      return { isValid: false, invalidReason: Errors.ErrEip3009TokenNameMismatch, payer };
    }

    if (
      versionResult.status === "success" &&
      requirements.extra?.version &&
      versionResult.result !== requirements.extra.version
    ) {
      return { isValid: false, invalidReason: Errors.ErrEip3009TokenVersionMismatch, payer };
    }

    if (balanceResult.status === "success") {
      const balance = balanceResult.result as bigint;
      if (balance < BigInt(amountRequired)) {
        return {
          isValid: false,
          invalidReason: Errors.ErrEip3009InsufficientBalance,
          payer,
        };
      }
    }
  } catch {
    // Diagnostic multicall failed — fall through to generic error
  }

  return { isValid: false, invalidReason: Errors.ErrEip3009SimulationFailed, payer };
}

/**
 * Maps an EIP-3009 contract revert error to a specific error code.
 * Falls back to ErrTransactionFailed when the revert reason is unknown.
 *
 * @param error - The error thrown during transfer execution
 * @returns A specific error reason string
 */
export function parseEip3009TransferError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/authorization.*(expired|valid before)/i.test(msg) || /AuthorizationExpired/i.test(msg)) {
    return Errors.ErrValidBeforeExpired;
  }
  if (/authorization.*not.*valid|AuthorizationNotYetValid/i.test(msg)) {
    return Errors.ErrValidAfterInFuture;
  }
  if (/authorization.*used|AuthorizationAlreadyUsed|AuthorizationUsedOrCanceled/i.test(msg)) {
    return Errors.ErrEip3009NonceAlreadyUsed;
  }
  if (/transfer.*exceeds.*balance|insufficient.*balance|ERC20InsufficientBalance/i.test(msg)) {
    return Errors.ErrEip3009InsufficientBalance;
  }
  if (/invalid.*signature|SignerMismatch|InvalidSignatureV|InvalidSignatureS/i.test(msg)) {
    return Errors.ErrInvalidSignature;
  }
  return Errors.ErrTransactionFailed;
}

/**
 * Executes transferWithAuthorization onchain.
 *
 * @param signer - EVM signer for contract writes
 * @param erc20Address - ERC-20 token contract address
 * @param payload - EIP-3009 transfer authorization payload
 * @param dataSuffix - Optional hex bytes to append after the ABI-encoded calldata
 *
 * @returns Transaction hash
 */
export async function executeTransferWithAuthorization(
  signer: FacilitatorEvmSigner,
  erc20Address: `0x${string}`,
  payload: ExactEIP3009Payload,
  dataSuffix?: Hex,
): Promise<Hex> {
  const { signature } = parseErc6492Signature(payload.signature!);
  const signatureLength = signature.startsWith("0x") ? signature.length - 2 : signature.length;
  const isECDSA = signatureLength === 130;

  const auth = payload.authorization;
  const baseArgs = [
    getAddress(auth.from),
    getAddress(auth.to),
    BigInt(auth.value),
    BigInt(auth.validAfter),
    BigInt(auth.validBefore),
    auth.nonce,
  ] as const;

  let signatureArgs: readonly unknown[];
  if (isECDSA) {
    const parsedSig = parseSignature(signature);
    signatureArgs = [
      (parsedSig.v as number | undefined) || parsedSig.yParity,
      parsedSig.r,
      parsedSig.s,
    ];
  } else {
    signatureArgs = [signature];
  }

  return signer.writeContract({
    address: erc20Address,
    abi: eip3009ABI,
    functionName: "transferWithAuthorization",
    args: [...baseArgs, ...signatureArgs],
    dataSuffix,
  });
}
