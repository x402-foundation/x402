import { describe, expect, it, vi } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentRequirements } from "@x402/core/types";
import { ErrUnsupportedAssetTransferMethod } from "../../src/exact/facilitator/errors";
import { ExactHederaScheme } from "../../src/exact/facilitator/scheme";
import type { FacilitatorHederaSigner } from "../../src/signer";
import {
  createPaymentPayload,
  createStubTransferExecutorSigner,
} from "../helpers/transferExecutor";

const TESTNET = "hedera:testnet";
const MAINNET = "hedera:mainnet";

/**
 * Builds a `transferExecutor` config admitting one executor on testnet.
 *
 * @returns A fresh config
 */
function testnetConfig() {
  return { executors: { [TESTNET]: ["0.0.7000"] }, gasLimit: 400_000 };
}

/**
 * Builds a facilitator signer with only the cryptoTransfer capabilities.
 *
 * @param addresses - Fee payer account ids
 * @returns Signer without transferExecutor capabilities
 */
function createCryptoTransferSigner(addresses: string[] = ["0.0.5001"]): FacilitatorHederaSigner {
  return {
    getAddresses: () => addresses,
    signAndSubmitTransaction: vi.fn(),
    verifyPayerSignature: vi.fn(),
    preflightTransfer: vi.fn(),
  };
}

describe("ExactHederaScheme.getExtra", () => {
  it("advertises transferExecutor and its executors where it is enabled", () => {
    const scheme = new ExactHederaScheme(createStubTransferExecutorSigner(), {
      transferExecutor: testnetConfig(),
    });

    expect(scheme.getExtra(TESTNET)).toEqual({
      feePayer: "0.0.5001",
      assetTransferMethods: ["cryptoTransfer", "transferExecutor"],
      executors: ["0.0.7000"],
    });
    expect(scheme.getExtra(MAINNET)).toEqual({ feePayer: "0.0.5001" });
  });

  it("returns exactly { feePayer } for a cryptoTransfer-only signer", () => {
    const scheme = new ExactHederaScheme(createCryptoTransferSigner(), {
      transferExecutor: testnetConfig(),
    });

    expect(scheme.getExtra(TESTNET)).toEqual({ feePayer: "0.0.5001" });
  });

  it("returns exactly { feePayer } when transferExecutor is not configured", () => {
    const scheme = new ExactHederaScheme(createStubTransferExecutorSigner());

    expect(scheme.getExtra(TESTNET)).toEqual({ feePayer: "0.0.5001" });
  });

  it("does not advertise transferExecutor on a network with an empty executor list", () => {
    const scheme = new ExactHederaScheme(createStubTransferExecutorSigner(), {
      transferExecutor: { executors: { [TESTNET]: [] }, gasLimit: 400_000 },
    });

    expect(scheme.getExtra(TESTNET)).toEqual({ feePayer: "0.0.5001" });
  });

  it("does not advertise transferExecutor when the signer cannot read transaction records", () => {
    const signer: FacilitatorHederaSigner = createStubTransferExecutorSigner();
    delete signer.getTransactionRecord;
    const scheme = new ExactHederaScheme(signer, {
      transferExecutor: testnetConfig(),
    });

    expect(scheme.getExtra(TESTNET)).toEqual({ feePayer: "0.0.5001" });
  });

  it('advertises "*" only when the operator configured it', () => {
    const scheme = new ExactHederaScheme(createStubTransferExecutorSigner(), {
      transferExecutor: {
        executors: { [TESTNET]: ["*"], [MAINNET]: ["0.0.7000", "0.0.7001"] },
        gasLimit: 400_000,
      },
    });

    expect(scheme.getExtra(TESTNET)?.executors).toEqual(["*"]);
    expect(scheme.getExtra(MAINNET)?.executors).toEqual(["0.0.7000", "0.0.7001"]);
  });

  it("reflects executor list changes made after construction", () => {
    const config = { executors: { [TESTNET]: ["0.0.7000"] }, gasLimit: 400_000 };
    const scheme = new ExactHederaScheme(createStubTransferExecutorSigner(), {
      transferExecutor: config,
    });

    config.executors[TESTNET] = [];

    expect(scheme.getExtra(TESTNET)).toEqual({ feePayer: "0.0.5001" });
  });

  it("returns undefined when the signer has no addresses", () => {
    const scheme = new ExactHederaScheme(createStubTransferExecutorSigner([]), {
      transferExecutor: testnetConfig(),
    });

    expect(scheme.getExtra(TESTNET)).toBeUndefined();
  });
});

