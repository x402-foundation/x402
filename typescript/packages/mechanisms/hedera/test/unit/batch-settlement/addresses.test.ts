import { describe, expect, it } from "vitest";
import {
  contractIdFromEvmAddress,
  entityIdToLongZeroAddress,
  getHederaChainId,
  isLongZeroAddress,
  longZeroAddressToEntityId,
  tokenIdToEvmAddress,
} from "../../../src/batch-settlement";

describe("addresses", () => {
  it("maps networks to chain ids", () => {
    expect(getHederaChainId("hedera:testnet")).toBe(296);
    expect(getHederaChainId("hedera:mainnet")).toBe(295);
    expect(() => getHederaChainId("eip155:296")).toThrow();
  });

  it("derives long-zero addresses", () => {
    expect(entityIdToLongZeroAddress("0.0.4660")).toBe(
      "0x0000000000000000000000000000000000001234",
    );
    expect(tokenIdToEvmAddress("0.0.429274")).toBe("0x0000000000000000000000000000000000068cDa");
    expect(() => entityIdToLongZeroAddress("abc")).toThrow();
  });

  it("round-trips long-zero addresses", () => {
    expect(isLongZeroAddress("0x0000000000000000000000000000000000068cDa")).toBe(true);
    expect(isLongZeroAddress("0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003")).toBe(false);
    expect(longZeroAddressToEntityId("0x0000000000000000000000000000000000068cDa")).toBe(
      "0.0.429274",
    );
    expect(contractIdFromEvmAddress("0x0000000000000000000000000000000000068cDa").toString()).toBe(
      "0.0.429274",
    );
    expect(
      contractIdFromEvmAddress("0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003").evmAddress,
    ).toBeTruthy();
  });
});
