import { describe, expect, it } from "vitest";
import { ContractId } from "@hiero-ledger/sdk";
import {
  encodeExecuteTransferCall,
  toLongZeroAddress,
} from "../../src/exact/facilitator/executeTransferCall";

const FROM = "0x1111111111111111111111111111111111111111";
const ASSET = "0x0000000000000000000000000000000000000000";
const TO = "0x2222222222222222222222222222222222222222";

/**
 * Builds valid `executeTransfer` arguments.
 *
 * @param overrides - Fields to replace
 * @returns Call arguments
 */
function createArgs(overrides: Partial<Parameters<typeof encodeExecuteTransferCall>[0]> = {}) {
  return {
    from: FROM,
    asset: ASSET,
    to: TO,
    amount: 1000n,
    authorization: "0xabcdef",
    ...overrides,
  };
}

/**
 * Returns the ABI word at an index, counting from the first word after the selector.
 *
 * @param calldata - 0x-hex calldata
 * @param index - Word index
 * @returns 64 hex characters
 */
function word(calldata: string, index: number): string {
  const start = 2 + 8 + index * 64;
  return calldata.slice(start, start + 64);
}

describe("toLongZeroAddress", () => {
  it("packs shard, realm and num into 4, 8 and 8 bytes", () => {
    expect(toLongZeroAddress("1.2.3")).toBe("0x0000000100000000000000020000000000000003");
    expect(toLongZeroAddress("1.2.3")).toBe(
      `0x${ContractId.fromString("1.2.3").toSolidityAddress()}`,
    );
  });

  it("encodes the largest shard, realm and num", () => {
    expect(toLongZeroAddress("4294967295.18446744073709551615.18446744073709551615")).toBe(
      "0xffffffffffffffffffffffffffffffffffffffff",
    );
  });

  // The SDK wraps 0.0.2^64 to the zero address; a wider part must not alias another entity.
  it.each([
    ["shard", "4294967296.0.0"],
    ["realm", "0.18446744073709551616.0"],
    ["num", "0.0.18446744073709551616"],
  ])("rejects a %s too wide for its field", (_, entityId) => {
    expect(() => toLongZeroAddress(entityId)).toThrow("out of range");
  });

  it.each(["0.0", "0.0.-1", "0.0.1.2", "0x0000000000000000000000000000000000001b58"])(
    "rejects %s, which is not an entity id",
    entityId => {
      expect(() => toLongZeroAddress(entityId)).toThrow("Not a Hedera entity id");
    },
  );
});

describe("encodeExecuteTransferCall: guards", () => {
  it("encodes the largest uint256 amount", () => {
    const calldata = encodeExecuteTransferCall(createArgs({ amount: 2n ** 256n - 1n }));

    expect(word(calldata, 3)).toBe("f".repeat(64));
  });

  it.each([
    ["negative", -1n],
    ["above 2^256 - 1", 2n ** 256n],
  ])("throws on an amount that is %s instead of truncating it", (_, amount) => {
    expect(() => encodeExecuteTransferCall(createArgs({ amount }))).toThrow("uint256 range");
  });

  it.each(["abcdef", "0xabc", "0xzz"])(
    "throws on authorization %s, which is not 0x-hex bytes",
    authorization => {
      expect(() => encodeExecuteTransferCall(createArgs({ authorization }))).toThrow(
        "0x-prefixed hex bytes",
      );
    },
  );
});
