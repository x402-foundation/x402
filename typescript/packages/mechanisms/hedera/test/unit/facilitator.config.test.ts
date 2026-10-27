import { describe, expect, it } from "vitest";
import {
  getAdmittedExecutors,
  isExecutorAdmitted,
  isTransferExecutorEnabled,
  parseTransferExecutorConfig,
  TRANSFER_EXECUTOR_SIGNER_CAPABILITIES,
  type HederaTransferExecutorConfig,
} from "../../src/exact/facilitator/config";
import { createStubTransferExecutorSigner } from "../helpers/transferExecutor";

const TESTNET = "hedera:testnet";
const MAINNET = "hedera:mainnet";

describe("parseTransferExecutorConfig", () => {
  it("returns undefined for an absent config", () => {
    expect(parseTransferExecutorConfig(undefined)).toBeUndefined();
  });

  it("accepts a wildcard, an entity id and a ceiling up to gasLimit", () => {
    const executors = { [TESTNET]: ["*"], [MAINNET]: ["0.0.7000"] };
    expect(
      parseTransferExecutorConfig({
        executors,
        gasLimit: 15_000_000,
        simulationGasCeiling: 15_000_000,
      }),
    ).toEqual({ executors, gasLimit: 15_000_000, simulationGasCeiling: 15_000_000 });
  });

  it("accepts a config with no executors", () => {
    expect(parseTransferExecutorConfig({ gasLimit: 1 })?.executors).toBeUndefined();
    expect(
      parseTransferExecutorConfig({ executors: { [TESTNET]: undefined }, gasLimit: 1 })?.executors,
    ).toEqual({ [TESTNET]: undefined });
  });

  it("fixes the gas settings and keeps reading the executor lists", () => {
    const config: HederaTransferExecutorConfig = {
      executors: { [TESTNET]: ["0.0.7000"] },
      gasLimit: 300_000,
      simulationGasCeiling: 200_000,
    };
    const parsed = parseTransferExecutorConfig(config)!;

    config.gasLimit = 20_000_000;
    config.simulationGasCeiling = 30_000_000;
    config.executors = { [TESTNET]: ["0.0.7001"] };

    expect(parsed.gasLimit).toBe(300_000);
    expect(parsed.simulationGasCeiling).toBe(200_000);
    expect(getAdmittedExecutors(parsed, TESTNET)).toEqual(["0.0.7001"]);
  });

  it.each([0, 1.5, 15_000_001, Number.NaN])("rejects gasLimit %s", gasLimit => {
    expect(() => parseTransferExecutorConfig({ gasLimit })).toThrow(/gasLimit/);
  });

  it.each([0, 1.5, 300_001])("rejects simulationGasCeiling %s with gasLimit 300000", ceiling => {
    expect(() =>
      parseTransferExecutorConfig({ gasLimit: 300_000, simulationGasCeiling: ceiling }),
    ).toThrow(/simulationGasCeiling/);
  });

  it("rejects an executors key that is not a supported network", () => {
    expect(() =>
      parseTransferExecutorConfig({
        executors: { "hedera:previewnet": ["0.0.7000"] },
        gasLimit: 300_000,
      }),
    ).toThrow(/executors.*hedera:previewnet/);
  });

  it("rejects an executors value that is not an array", () => {
    const config = {
      executors: { [TESTNET]: "0.0.7000" },
      gasLimit: 300_000,
    } as unknown as HederaTransferExecutorConfig;
    expect(() => parseTransferExecutorConfig(config)).toThrow(/executors.*hedera:testnet/);
  });

  it.each([["abc"], ["0.0.7000 "], [7000]])("rejects executor entry %j", entry => {
    const config = {
      executors: { [TESTNET]: [entry] },
      gasLimit: 300_000,
    } as unknown as HederaTransferExecutorConfig;
    expect(() => parseTransferExecutorConfig(config)).toThrow(/executors.*hedera:testnet/);
  });
});

