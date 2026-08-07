/**
 * Nonce computation, salt generation, and signing helpers.
 */

import { encodeAbiParameters, getAddress, keccak256, toHex, zeroAddress } from "viem";
import type { ClientEvmSigner } from "../signer";
import { PERMIT2_ADDRESS } from "../constants";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  PERMIT2_TRANSFER_FROM_TYPES,
  RECEIVE_AUTHORIZATION_TYPES,
} from "./constants";
import type { AuthCaptureExtra, Eip3009Payload, PaymentInfoStruct, Permit2Payload } from "./types";

/**
 * PaymentInfo typehash — must match AuthCaptureEscrow.PAYMENT_INFO_TYPEHASH.
 */
const PAYMENT_INFO_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)",
  ),
);

/**
 * Compute the payer-agnostic PaymentInfo hash that auth-capture uses as both
 * the ERC-3009 nonce (`bytes32`) and the Permit2 nonce (`uint256`, via the
 * same 32 bytes interpreted as an integer). The payer field is zeroed before
 * hashing so the facilitator can reconstruct the same hash on the verify side
 * without knowing payer identity in advance.
 *
 * Freshness comes from `paymentInfo.salt`; generate a new salt per signing
 * call via `generateSalt`. Identical extras + same salt would collide across
 * payers.
 *
 * @param chainId - EVM chain id; binds the hash to a specific chain.
 * @param paymentInfo - The reconstructed PaymentInfo struct (canonical Solidity field names).
 * @returns The 32-byte hash to use as the nonce on the wire.
 */
export function computePayerAgnosticPaymentInfoHash(
  chainId: number,
  paymentInfo: PaymentInfoStruct,
): `0x${string}` {
  const paymentInfoEncoded = encodeAbiParameters(
    [
      { name: "typehash", type: "bytes32" },
      { name: "operator", type: "address" },
      { name: "payer", type: "address" },
      { name: "receiver", type: "address" },
      { name: "token", type: "address" },
      { name: "maxAmount", type: "uint120" },
      { name: "preApprovalExpiry", type: "uint48" },
      { name: "authorizationExpiry", type: "uint48" },
      { name: "refundExpiry", type: "uint48" },
      { name: "minFeeBps", type: "uint16" },
      { name: "maxFeeBps", type: "uint16" },
      { name: "feeReceiver", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    [
      PAYMENT_INFO_TYPEHASH,
      paymentInfo.operator,
      zeroAddress,
      paymentInfo.receiver,
      paymentInfo.token,
      BigInt(paymentInfo.maxAmount),
      paymentInfo.preApprovalExpiry,
      paymentInfo.authorizationExpiry,
      paymentInfo.refundExpiry,
      paymentInfo.minFeeBps,
      paymentInfo.maxFeeBps,
      paymentInfo.feeReceiver,
      BigInt(paymentInfo.salt),
    ],
  );
  const paymentInfoHash = keccak256(paymentInfoEncoded);

  const outerEncoded = encodeAbiParameters(
    [
      { name: "chainId", type: "uint256" },
      { name: "escrow", type: "address" },
      { name: "paymentInfoHash", type: "bytes32" },
    ],
    [BigInt(chainId), AUTH_CAPTURE_ESCROW_ADDRESS, paymentInfoHash],
  );

  return keccak256(outerEncoded);
}

/**
 * Sign an ERC-3009 `ReceiveWithAuthorization` over the supplied authorization
 * fields. The EIP-712 domain is bound to the **token contract** (not the
 * escrow), so the token's `name` and `version` come from `extra` because they
 * vary per asset (e.g. `"USDC"` on Sepolia vs `"USD Coin"` on mainnet).
 *
 * @param signer - Client signer with `signTypedData`.
 * @param authorization - The ERC-3009 authorization to sign.
 * @param extra - Carries the token EIP-712 domain `name` + `version`.
 * @param tokenAddress - Address of the token contract (verifyingContract in the domain).
 * @param chainId - EVM chain id (chainId in the domain).
 * @returns The 65-byte ECDSA signature (or EIP-1271 / EIP-6492 envelope, depending on the signer).
 */
export async function signERC3009(
  signer: ClientEvmSigner,
  authorization: Eip3009Payload["authorization"],
  extra: AuthCaptureExtra,
  tokenAddress: `0x${string}`,
  chainId: number,
): Promise<`0x${string}`> {
  const domain = {
    name: extra.name,
    version: extra.version,
    chainId,
    verifyingContract: getAddress(tokenAddress),
  };

  const message = {
    from: getAddress(authorization.from),
    to: getAddress(authorization.to),
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  };

  return signer.signTypedData({
    domain,
    types: RECEIVE_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message,
  });
}

/**
 * Sign a Permit2 `PermitTransferFrom` over the supplied permit fields. Domain
 * is bound to the canonical Permit2 contract. No witness struct is needed —
 * the deterministic nonce (the payer-agnostic PaymentInfo hash, packed into
 * uint256) cryptographically binds all payment parameters including receiver,
 * amount, and deadlines.
 *
 * @param signer - Client signer with `signTypedData`.
 * @param permit - The Permit2 PermitTransferFrom message to sign.
 * @param chainId - EVM chain id (chainId in the Permit2 domain).
 * @returns The 65-byte ECDSA signature (or EIP-1271 / EIP-6492 envelope, depending on the signer).
 */
export async function signPermit2(
  signer: ClientEvmSigner,
  permit: Permit2Payload["permit2Authorization"],
  chainId: number,
): Promise<`0x${string}`> {
  const domain = {
    name: "Permit2",
    chainId,
    verifyingContract: PERMIT2_ADDRESS,
  };

  const message = {
    permitted: {
      token: getAddress(permit.permitted.token),
      amount: BigInt(permit.permitted.amount),
    },
    spender: getAddress(permit.spender),
    nonce: BigInt(permit.nonce),
    deadline: BigInt(permit.deadline),
  };

  return signer.signTypedData({
    domain,
    types: PERMIT2_TRANSFER_FROM_TYPES,
    primaryType: "PermitTransferFrom",
    message,
  });
}

/**
 * Generate a fresh cryptographically-random 32-byte salt. MUST be called once
 * per signing request — never reuse across requests. Freshness is required
 * because the nonce derivation zeroes the payer field; identical extras with
 * the same salt would collide across payers.
 *
 * @returns A new 32-byte salt as a `0x`-prefixed hex string.
 */
export function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
