/**
 * Builds `authorization` bytes for MockTransferExecutor.
 *
 * authorization = abi.encode(uint8 mode, uint256 validBefore, bytes32 binding, bytes32 nonce)
 *
 * `binding` is `bindingOf(from, asset, to, amount)`, which the contract computes. It is read
 * from the contract through the mirror node, so this helper needs no Keccak implementation
 * and the value is the one the executor will check.
 */
import { randomBytes } from "node:crypto";

/**
 * Behaviours of MockTransferExecutor, one per corner case. Values match the contract.
 */
export const MockMode = {
  OK: 0,
  REVERT: 1,
  NOOP: 2,
  OVERPAY: 3,
  EXTRA_CREDIT: 4,
  LOG_CALLER_TRANSFER: 5,
  OK_NO_CONSUME: 6,
  BURN_GAS: 7,
  UNDERPAY: 8,
  OK_THEN_BURN_GAS: 9,
} as const;

export type MockModeValue = (typeof MockMode)[keyof typeof MockMode];

/**
 * Selector of `bindingOf(address,address,address,uint256)` (`cast sig`), a constant so this
 * helper needs no Keccak implementation.
 */
const BINDING_OF_SELECTOR = "0xba86839b";

/**
 * Left-pads a hex string to one ABI word.
 *
 * @param hex - Hex digits without a prefix
 * @returns 64 hex characters
 */
function word(hex: string): string {
  return hex.padStart(64, "0");
}

/**
 * Returns the EVM address of a Hedera entity in long-zero form.
 *
 * @param entityId - `shard.realm.num`
 * @returns 0x-hex address
 */
function longZero(entityId: string): string {
  const [shard, realm, num] = entityId.split(".").map(part => BigInt(part));
  const hex = (value: bigint, width: number) => value.toString(16).padStart(width, "0");
  return `0x${hex(shard, 8)}${hex(realm, 16)}${hex(num, 16)}`;
}

/**
 * Asks the executor for the binding of a transfer, via the mirror node's `contracts/call`.
 *
 * @param params - Where and what to ask
 * @param params.mirrorNodeUrl - Mirror node base URL
 * @param params.executorId - Executor contract id
 * @param params.from - Payer EVM address
 * @param params.asset - Asset EVM address (zero for HBAR)
 * @param params.to - Payee EVM address
 * @param params.amount - Amount in base units
 * @returns 0x-hex bytes32 binding
 */
export async function readBinding(params: {
  mirrorNodeUrl: string;
  executorId: string;
  from: string;
  asset: string;
  to: string;
  amount: bigint;
}): Promise<string> {
  // bindingOf(address,address,address,uint256)
  const data =
    BINDING_OF_SELECTOR +
    word(params.from.slice(2)) +
    word(params.asset.slice(2)) +
    word(params.to.slice(2)) +
    word(params.amount.toString(16));
  const response = await fetch(`${params.mirrorNodeUrl}/api/v1/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: longZero(params.executorId), data, estimate: false }),
  });
  if (!response.ok) {
    throw new Error(`bindingOf call failed: ${response.status} ${await response.text()}`);
  }
  const { result } = (await response.json()) as { result: string };
  return result;
}

/**
 * Builds the authorization for one transfer.
 *
 * @param params - Authorization fields
 * @param params.mode - Behaviour the mock should show
 * @param params.binding - From `readBinding`; pass a different value to model a mismatch
 * @param params.validBefore - Unix seconds the authorization expires; defaults to 10 minutes out
 * @param params.nonce - 32 bytes making the authorization unique; defaults to random
 * @returns 0x-hex authorization
 */
export function buildMockAuthorization(params: {
  mode: MockModeValue;
  binding: string;
  validBefore?: bigint;
  nonce?: string;
}): string {
  const validBefore = params.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce = params.nonce ?? `0x${randomBytes(32).toString("hex")}`;
  return (
    "0x" +
    word(params.mode.toString(16)) +
    word(validBefore.toString(16)) +
    word(params.binding.slice(2)) +
    word(nonce.slice(2))
  );
}