describe("executor admission", () => {
  it("admits nothing on an omitted network", () => {
    const config: HederaTransferExecutorConfig = {
      executors: { [MAINNET]: ["0.0.7000"] },
      gasLimit: 300_000,
    };
    expect(getAdmittedExecutors(config, TESTNET)).toEqual([]);
    expect(isExecutorAdmitted(config, TESTNET, "0.0.7000")).toBe(false);
  });

  it("admits nothing without a config", () => {
    expect(getAdmittedExecutors(undefined, TESTNET)).toEqual([]);
    expect(isExecutorAdmitted(undefined, TESTNET, "0.0.7000")).toBe(false);
  });

  it("admits nothing from an empty list", () => {
    const config: HederaTransferExecutorConfig = { executors: { [TESTNET]: [] }, gasLimit: 1 };
    expect(isExecutorAdmitted(config, TESTNET, "0.0.7000")).toBe(false);
  });

  it("admits any executor through the wildcard", () => {
    const config: HederaTransferExecutorConfig = { executors: { [TESTNET]: ["*"] }, gasLimit: 1 };
    expect(isExecutorAdmitted(config, TESTNET, "0.0.7000")).toBe(true);
    expect(isExecutorAdmitted(config, TESTNET, "0.0.7001")).toBe(true);
  });

  it("admits only an exactly listed executor", () => {
    const config: HederaTransferExecutorConfig = {
      executors: { [TESTNET]: ["0.0.7000"] },
      gasLimit: 1,
    };
    expect(isExecutorAdmitted(config, TESTNET, "0.0.7000")).toBe(true);
    expect(isExecutorAdmitted(config, TESTNET, "0.0.7001")).toBe(false);
    expect(isExecutorAdmitted(config, TESTNET, "0.0.07000")).toBe(false);
  });

  it("follows changes to the configured list", () => {
    const testnetExecutors = ["0.0.7000"];
    const config: HederaTransferExecutorConfig = {
      executors: { [TESTNET]: testnetExecutors },
      gasLimit: 1,
    };
    expect(isExecutorAdmitted(config, TESTNET, "0.0.7000")).toBe(true);

    testnetExecutors.splice(0, 1, "0.0.7001");

    expect(isExecutorAdmitted(config, TESTNET, "0.0.7000")).toBe(false);
    expect(isExecutorAdmitted(config, TESTNET, "0.0.7001")).toBe(true);
    expect(getAdmittedExecutors(config, TESTNET)).toEqual(["0.0.7001"]);
  });
});

describe("isTransferExecutorEnabled", () => {
  const config: HederaTransferExecutorConfig = {
    executors: { [TESTNET]: ["0.0.7000"] },
    gasLimit: 300_000,
  };

  it("is enabled with a config, admitted executors, every capability and a fee payer", () => {
    expect(isTransferExecutorEnabled(createStubTransferExecutorSigner(), config, TESTNET)).toBe(
      true,
    );
  });

  it.each(TRANSFER_EXECUTOR_SIGNER_CAPABILITIES)("is disabled without %s", capability => {
    const signer = { ...createStubTransferExecutorSigner(), [capability]: undefined };
    expect(isTransferExecutorEnabled(signer, config, TESTNET)).toBe(false);
  });

  it("is disabled without admitted executors on the network", () => {
    expect(isTransferExecutorEnabled(createStubTransferExecutorSigner(), config, MAINNET)).toBe(
      false,
    );
  });

  it("is disabled without fee payer addresses", () => {
    expect(isTransferExecutorEnabled(createStubTransferExecutorSigner([]), config, TESTNET)).toBe(
      false,
    );
  });

  it("is disabled on an unsupported network", () => {
    const previewnetConfig = {
      executors: { "hedera:previewnet": ["0.0.7000"] },
      gasLimit: 300_000,
    };
    expect(
      isTransferExecutorEnabled(
        createStubTransferExecutorSigner(),
        previewnetConfig,
        "hedera:previewnet",
      ),
    ).toBe(false);
  });

  it("is disabled without a config", () => {
    expect(isTransferExecutorEnabled(createStubTransferExecutorSigner(), undefined, TESTNET)).toBe(
      false,
    );
  });
});
