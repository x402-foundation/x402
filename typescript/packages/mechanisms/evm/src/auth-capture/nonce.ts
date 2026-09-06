/**
 * Nonce computation, salt generation, and signing helpers.
 */

import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  toHex,
  zeroAddress,
} from "viem";
import type { ClientEvmSigner, FacilitatorEvmSigner } from "../signer";
import { verifyTypedDataSignature } from "../shared/verifySignature";
import { PERMIT2_ADDRESS } from "../constants";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  PERMIT2_TRANSFER_FROM_TYPES,
  RECEIVE_AUTHORIZATION_TYPES,
  SALT_BINDING_TYPEHASH,
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
 * Encode PaymentInfo the way AuthCaptureEscrow.getHash does: typehash plus
 * struct fields, then wrap with chain id and escrow address.
 *
 * @param chainId - EVM chain id; binds the hash to a specific chain.
 * @param paymentInfo - Canonical PaymentInfo struct.
 * @param payer - Payer encoded in the struct hash. Pass `zeroAddress` for the
 *   payer-agnostic signature nonce.
 * @param escrowAddress - AuthCaptureEscrow bound into the outer hash.
 * @returns The 32-byte hash.
 */
function hashPaymentInfo(
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  payer: `0x${string}`,
  escrowAddress: `0x${string}` = AUTH_CAPTURE_ESCROW_ADDRESS,
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
      payer,
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
    [BigInt(chainId), escrowAddress, paymentInfoHash],
  );

  return keccak256(outerEncoded);
}

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
 * @param escrowAddress - AuthCaptureEscrow bound into the outer hash.
 * @returns The 32-byte hash to use as the nonce on the wire.
 */
export function computePayerAgnosticPaymentInfoHash(
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  escrowAddress: `0x${string}` = AUTH_CAPTURE_ESCROW_ADDRESS,
): `0x${string}` {
  return hashPaymentInfo(chainId, paymentInfo, zeroAddress, escrowAddress);
}

/**
 * Compute AuthCaptureEscrow.getHash(paymentInfo) locally. Differs from the
 * signature nonce by encoding the real payer rather than address(0).
 *
 * @param chainId - EVM chain id.
 * @param paymentInfo - PaymentInfo with the real payer.
 * @param escrowAddress - AuthCaptureEscrow bound into the outer hash.
 * @returns The escrow payment identifier (`paymentInfoHash`).
 */
