import { HEDERA_HBAR_EVM_ADDRESS, HEDERA_EXECUTE_TRANSFER_SELECTOR } from "../../constants";
import { isHbarAsset, isValidHederaEntityId, isValidHexBytes } from "../../utils";

const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
/**
 * Byte offset of the `bytes` argument: five head words of 32 bytes.
 */
const AUTHORIZATION_OFFSET = 5n * 32n;

/**
 * Returns the long-zero EVM address of a Hedera entity: shard in 4 bytes,
 * realm in 8 and num in 8.
 *
 * @param entityId - Entity id in `shard.realm.num` form
 * @returns Lowercase 0x-hex address
 * @throws Error when the id is malformed or a part is out of range
 */
export function toLongZeroAddress(entityId: string): string {
  if (!isValidHederaEntityId(entityId)) {
    throw new Error(`Not a Hedera entity id: ${entityId}`);
  }
  const [shard, realm, num] = entityId.split(".").map(part => BigInt(part));
  if (shard >= 1n << 32n || realm >= 1n << 64n || num >= 1n << 64n) {
    throw new Error(`Hedera entity id out of range: ${entityId}`);
  }
  return `0x${toHex(shard, 8)}${toHex(realm, 16)}${toHex(num, 16)}`;
}

/**
 * Returns the `executeTransfer` asset address: the zero address for HBAR,
 * otherwise the token's long-zero address.
 *
 * @param asset - `"0.0.0"` or an HTS token id
 * @returns Lowercase 0x-hex address
 */
export function toEvmAssetAddress(asset: string): string {
  return isHbarAsset(asset) ? HEDERA_HBAR_EVM_ADDRESS : toLongZeroAddress(asset);
}

/**
 * Returns true when the value fits an ABI `uint256`.
 *
 * @param value - Value to check
 * @returns True for 0 through 2^256 - 1
 */
export function isUint256(value: bigint): boolean {
  return value >= 0n && value <= MAX_UINT256;
}

/**
 * ABI-encodes `executeTransfer(address,address,address,uint256,bytes)`.
 *
 * @param args - Call arguments
 * @param args.from - Payer EVM address
 * @param args.asset - Asset EVM address
 * @param args.to - Payee EVM address
 * @param args.amount - Amount in the asset's smallest unit
 * @param args.authorization - 0x-hex authorization, passed through unread
 * @returns Lowercase 0x-hex calldata, selector included
 * @throws Error when an argument cannot be encoded
 */
export function encodeExecuteTransferCall(args: {
  from: string;
  asset: string;
  to: string;
  amount: bigint;
  authorization: string;
}): string {
  if (!isUint256(args.amount)) {
    throw new Error(`executeTransfer amount out of uint256 range: ${args.amount}`);
  }
  if (!isValidHexBytes(args.authorization)) {
    throw new Error("executeTransfer authorization must be 0x-prefixed hex bytes");
  }
  const authorization = args.authorization.slice(2);
  const byteLength = authorization.length / 2;
  const paddedLength = Math.ceil(byteLength / 32) * 64;
  return [
    HEDERA_EXECUTE_TRANSFER_SELECTOR,
    encodeAddress(args.from),
    encodeAddress(args.asset),
    encodeAddress(args.to),
    toHex(args.amount, 64),
    toHex(AUTHORIZATION_OFFSET, 64),
    toHex(BigInt(byteLength), 64),
    authorization.padEnd(paddedLength, "0"),
  ]
    .join("")
    .toLowerCase();
}

/**
 * Left-pads an EVM address to one ABI word.
 *
 * @param address - 0x-hex EVM address
 * @returns 64 hex characters
 * @throws Error when the address is malformed
 */
function encodeAddress(address: string): string {
  if (!EVM_ADDRESS_REGEX.test(address)) {
    throw new Error(`Not an EVM address: ${address}`);
  }
  return address.slice(2).padStart(64, "0");
}

/**
 * Formats a non-negative integer as zero-padded hex.
 *
 * @param value - Value to format
 * @param width - Number of hex characters
 * @returns Hex without a prefix
 */
function toHex(value: bigint, width: number): string {
  return value.toString(16).padStart(width, "0");
}
