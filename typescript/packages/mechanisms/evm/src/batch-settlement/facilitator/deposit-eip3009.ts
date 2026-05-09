import { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { getAddress } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import { BatchSettlementDepositPayload } from "../types";
import { ERC3009_DEPOSIT_COLLECTOR_ADDRESS, receiveAuthorizationTypes } from "../constants";
import { buildErc3009CollectorData, buildErc3009DepositNonce } from "../encoding";
import * as Errors from "../errors";
import { erc3009AuthorizationTimeInvalidReason } from "./utils";

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

  return buildErc3009CollectorData(auth.validAfter, auth.validBefore, auth.salt, auth.signature);
}

/**
 * Verifies the ERC-3009 authorization fields and typed-data signature.
 *
 * @param signer - Facilitator signer for typed-data verification.
 * @param payload - Deposit payload to verify.
 * @param requirements - Payment requirements containing token domain metadata.
 * @param chainId - EVM chain id.
 * @returns A failure response, or `null` when valid.
 */
export async function verifyEip3009DepositAuthorization(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  chainId: number,
): Promise<VerifyResponse | null> {
  const { deposit, voucher } = payload;
  const payer = payload.channelConfig.payer;
  const auth = deposit.authorization.erc3009Authorization;

  if (!auth) {
    return { isValid: false, invalidReason: Errors.ErrErc3009AuthorizationRequired, payer };
  }

  const extra = requirements.extra as { name?: string; version?: string } | undefined;
  if (!extra?.name || !extra?.version) {
    return { isValid: false, invalidReason: Errors.ErrMissingEip712Domain, payer };
  }

  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  const timeInvalid = erc3009AuthorizationTimeInvalidReason(validAfter, validBefore);
  if (timeInvalid) {
    return { isValid: false, invalidReason: timeInvalid, payer };
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
    signature: auth.signature,
  });

  if (!receiveAuthOk) {
    return { isValid: false, invalidReason: Errors.ErrInvalidReceiveAuthorizationSignature, payer };
  }

  return null;
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
  try {
    return await signer.verifyTypedData({
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
  } catch {
    return false;
  }
}