export function computePaymentInfoHash(
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  escrowAddress: `0x${string}` = AUTH_CAPTURE_ESCROW_ADDRESS,
): `0x${string}` {
  return hashPaymentInfo(chainId, paymentInfo, paymentInfo.payer, escrowAddress);
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
 * Verify an ERC-3009 `ReceiveWithAuthorization` signature against the supplied
 * authorization fields. Mirrors `signERC3009`: the EIP-712 domain is bound to
 * the **token contract**, with `name`/`version` from `extra`.
 *
 * Routed through {@link verifyTypedDataSignature} rather than
 * `signer.verifyTypedData` so pre-verify matches on-chain SignatureChecker
 * semantics: no ECDSA fallback when EIP-1271 returns failure, which otherwise
 * accepts signatures the token contract rejects for any payer with code.
 *
 * @param signer - Facilitator signer used for `eth_getCode` / `isValidSignature`.
 * @param authorization - The ERC-3009 authorization to verify.
 * @param signature - The signature blob from the payer.
 * @param extra - Carries the token EIP-712 domain `name`, `version`, and the chain id.
 * @param tokenAddress - Address of the token contract (verifyingContract in the domain).
 * @returns True if the signature is valid for `authorization.from`; false otherwise.
 */
export async function verifyERC3009Signature(
  signer: FacilitatorEvmSigner,
  authorization: Eip3009Payload["authorization"],
  signature: `0x${string}`,
  extra: AuthCaptureExtra & { chainId: number },
  tokenAddress: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(signer, {
    address: getAddress(authorization.from),
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: extra.chainId,
      verifyingContract: getAddress(tokenAddress),
    },
    types: RECEIVE_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
    signature,
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
 * Verify a Permit2 `PermitTransferFrom` signature against the supplied permit
 * fields. Mirrors `signPermit2`: domain bound to the canonical Permit2
 * contract. Routed through {@link verifyTypedDataSignature} so pre-verify
 * matches Permit2's own `SignatureVerification` semantics.
 *
 * @param signer - Facilitator signer used for `eth_getCode` / `isValidSignature`.
 * @param permit - The Permit2 PermitTransferFrom message to verify.
 * @param signature - The signature blob from the payer.
 * @param chainId - EVM chain id (chainId in the Permit2 domain).
 * @returns True if the signature is valid for `permit.from`; false otherwise.
 */
export async function verifyPermit2Signature(
  signer: FacilitatorEvmSigner,
  permit: Permit2Payload["permit2Authorization"],
  signature: `0x${string}`,
  chainId: number,
): Promise<boolean> {
  return verifyTypedDataSignature(signer, {
    address: getAddress(permit.from),
    domain: {
      name: "Permit2",
      chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: PERMIT2_TRANSFER_FROM_TYPES,
    primaryType: "PermitTransferFrom",
    message: {
      permitted: {
        token: getAddress(permit.permitted.token),
        amount: BigInt(permit.permitted.amount),
      },
      spender: getAddress(permit.spender),
      nonce: BigInt(permit.nonce),
      deadline: BigInt(permit.deadline),
    },
    signature,
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

/**
 * Zero-pad a 0x-prefixed hex integer to a full 32-byte word.
 *
 * @param value - Hex string, with or without `0x`.
 * @returns 66-character `0x`-prefixed hex.
 */
export function normalizeBytes32(value: string): `0x${string}` {
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0 || hex.length > 64) {
    throw new Error(`Invalid bytes32: ${value}`);
  }
  return `0x${hex.padStart(64, "0").toLowerCase()}` as `0x${string}`;
}

/**
 * Treat absent or invalid values as the zero address; otherwise checksum.
 *
 * @param value - Candidate address from extra or config.
 * @returns Checksummed address, or the zero address when absent.
 */
export function extraAddress(value: string | undefined): `0x${string}` {
  if (!value || !isAddress(value)) return zeroAddress;
  return getAddress(value);
}

/**
 * Whether `value` is a non-zero EVM address.
 *
 * @param value - Candidate address.
 * @returns True when `value` is a valid address other than address(0).
 */
export function isNonZeroAddress(value: string | undefined): boolean {
  if (!value || !isAddress(value)) return false;
  return !isAddressEqual(getAddress(value), zeroAddress);
}

/**
 * Salt binding is on when either `receiverAuthorizer` or `policy` is non-zero.
 * Absent fields are the zero address.
 *
 * @param extra - Wire extra (or a subset with the two address fields).
 * @param extra.receiverAuthorizer - Optional receiver authorizer; absent is the zero address.
 * @param extra.policy - Optional policy contract; absent is the zero address.
 * @returns True when the client must emit `saltNonce` and a keccak salt.
 */
export function isSaltBindingOn(extra: { receiverAuthorizer?: string; policy?: string }): boolean {
  return isNonZeroAddress(extra.receiverAuthorizer) || isNonZeroAddress(extra.policy);
}

/**
 * Bound PaymentInfo.salt: keccak256(abi.encode(SALT_BINDING_TYPEHASH,
 * receiverAuthorizer, policy, saltNonce)).
 *
 * @param receiverAuthorizer - extra.receiverAuthorizer, or the zero address.
 * @param policy - extra.policy, or the zero address.
 * @param saltNonce - Client's random 32-byte contribution.
 * @returns 32-byte salt commitment.
 */
export function deriveBoundSalt(
  receiverAuthorizer: `0x${string}`,
  policy: `0x${string}`,
  saltNonce: `0x${string}`,
): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      { name: "typehash", type: "bytes32" },
      { name: "receiverAuthorizer", type: "address" },
      { name: "policy", type: "address" },
      { name: "saltNonce", type: "uint256" },
    ],
    [SALT_BINDING_TYPEHASH, receiverAuthorizer, policy, BigInt(saltNonce)],
  );
  return keccak256(encoded);
}
