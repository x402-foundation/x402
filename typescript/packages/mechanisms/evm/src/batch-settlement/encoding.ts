/**
 * @file Encoding helpers for batch-settlement deposit collectors.
 */
import { encodeAbiParameters, keccak256 } from "viem";

/**
 * Computes the ERC-3009 nonce used by the deposit collector:
 * `keccak256(abi.encode(channelId, salt))`.
 *
 * @param channelId - The `bytes32` channel id binding the authorization to a channel.
 * @param salt - Random salt provided by the client to make the nonce unique per deposit.
 * @returns The `bytes32` ERC-3009 nonce.
 */
export function buildErc3009DepositNonce(
  channelId: `0x${string}`,
  salt: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [channelId, BigInt(salt)]),
  );
}

/**
 * Encodes the `collectorData` payload for `ERC3009DepositCollector.collect()`:
 * `abi.encode(validAfter, validBefore, salt, signature)`.
 *
 * @param validAfter - Earliest unix timestamp the authorization is valid (decimal string).
 * @param validBefore - Latest unix timestamp the authorization is valid (decimal string).
 * @param salt - Random salt provided by the client (hex string).
 * @param signature - ERC-3009 `ReceiveWithAuthorization` signature.
 * @returns ABI-encoded collector data passed to `deposit(..., collector, collectorData)`.
 */
export function buildErc3009CollectorData(
  validAfter: string,
  validBefore: string,
  salt: `0x${string}`,
  signature: `0x${string}`,
): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    [BigInt(validAfter), BigInt(validBefore), BigInt(salt), signature],
  );
}

/**
 * Encodes optional EIP-2612 permit data consumed by `Permit2DepositCollector`.
 *
 * @param params - Permit amount, deadline, and split signature fields.
 * @param params.value - Approved Permit2 allowance value.
 * @param params.deadline - EIP-2612 permit deadline.
 * @param params.v - Signature recovery id.
 * @param params.r - Signature `r` value.
 * @param params.s - Signature `s` value.
 * @returns ABI-encoded permit segment.
 */
export function buildEip2612PermitData(params: {
  value: string;
  deadline: string;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint8" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [BigInt(params.value), BigInt(params.deadline), params.v, params.r, params.s],
  );
}

/**
 * Encodes the `collectorData` payload for `Permit2DepositCollector.collect()`.
 *
 * @param nonce - Permit2 transfer nonce.
 * @param deadline - Permit2 transfer deadline.
 * @param permit2Signature - Signature over the channel-bound Permit2 authorization.
 * @param eip2612PermitData - Optional encoded EIP-2612 permit segment.
 * @returns ABI-encoded collector data passed to `deposit`.
 */
export function buildPermit2CollectorData(
  nonce: string,
  deadline: string,
  permit2Signature: `0x${string}`,
  eip2612PermitData: `0x${string}` = "0x",
): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes" }],
    [BigInt(nonce), BigInt(deadline), permit2Signature, eip2612PermitData],
  );
}
