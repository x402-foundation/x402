/**
 * @file Encoding helpers for the Hedera HTS-allowance deposit collector.
 */
import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import { HEDERA_ALLOWANCE_DEPOSIT_TYPEHASH } from "./constants";

/**
 * Encodes the `collectorData` payload for `HederaAllowanceDepositCollector.collect()`:
 * `abi.encode(nonce, deadline, signature)`.
 *
 * @param nonce - Payer-chosen unique nonce (decimal string).
 * @param deadline - Unix timestamp after which the authorization is invalid (decimal string).
 * @param signature - Raw Hedera account signature (64-byte ED25519 or 65-byte ECDSA) over the deposit digest.
 * @returns ABI-encoded collector data passed to `deposit(..., collector, collectorData)`.
 */
export function buildHederaAllowanceCollectorData(
  nonce: string,
  deadline: string,
  signature: `0x${string}`,
): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    [BigInt(nonce), BigInt(deadline), signature],
  );
}

/**
 * Computes the digest the payer signs to authorize one deposit through the collector.
 * Mirrors `HederaAllowanceDepositCollector.getDepositDigest`:
 * `keccak256(abi.encode(DEPOSIT_TYPEHASH, channelId, token, amount, nonce, deadline, collector, chainId))`.
 *
 * @param params - Deposit binding fields.
 * @param params.channelId - Channel receiving the deposit.
 * @param params.token - HTS token EVM address.
 * @param params.amount - Deposit amount in token base units (decimal string).
 * @param params.nonce - Payer-chosen unique nonce (decimal string).
 * @param params.deadline - Authorization deadline (unix seconds, decimal string).
 * @param params.collector - Deposit collector contract address.
 * @param params.chainId - Hedera EVM chain id (295 / 296).
 * @returns The 32-byte digest.
 */
export function computeHederaAllowanceDepositDigest(params: {
  channelId: `0x${string}`;
  token: `0x${string}`;
  amount: string;
  nonce: string;
  deadline: string;
  collector: `0x${string}`;
  chainId: number;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        HEDERA_ALLOWANCE_DEPOSIT_TYPEHASH,
        params.channelId,
        getAddress(params.token),
        BigInt(params.amount),
        BigInt(params.nonce),
        BigInt(params.deadline),
        getAddress(params.collector),
        BigInt(params.chainId),
      ],
    ),
  );
}