describe("x402Facilitator.getSupported with ExactHederaScheme", () => {
  it("advertises transferExecutor per registered network", () => {
    const facilitator = new x402Facilitator().register(
      [TESTNET, MAINNET],
      new ExactHederaScheme(createStubTransferExecutorSigner(), {
        transferExecutor: testnetConfig(),
      }),
    );

    const kinds = facilitator.getSupported().kinds;

    expect(kinds.find(kind => kind.network === TESTNET)?.extra).toEqual({
      feePayer: "0.0.5001",
      assetTransferMethods: ["cryptoTransfer", "transferExecutor"],
      executors: ["0.0.7000"],
    });
    expect(kinds.find(kind => kind.network === MAINNET)?.extra).toEqual({ feePayer: "0.0.5001" });
  });
});

describe("x402Facilitator registered under hedera:*", () => {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: TESTNET,
    asset: "0.0.0",
    amount: "1000",
    payTo: "0.0.7001",
    maxTimeoutSeconds: 180,
    extra: { assetTransferMethod: "transferExecutor", executors: ["0.0.7000"] },
  };
  const payload = createPaymentPayload(requirements, {
    payer: "0.0.9001",
    executor: "0.0.7000",
    authorization: "0xabcdef",
  });

  it("fails /supported loudly, every time, and rejects transferExecutor payments with invalid_exact_hedera_unsupported_asset_transfer_method", async () => {
    const signer = createStubTransferExecutorSigner();
    const facilitator = new x402Facilitator().register(
      "hedera:*",
      new ExactHederaScheme(signer, {
        transferExecutor: testnetConfig(),
      }),
    );

    const configurationError =
      'transferExecutor admits executors, but ExactHederaScheme is registered for "hedera:*"';
    expect(() => facilitator.getSupported()).toThrow(configurationError);
    expect(() => facilitator.getSupported()).toThrow(configurationError);
    const verified = await facilitator.verify(payload, requirements);
    const settled = await facilitator.settle(payload, requirements);

    expect(verified).toMatchObject({
      isValid: false,
      invalidReason: ErrUnsupportedAssetTransferMethod,
    });
    expect(settled).toMatchObject({
      success: false,
      errorReason: ErrUnsupportedAssetTransferMethod,
      transaction: "",
    });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });

  it("names the network and the fix in the configuration error", () => {
    const scheme = new ExactHederaScheme(createStubTransferExecutorSigner(), {
      transferExecutor: testnetConfig(),
    });

    expect(() => scheme.getExtra("hedera:previewnet")).toThrow(
      'transferExecutor admits executors, but ExactHederaScheme is registered for "hedera:previewnet". ' +
        "Register it for concrete networks (hedera:mainnet, hedera:testnet), or admit no executors.",
    );
  });

  it.each([
    ["transferExecutor is not configured", undefined],
    ["transferExecutor admits no executor", { executors: { [TESTNET]: [] }, gasLimit: 400_000 }],
  ])("advertises { feePayer } when %s", (_, transferExecutor) => {
    const facilitator = new x402Facilitator().register(
      "hedera:*",
      new ExactHederaScheme(createStubTransferExecutorSigner(), { transferExecutor }),
    );

    expect(facilitator.getSupported().kinds).toEqual([
      { x402Version: 2, scheme: "exact", network: "hedera:*", extra: { feePayer: "0.0.5001" } },
    ]);
  });
});
