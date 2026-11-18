import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "casper-js-sdk";
import {
  dictionaryKeyForAddress,
  dictionaryKeyForUsedNonces,
  getActiveContractForToken,
  isMissingDictionaryItem,
  readDictionaryBool,
  readDictionaryU256OrDefault,
} from "../../src/contracts";

type CasperRpcClient = InstanceType<typeof RpcClient>;

function createRpcClient(methods: Partial<CasperRpcClient>): CasperRpcClient {
  return methods as CasperRpcClient;
}

function contractPackageState(versions: unknown[], disabledVersions: number[][] = []) {
  return {
    storedValue: {
      contractPackage: {
        disabledVersions,
        versions,
      },
    },
  };
}

function contractState(entryPoints: { name: string }[] = []) {
  return {
    storedValue: {
      contract: {
        entryPoints,
      },
    },
  };
}

function dictionaryU256(value: string) {
  return {
    storedValue: {
      clValue: {
        ui256: { toString: () => value },
      },
    },
  };
}

function dictionaryBool(value: boolean) {
  return {
    storedValue: {
      clValue: {
        bool: { getValue: () => value },
      },
    },
  };
}

describe("Casper contract helpers", () => {
  it("loads the highest enabled contract version for a token package", async () => {
    const assetKey = "a5".repeat(32);
    const selectedContractHash = "5a".repeat(32);
    const queryLatestGlobalState = vi.fn(async (key: string) => {
      if (key === `hash-${assetKey}`) {
        return contractPackageState(
          [
            {
              contractVersion: 1,
              protocolVersionMajor: 1,
              contractHash: {
                hash: {
                  toHex: () => `hash-${"5a".repeat(32)}`,
                },
              },
            },
            {
              contractVersion: 1,
              protocolVersionMajor: 2,
              contractHash: {
                toJSON: () => `contract-${selectedContractHash}`,
              },
            },
            {
              contractVersion: 2,
              protocolVersionMajor: 2,
              contractHash: {
                hash: {
                  toHex: () => "0e".repeat(32),
                },
              },
            },
          ],
          [[2, 2]],
        );
      }

      if (key === `hash-${selectedContractHash}`) {
        return contractState([{ name: "transfer_with_authorization" }]);
      }

      throw new Error(`unexpected state key: ${key}`);
    });
    const rpcClient = createRpcClient({ queryLatestGlobalState });

    const result = await getActiveContractForToken(rpcClient, assetKey);

    expect(result.contractHash).toBe(`hash-${selectedContractHash}`);
    expect(result.entryPoints).toEqual([{ name: "transfer_with_authorization" }]);
    expect(queryLatestGlobalState).toHaveBeenNthCalledWith(1, `hash-${assetKey}`, []);
    expect(queryLatestGlobalState).toHaveBeenNthCalledWith(2, `hash-${selectedContractHash}`, []);
  });

  it("rejects token packages without an enabled contract version", async () => {
    const rpcClient = createRpcClient({
      queryLatestGlobalState: vi.fn(async () =>
        contractPackageState(
          [
            {
              contractVersion: 1,
              protocolVersionMajor: 1,
              contractHash: {
                hash: {
                  toHex: () => "b".repeat(64),
                },
              },
            },
          ],
          [[1, 1]],
        ),
      ),
    });

    await expect(getActiveContractForToken(rpcClient, "a".repeat(64))).rejects.toThrow(
      "contract package has no enabled versions",
    );
  });

  it("rejects token packages without versions", async () => {
    const rpcClient = createRpcClient({
      queryLatestGlobalState: vi.fn(async () => contractPackageState([])),
    });

    await expect(getActiveContractForToken(rpcClient, "a".repeat(64))).rejects.toThrow(
      "contract package has no active versions",
    );
  });

  it("rejects asset keys queries that are not token packages", async () => {
    const rpcClient = createRpcClient({
      queryLatestGlobalState: vi.fn(async () => ({ storedValue: {} })),
    });

    await expect(getActiveContractForToken(rpcClient, "a".repeat(64))).rejects.toThrow(
      "token package not found",
    );
  });

  it("rejects contract versions without a contract hash", async () => {
    const rpcClient = createRpcClient({
      queryLatestGlobalState: vi.fn(async () =>
        contractPackageState([
          {
            contractVersion: 1,
            protocolVersionMajor: 1,
            contractHash: {},
          },
        ]),
      ),
    });

    await expect(getActiveContractForToken(rpcClient, "a".repeat(64))).rejects.toThrow(
      "contract version is missing contract hash",
    );
  });

  it("wraps failures when the active contract state cannot be loaded", async () => {
    const assetKey = "a".repeat(64);
    const queryLatestGlobalState = vi.fn(async (key: string) => {
      if (key === `hash-${assetKey}`) {
        return contractPackageState([
          {
            contractVersion: 1,
            protocolVersionMajor: 1,
            contractHash: {
              hash: {
                toHex: () => "b".repeat(64),
              },
            },
          },
        ]);
      }

      return { storedValue: {} };
    });
    const rpcClient = createRpcClient({ queryLatestGlobalState });

    await expect(getActiveContractForToken(rpcClient, assetKey)).rejects.toThrow(
      "failed to get active contract for token: active contract not found",
    );
  });

  it("wraps non-error active contract lookup failures", async () => {
    const assetKey = "a".repeat(64);
    const queryLatestGlobalState = vi.fn(async (key: string) => {
      if (key === `hash-${assetKey}`) {
        return contractPackageState([
          {
            contractVersion: 1,
            protocolVersionMajor: 1,
            contractHash: {
              hash: {
                toHex: () => "b".repeat(64),
              },
            },
          },
        ]);
      }

      throw "rpc unavailable";
    });
    const rpcClient = createRpcClient({ queryLatestGlobalState });

    await expect(getActiveContractForToken(rpcClient, assetKey)).rejects.toThrow(
      "failed to get active contract for token: rpc unavailable",
    );
  });

  it("reads decimal U256 dictionary values as bigint", async () => {
    const getDictionaryItemByIdentifier = vi.fn(async () => dictionaryU256("123456789"));
    const rpcClient = createRpcClient({ getDictionaryItemByIdentifier });

    await expect(
      readDictionaryU256OrDefault(rpcClient, "hash-contract", "balances", "account-key"),
    ).resolves.toBe(123456789n);

    expect(getDictionaryItemByIdentifier).toHaveBeenCalledTimes(1);
  });

  it("returns zero for missing U256 dictionary items", async () => {
    const rpcClient = createRpcClient({
      getDictionaryItemByIdentifier: vi.fn(async () => {
        throw { sourceErr: { data: "Dictionary URef not found" } };
      }),
    });

    await expect(
      readDictionaryU256OrDefault(rpcClient, "hash-contract", "balances", "missing-key"),
    ).resolves.toBe(0n);
  });

  it("rejects malformed U256 dictionary values", async () => {
    const rpcClient = createRpcClient({
      getDictionaryItemByIdentifier: vi.fn(async () => dictionaryU256("12.5")),
    });

    await expect(
      readDictionaryU256OrDefault(rpcClient, "hash-contract", "balances", "account-key"),
    ).rejects.toThrow("invalid U256 dictionary value");
  });

  it("propagates non-missing U256 dictionary errors", async () => {
    const rpcClient = createRpcClient({
      getDictionaryItemByIdentifier: vi.fn(async () => {
        throw new Error("rpc failed");
      }),
    });

    await expect(
      readDictionaryU256OrDefault(rpcClient, "hash-contract", "balances", "account-key"),
    ).rejects.toThrow("rpc failed");
  });

  it("parses bool dictionary values and rejects malformed bool entries", async () => {
    const validRpcClient = createRpcClient({
      getDictionaryItemByIdentifier: vi.fn(async () => dictionaryBool(true)),
    });
    await expect(
      readDictionaryBool(validRpcClient, "hash-contract", "authorization_state", "nonce-key"),
    ).resolves.toBe(true);

    const invalidRpcClient = createRpcClient({
      getDictionaryItemByIdentifier: vi.fn(async () => ({ storedValue: { clValue: {} } })),
    });
    await expect(
      readDictionaryBool(invalidRpcClient, "hash-contract", "authorization_state", "nonce-key"),
    ).rejects.toThrow("invalid used_nonces dictionary value");
  });

  it("detects only missing dictionary item errors", () => {
    expect(isMissingDictionaryItem({ sourceErr: { data: "dictionary URef not found" } })).toBe(
      true,
    );
    expect(isMissingDictionaryItem({ sourceErr: { data: "permission denied" } })).toBe(false);
    expect(isMissingDictionaryItem(new Error("dictionary URef not found"))).toBe(false);
  });

  it("encodes dictionary keys for account addresses and used nonces", () => {
    const zeroAccountHash = `00${"00".repeat(32)}`;
    const repeatedNonce = "11".repeat(32);

    expect(dictionaryKeyForAddress(zeroAccountHash)).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(dictionaryKeyForUsedNonces(zeroAccountHash, repeatedNonce)).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAERERERERERERERERERERERERERERERERERERERERERE=",
    );
  });
});
