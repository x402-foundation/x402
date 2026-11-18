import { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { getAddress, isAddressEqual, parseErc6492Signature } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import { BatchSettlementDepositPayload } from "../types";
import { ERC3009_DEPOSIT_COLLECTOR_ADDRESS, receiveAuthorizationTypes } from "../constants";
import { buildErc3009CollectorData, buildErc3009DepositNonce } from "../encoding";
import * as Errors from "../errors";
import { erc3009AuthorizationTimeInvalidReason } from "./utils";
import { verifyTypedDataSignature } from "../../shared/verifySignature";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Factory deployment info for an undeployed (ERC-6492 counterfactual) deposit wallet. */
export type Erc3009CounterfactualDeployment = {
  factory: `0x${string}`;
  factoryCalldata: `0x${string}`;
};

/**
 * Result of ERC-3009 deposit authorization verification.
 *
 * - `response` non-null: terminal verification outcome (a rejection).
 * - `counterfactual` non-null: the deposit is from an undeployed ERC-6492 wallet with an
 *   allowlisted factory; the caller must validate the inner signature via the deploy+deposit
 *   simulation rather than a direct (no-code) signature check.
 * - both null: a deployed wallet / plain EOA signature is valid.
 */
export type Erc3009DepositVerifyResult = {
  response: VerifyResponse | null;
  counterfactual: Erc3009CounterfactualDeployment | null;
};

/**
 * Returns the collector contract used for EIP-3009 deposits.
 *
 * @returns ERC-3009 deposit collector address.
 */
export function getEip3009DepositCollectorAddress(): `0x${string}` {
  return getAddress(ERC3009_DEPOSIT_COLLECTOR_ADDRESS);
}

/**
 * Encodes collector data for an EIP-3009 deposit payload.
 *
 * @param payload - Deposit payload containing the ERC-3009 authorization.
 * @returns ABI-encoded collector data.
 */
export function buildEip3009DepositCollectorData(
  payload: BatchSettlementDepositPayload,
): `0x${string}` {
  const auth = payload.deposit.authorization.erc3009Authorization;
  if (!auth) {
    throw new Error(Errors.ErrErc3009AuthorizationRequired);
  }

  const { signature } = parseErc6492Signature(auth.signature);
  return buildErc3009CollectorData(auth.validAfter, auth.validBefore, auth.salt, signature);
}

/**
 * Verifies the ERC-3009 authorization fields and typed-data signature.
 *
 * @param signer - Facilitator signer for typed-data verification.
 * @param payload - Deposit payload to verify.
 * @param requirements - Payment requirements containing token domain metadata.
 * @param chainId - EVM chain id.
 * @param allowedFactories - Allowlisted ERC-6492 factory addresses for counterfactual deposits.
 * @returns The verification result (rejection, valid, or counterfactual-deferred).
 */
export async function verifyEip3009DepositAuthorization(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  chainId: number,
  allowedFactories: string[] = [],
): Promise<Erc3009DepositVerifyResult> {
  const { deposit, voucher } = payload;
  const payer = payload.channelConfig.payer;
  const auth = deposit.authorization.erc3009Authorization;

  const reject = (invalidReason: string): Erc3009DepositVerifyResult => ({
    response: { isValid: false, invalidReason, payer },
    counterfactual: null,
  });

  if (!auth) {
    return reject(Errors.ErrErc3009AuthorizationRequired);
  }

  const extra = requirements.extra as { name?: string; version?: string } | undefined;
  if (!extra?.name || !extra?.version) {
    return reject(Errors.ErrMissingEip712Domain);
  }

  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  const timeInvalid = erc3009AuthorizationTimeInvalidReason(validAfter, validBefore);
  if (timeInvalid) {
    return reject(timeInvalid);
  }

  // Parse the ERC-6492 wrapper (a no-op for unwrapped signatures, which return the signature
  // unchanged as `signature`).
  const {
    address: factory,
    data: factoryCalldata,
    signature: innerSig,
  } = parseErc6492Signature(auth.signature);
  const hasDeploymentInfo = !!(
    factory &&
    factoryCalldata &&
    !isAddressEqual(factory, ZERO_ADDRESS)
  );

  // Counterfactual detection: only fetch code when there is deployment info so the common
  // (already-deployed / plain EOA) path keeps a single RPC round-trip.
  if (hasDeploymentInfo) {
    let code: `0x${string}` | undefined;
    try {
      code = await signer.getCode({ address: payer });
    } catch {
      code = undefined;
    }
    if (!code || code === "0x") {
      const normalizedFactory = factory.toLowerCase();
      const isAllowed = allowedFactories.some(a => a.trim().toLowerCase() === normalizedFactory);
      if (!isAllowed) {
        return reject(Errors.ErrFactoryNotAllowed);
      }
      // Counterfactual + allowlisted: defer signature validation to the deploy+deposit
      // simulation performed by the caller.
      return {
        response: null,
        counterfactual: { factory, factoryCalldata: factoryCalldata as `0x${string}` },
      };
    }
    // Already deployed despite the wrapper — fall through and validate the inner signature.
  }

  const erc3009Nonce = buildErc3009DepositNonce(voucher.channelId, auth.salt);
  const receiveAuthOk = await verifyReceiveAuth(signer, {
    payer,
    asset: requirements.asset,
    name: extra.name,
    version: extra.version,
    chainId,
    amount: deposit.amount,
    validAfter,
    validBefore,
    nonce: erc3009Nonce,
    signature: innerSig,
  });

  if (!receiveAuthOk) {
    return reject(Errors.ErrInvalidReceiveAuthorizationSignature);
  }

  return { response: null, counterfactual: null };
}

/**
 * Verifies a `ReceiveWithAuthorization` signature.
 *
 * @param signer - Facilitator signer used for typed-data verification.
 * @param params - Authorization fields and signature.
 * @param params.payer - Expected authorization signer.
 * @param params.asset - ERC-20 verifying contract.
 * @param params.name - ERC-20 EIP-712 domain name.
 * @param params.version - ERC-20 EIP-712 domain version.
 * @param params.chainId - EVM chain id.
 * @param params.amount - Authorized token amount.
 * @param params.validAfter - Earliest valid timestamp.
 * @param params.validBefore - Expiration timestamp.
 * @param params.nonce - ERC-3009 nonce.
 * @param params.signature - Receive authorization signature.
 * @returns True when the signature matches the expected payer.
 */
async function verifyReceiveAuth(
  signer: FacilitatorEvmSigner,
  params: {
    payer: `0x${string}`;
    asset: string;
    name: string;
    version: string;
    chainId: number;
    amount: string;
    validAfter: bigint;
    validBefore: bigint;
    nonce: `0x${string}`;
    signature: `0x${string}`;
  },
): Promise<boolean> {
  // Mirror the token's on-chain ERC-3009 signature check. Modern tokens (USDC v2.2)
  // use a SignatureChecker that routes by code.length: ECDSA for EOAs, strict
  // EIP-1271 for any address with code (including 7702-delegated EOAs). No
  // ECDSA fallback for code addresses — that fallback would accept sigs the
  // token rejects on-chain.
  return verifyTypedDataSignature(signer, {
    address: getAddress(params.payer),
    domain: {
      name: params.name,
      version: params.version,
      chainId: params.chainId,
      verifyingContract: getAddress(params.asset),
    },
    types: receiveAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: getAddress(params.payer),
      to: getAddress(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
      value: BigInt(params.amount),
      validAfter: params.validAfter,
      validBefore: params.validBefore,
      nonce: params.nonce,
    },
    signature: params.signature,
  });
}
