import { describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { ContractExecuteTransaction, ContractFunctionParameters } from "@hiero-ledger/sdk";
import { ExactHederaScheme } from "../../src/exact/facilitator/scheme";
import type { HederaFacilitatorConfig } from "../../src/exact/facilitator/config";
import {
  ErrAddressResolutionFailed,
  ErrCustomFeeAsset,
  ErrExecutorNotAdmitted,
  ErrInvalidPayload,
  ErrInvalidPayloadAuthorization,
  ErrInvalidPayloadExecutor,
  ErrInvalidPayloadPayer,
  ErrInvalidTransferExecutorPayload,
  ErrSimulationGasExceeded,
  ErrSimulationReverted,
  ErrUnexpectedVerifyError,
  ErrUnsupportedAssetTransferMethod,
  ErrInvalidNetwork,
  ErrInvalidPaymentRequirements,
  ErrInvalidScheme,
} from "../../src/exact/facilitator/errors";
import { verifyTransferExecutor } from "../../src/exact/facilitator/transferExecutorVerify";
import type {
  FacilitatorHederaSigner,
  HederaTokenCustomFees,
  HederaContractCallSimulationParams,
  HederaContractCallSimulationResult,
  HederaEvmAddressResolution,
} from "../../src/signer";
import { createPaymentPayload } from "../helpers/transferExecutor";

const TESTNET = "hedera:testnet";
const FEE_PAYER = "0.0.5001";
const PAYER = "0.0.9001";
const PAY_TO = "0.0.7001";
const TOKEN = "0.0.6001";
const EXECUTOR = "0.0.7000";
const AMOUNT = "1000";
const AUTHORIZATION = "0xabcdef";
const GAS_LIMIT = 400_000;

const PAYER_EVM = "0x1111111111111111111111111111111111111111";
const PAY_TO_EVM = "0x2222222222222222222222222222222222222222";
const FEE_PAYER_ALIAS = "0x3333333333333333333333333333333333333333";

const EXECUTOR_LONG_ZERO = "0x0000000000000000000000000000000000001b58";

/**
 * `executeTransfer(PAYER_EVM, address(0), PAY_TO_EVM, 1000, 0xabcdef)`, one ABI word per line.
 */
const HBAR_CALLDATA = [
  "0xea8f19fd",
  "0000000000000000000000001111111111111111111111111111111111111111",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000002222222222222222222222222222222222222222",
  "00000000000000000000000000000000000000000000000000000000000003e8",
  "00000000000000000000000000000000000000000000000000000000000000a0",
  "0000000000000000000000000000000000000000000000000000000000000003",
  "abcdef0000000000000000000000000000000000000000000000000000000000",
].join("");

/**
 * `HBAR_CALLDATA` with the asset word set to `TOKEN`'s long-zero address (6001 = 0x1771).
 */
const TOKEN_CALLDATA = HBAR_CALLDATA.replace(
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000001771",
);

const EVM_ADDRESSES: Record<string, string> = {
  [PAYER]: PAYER_EVM,
  [PAY_TO]: PAY_TO_EVM,
  [FEE_PAYER]: FEE_PAYER_ALIAS,
};

/**
 * Builds `transferExecutor` requirements for an asset.
 *
 * @param overrides - Fields to replace
 * @returns Payment requirements
 */
function createRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: TESTNET,
    asset: "0.0.0",
    amount: AMOUNT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 180,
    extra: { assetTransferMethod: "transferExecutor", executors: [EXECUTOR] },
    ...overrides,
  };
}

/**
 * Builds a valid `transferExecutor` scheme payload.
 *
 * @param overrides - Fields to replace
 * @returns Scheme payload
 */
function createTransferExecutorPayload(overrides: Record<string, unknown> = {}) {
  return { payer: PAYER, executor: EXECUTOR, authorization: AUTHORIZATION, ...overrides };
}

/**
 * Builds a facilitator signer with every capability, set up for a payment
 * that passes verification.
 *
 * @returns Signer with spy capabilities
 */
function createSigner() {
  return {
    getAddresses: () => [FEE_PAYER],
    signAndSubmitTransaction: vi.fn(async () => ({ transactionId: `${FEE_PAYER}@1.0` })),
    resolveAccount: vi.fn(async () => ({ exists: true, isAlias: false })),
    verifyPayerSignature: vi.fn(async () => ({ ok: true })),
    preflightTransfer: vi.fn(async () => ({ ok: true })),
    resolveEvmAddress: vi.fn(
      async ({ account }: { account: string }): Promise<HederaEvmAddressResolution | undefined> =>
        EVM_ADDRESSES[account] === undefined
          ? undefined
          : { accountId: account, evmAddress: EVM_ADDRESSES[account] },
    ),
    getTokenCustomFees: vi.fn(
      async (): Promise<HederaTokenCustomFees | undefined> => ({
        fixedFeeCount: 0,
        fractionalFeeCount: 0,
        royaltyFeeCount: 0,
      }),
    ),
    simulateContractCall: vi.fn(
      async (
        _: HederaContractCallSimulationParams,
      ): Promise<HederaContractCallSimulationResult> => ({
        reverted: false,
      }),
    ),
    submitContractExecute: vi.fn(),
    getTransactionRecord: vi.fn(),
  } satisfies FacilitatorHederaSigner;
}

/**
 * Builds a facilitator config admitting `EXECUTOR` on testnet.
 *
 * @param overrides - `transferExecutor` fields to replace
 * @returns Facilitator config
 */
function createConfig(
  overrides: Partial<NonNullable<HederaFacilitatorConfig["transferExecutor"]>> = {},
): HederaFacilitatorConfig {
  return {
    transferExecutor: { executors: { [TESTNET]: [EXECUTOR] }, gasLimit: GAS_LIMIT, ...overrides },
  };
}

/**
 * Encodes `executeTransfer` with the SDK, independently of the facilitator.
 *
 * @param args - Call arguments
 * @param args.from - Payer EVM address
 * @param args.asset - Asset EVM address
 * @param args.to - Payee EVM address
 * @param args.amount - Amount
 * @param args.authorization - 0x-hex authorization
 * @returns 0x-hex calldata
 */
function encodeWithSdk(args: {
  from: string;
  asset: string;
  to: string;
  amount: number;
  authorization: string;
}): string {
  const parameters = new ContractFunctionParameters()
    .addAddress(args.from)
    .addAddress(args.asset)
    .addAddress(args.to)
    .addUint256(args.amount)
    .addBytes(Buffer.from(args.authorization.slice(2), "hex"));
  const call = new ContractExecuteTransaction().setFunction("executeTransfer", parameters);
  return `0x${Buffer.from(call.functionParameters ?? []).toString("hex")}`;
}

describe("transferExecutor verify: calldata vectors", () => {
  it("matches the SDK encoding for HBAR", () => {
    expect(
      encodeWithSdk({
        from: PAYER_EVM,
        asset: "0x0000000000000000000000000000000000000000",
        to: PAY_TO_EVM,
        amount: 1000,
        authorization: AUTHORIZATION,
      }),
    ).toBe(HBAR_CALLDATA);
  });

  it("matches the SDK encoding for an HTS token", () => {
    expect(
      encodeWithSdk({
        from: PAYER_EVM,
        asset: "0x0000000000000000000000000000000000001771",
        to: PAY_TO_EVM,
        amount: 1000,
        authorization: AUTHORIZATION,
      }),
    ).toBe(TOKEN_CALLDATA);
  });
});

describe("transferExecutor verify: valid payment", () => {
  it("simulates the facilitator-built call and accepts the payment", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({ isValid: true, payer: PAYER });
    expect(signer.simulateContractCall).toHaveBeenCalledTimes(1);
    expect(signer.simulateContractCall).toHaveBeenCalledWith({
      network: TESTNET,
      from: FEE_PAYER_ALIAS,
      to: EXECUTOR_LONG_ZERO,
      data: HBAR_CALLDATA,
      gas: GAS_LIMIT,
      estimate: false,
    });
    expect(signer.verifyPayerSignature).not.toHaveBeenCalled();
    expect(signer.preflightTransfer).not.toHaveBeenCalled();
    expect(signer.resolveAccount).not.toHaveBeenCalled();
    expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });

  it("encodes an HTS asset as its long-zero address", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ asset: TOKEN });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({ isValid: true, payer: PAYER });
    expect(signer.simulateContractCall).toHaveBeenCalledWith(
      expect.objectContaining({ data: TOKEN_CALLDATA }),
    );
  });

  it("ignores everything the client sends besides payer and authorization", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    await scheme.verify(
      createPaymentPayload(
        requirements,
        createTransferExecutorPayload({
          data: "0xdeadbeef",
          functionParameters: "0xdeadbeef",
          amount: "999999",
          to: "0x5555555555555555555555555555555555555555",
          gas: 15_000_000,
        }),
      ),
      requirements,
    );

    expect(signer.simulateContractCall).toHaveBeenCalledWith(
      expect.objectContaining({ data: HBAR_CALLDATA, gas: GAS_LIMIT }),
    );
  });
});

describe("transferExecutor verify: payload shape", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "0xabcdef"],
  ])(
    "rejects a payload that is %s with invalid_exact_hedera_payload_transfer_executor",
    async (_, schemePayload) => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer, createConfig());
      const requirements = createRequirements();

      const result = await scheme.verify(
        createPaymentPayload(requirements, schemePayload),
        requirements,
      );

      expect(result).toEqual({
        isValid: false,
        invalidReason: ErrInvalidTransferExecutorPayload,
        payer: "",
      });
      expect(signer.simulateContractCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["payer", "abc", ErrInvalidPayloadPayer],
    ["payer", 9001, ErrInvalidPayloadPayer],
    ["payer", undefined, ErrInvalidPayloadPayer],
    ["executor", "contract", ErrInvalidPayloadExecutor],
    ["executor", 7000, ErrInvalidPayloadExecutor],
    ["authorization", "0xzz", ErrInvalidPayloadAuthorization],
    ["authorization", "abc", ErrInvalidPayloadAuthorization],
    ["authorization", "0xabc", ErrInvalidPayloadAuthorization],
    ["authorization", 42, ErrInvalidPayloadAuthorization],
  ])("rejects %s %j with its own code", async (field, value, invalidReason) => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload({ [field]: value })),
      requirements,
    );

    expect(result).toEqual({ isValid: false, invalidReason, payer: "" });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });
});

describe("transferExecutor verify: requirement rules", () => {
  it.each([
    ["an invalid asset", { asset: "usdc" }, ErrInvalidPaymentRequirements],
    ["an alias payTo under the reject policy", { payTo: "0x1234" }, ErrInvalidPaymentRequirements],
    ["an unsupported network", { network: "hedera:previewnet" as const }, ErrInvalidNetwork],
    ["a non-integer amount", { amount: "1.5" }, ErrInvalidPaymentRequirements],
    ["a scheme other than exact", { scheme: "upto" }, ErrInvalidScheme],
  ])(
    "rejects %s with a standard code",
    async (_, overrides: Partial<PaymentRequirements>, invalidReason) => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer, createConfig());
      const requirements = createRequirements(overrides);

      const result = await scheme.verify(
        createPaymentPayload(requirements, createTransferExecutorPayload()),
        requirements,
      );

      expect(result).toEqual({ isValid: false, invalidReason, payer: "" });
      expect(signer.simulateContractCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Number.MAX_SAFE_INTEGER", (2n ** 53n).toString()],
    ["uint256", (2n ** 256n).toString()],
  ])(
    "rejects an amount above %s with invalid_payment_requirements, before any I/O",
    async (_, amount) => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer, createConfig());
      const requirements = createRequirements({ amount });

      const result = await scheme.verify(
        createPaymentPayload(requirements, createTransferExecutorPayload()),
        requirements,
      );

      expect(result).toEqual({
        isValid: false,
        invalidReason: ErrInvalidPaymentRequirements,
        invalidMessage: `amount ${amount} is above 9007199254740991, the largest the mirror node reports exactly`,
        payer: "",
      });
      expect(signer.resolveEvmAddress).not.toHaveBeenCalled();
      expect(signer.simulateContractCall).not.toHaveBeenCalled();
    },
  );

  it("accepts an amount of exactly Number.MAX_SAFE_INTEGER", async () => {
    const scheme = new ExactHederaScheme(createSigner(), createConfig());
    const requirements = createRequirements({ amount: "9007199254740991" });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({ isValid: true, payer: PAYER });
  });

  it.each([
    ["a non-empty array", [{ payTo: "0.0.7002", amount: "100" }]],
    ["an object", { payTo: "0.0.7002", amount: "100" }],
    ["a string", "0.0.7002"],
    ["a number", 1],
  ])(
    "rejects an extra.splits that is %s with invalid_payment_requirements, before any I/O",
    async (_, splits) => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer, createConfig());
      const requirements = createRequirements({
        extra: { assetTransferMethod: "transferExecutor", executors: [EXECUTOR], splits },
      });

      const result = await scheme.verify(
        createPaymentPayload(requirements, createTransferExecutorPayload()),
        requirements,
      );

      expect(result).toEqual({
        isValid: false,
        invalidReason: ErrInvalidPaymentRequirements,
        invalidMessage: "transferExecutor does not implement extra.splits",
        payer: "",
      });
      expect(signer.resolveEvmAddress).not.toHaveBeenCalled();
      expect(signer.simulateContractCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an empty array", []],
    ["null", null],
  ])("treats an extra.splits that is %s as a single-payee payment", async (_, splits) => {
    const scheme = new ExactHederaScheme(createSigner(), createConfig());
    const requirements = createRequirements({
      extra: { assetTransferMethod: "transferExecutor", executors: [EXECUTOR], splits },
    });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({ isValid: true, payer: PAYER });
  });

  it("checks requirements before the payload shape", async () => {
    const scheme = new ExactHederaScheme(createSigner(), createConfig());
    const requirements = createRequirements({ asset: "usdc" });

    const result = await scheme.verify(createPaymentPayload(requirements, null), requirements);

    expect(result.invalidReason).toBe(ErrInvalidPaymentRequirements);
  });

  it.each([
    ["amount", { amount: "1" }, ErrInvalidPayload],
    ["asset", { asset: TOKEN }, ErrInvalidPayload],
    ["payTo", { payTo: "0.0.1" }, ErrInvalidPayload],
    ["maxTimeoutSeconds", { maxTimeoutSeconds: 60 }, ErrInvalidPayload],
    ["scheme", { scheme: "upto" }, ErrInvalidScheme],
    ["network", { network: "hedera:mainnet" as const }, ErrInvalidNetwork],
  ])(
    "rejects an accepted %s that differs from the requirements",
    async (_, accepted: Partial<PaymentRequirements>, invalidReason) => {
      const scheme = new ExactHederaScheme(createSigner(), createConfig());
      const requirements = createRequirements();
      const payload = createPaymentPayload(
        { ...requirements, ...accepted },
        createTransferExecutorPayload(),
      );

      const result = await scheme.verify(payload, requirements);

      expect(result).toEqual({ isValid: false, invalidReason, payer: "" });
    },
  );
});

describe("transferExecutor verify: method support", () => {
  const disabledCases: Array<{
    name: string;
    signer: () => FacilitatorHederaSigner & ReturnType<typeof createSigner>;
    config: HederaFacilitatorConfig;
  }> = [
    { name: "no transferExecutor config", signer: createSigner, config: {} },
    {
      name: "an empty executor list for the network",
      signer: createSigner,
      config: createConfig({ executors: { [TESTNET]: [] } }),
    },
    {
      name: "no executor list for the network",
      signer: createSigner,
      config: createConfig({ executors: { "hedera:mainnet": [EXECUTOR] } }),
    },
    {
      name: "a missing signer capability",
      signer: () => {
        const signer: FacilitatorHederaSigner & ReturnType<typeof createSigner> = createSigner();
        delete (signer as FacilitatorHederaSigner).getTransactionRecord;
        return signer;
      },
      config: createConfig(),
    },
  ];

  it.each(disabledCases)(
    "rejects with invalid_exact_hedera_unsupported_asset_transfer_method given $name",
    async ({ signer: makeSigner, config }) => {
      const signer = makeSigner();
      const scheme = new ExactHederaScheme(signer, config);
      const requirements = createRequirements({ asset: TOKEN });

      const result = await scheme.verify(
        createPaymentPayload(requirements, createTransferExecutorPayload()),
        requirements,
      );

      expect(result).toEqual({
        isValid: false,
        invalidReason: ErrUnsupportedAssetTransferMethod,
        payer: PAYER,
      });
      expect(signer.simulateContractCall).not.toHaveBeenCalled();
    },
  );

  it.each(disabledCases)(
    "checks custom fees before method support when the signer can read them, given $name",
    async ({ signer: makeSigner, config }) => {
      const signer = makeSigner();
      signer.getTokenCustomFees.mockResolvedValue({
        fixedFeeCount: 1,
        fractionalFeeCount: 0,
        royaltyFeeCount: 0,
      });
      const scheme = new ExactHederaScheme(signer, config);
      const requirements = createRequirements({ asset: TOKEN });

      const result = await scheme.verify(
        createPaymentPayload(requirements, createTransferExecutorPayload()),
        requirements,
      );

      expect(result).toEqual({ isValid: false, invalidReason: ErrCustomFeeAsset, payer: PAYER });
      expect(signer.getTokenCustomFees).toHaveBeenCalledWith({ tokenId: TOKEN, network: TESTNET });
    },
  );

  it("checks method support first when the signer cannot read custom fees", async () => {
    const signer: FacilitatorHederaSigner = createSigner();
    delete signer.getTokenCustomFees;
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ asset: TOKEN });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({
      isValid: false,
      invalidReason: ErrUnsupportedAssetTransferMethod,
      payer: PAYER,
    });
  });
});

describe("transferExecutor verify: in-flight check", () => {
  it("rejects a payload the hook reports in flight with invalid_payload", async () => {
    const signer = createSigner();
    const isInFlight = vi.fn(() => true);
    const requirements = createRequirements();

    const verification = await verifyTransferExecutor(
      {
        signer,
        config: createConfig().transferExecutor,
        aliasPolicy: "reject",
        isInFlight,
      },
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(verification).toEqual({
      response: {
        isValid: false,
        invalidReason: ErrInvalidPayload,
        invalidMessage: "payload already in flight",
        payer: PAYER,
      },
    });
    expect(isInFlight).toHaveBeenCalledWith(TESTNET, {
      payer: PAYER,
      executor: EXECUTOR,
      authorization: AUTHORIZATION,
    });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("checks in flight before method support", async () => {
    const requirements = createRequirements();

    const verification = await verifyTransferExecutor(
      { signer: createSigner(), config: undefined, aliasPolicy: "reject", isInFlight: () => true },
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(verification.response.invalidReason).toBe(ErrInvalidPayload);
  });
});

describe("transferExecutor verify: custom fees", () => {
  it.each([
    ["a fixed fee", { fixedFeeCount: 1, fractionalFeeCount: 0, royaltyFeeCount: 0 }],
    ["a fractional fee", { fixedFeeCount: 0, fractionalFeeCount: 2, royaltyFeeCount: 0 }],
    ["a royalty fee", { fixedFeeCount: 0, fractionalFeeCount: 0, royaltyFeeCount: 1 }],
  ])("rejects an HTS asset with %s with invalid_exact_hedera_custom_fee_asset", async (_, fees) => {
    const signer = createSigner();
    signer.getTokenCustomFees.mockResolvedValue(fees);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ asset: TOKEN });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({ isValid: false, invalidReason: ErrCustomFeeAsset, payer: PAYER });
    expect(signer.getTokenCustomFees).toHaveBeenCalledWith({ tokenId: TOKEN, network: TESTNET });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("rejects an asset that is not a fungible token on the network with invalid_payment_requirements", async () => {
    const signer = createSigner();
    signer.getTokenCustomFees.mockResolvedValue(undefined);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ asset: TOKEN });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({
      isValid: false,
      invalidReason: ErrInvalidPaymentRequirements,
      invalidMessage: `asset ${TOKEN} is not a fungible token on ${TESTNET}`,
      payer: PAYER,
    });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("does not read a fee schedule for HBAR", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(signer.getTokenCustomFees).not.toHaveBeenCalled();
  });

  it("reports a fee read that throws as unexpected_verify_error", async () => {
    const signer = createSigner();
    signer.getTokenCustomFees.mockRejectedValue(new Error("mirror node unavailable"));
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ asset: TOKEN });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: ErrUnexpectedVerifyError,
      payer: PAYER,
    });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("checks custom fees before executor admission", async () => {
    const signer = createSigner();
    signer.getTokenCustomFees.mockResolvedValue({
      fixedFeeCount: 1,
      fractionalFeeCount: 0,
      royaltyFeeCount: 0,
    });
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ asset: TOKEN });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload({ executor: "0.0.1" })),
      requirements,
    );

    expect(result.invalidReason).toBe(ErrCustomFeeAsset);
  });
});

describe("transferExecutor verify: admission", () => {
  it("rejects an executor missing from the facilitator's list with invalid_exact_hedera_executor_not_admitted", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload({ executor: "0.0.7999" })),
      requirements,
    );

    expect(result).toEqual({
      isValid: false,
      invalidReason: ErrExecutorNotAdmitted,
      payer: PAYER,
    });
    expect(signer.resolveEvmAddress).not.toHaveBeenCalled();
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("rejects an executor the requirements name but the facilitator does not admit", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({
      extra: { assetTransferMethod: "transferExecutor", executors: ["0.0.7999", "*"] },
    });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload({ executor: "0.0.7999" })),
      requirements,
    );

    expect(result.invalidReason).toBe(ErrExecutorNotAdmitted);
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("admits any executor under an explicit wildcard", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig({ executors: { [TESTNET]: ["*"] } }));
    const requirements = createRequirements({
      extra: { assetTransferMethod: "transferExecutor", executors: ["*"] },
    });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload({ executor: "1.2.3" })),
      requirements,
    );

    expect(result).toEqual({ isValid: true, payer: PAYER });
    expect(signer.simulateContractCall).toHaveBeenCalledWith(
      expect.objectContaining({ to: "0x0000000100000000000000020000000000000003" }),
    );
  });

  it("accepts an admitted executor when the requirements omit executors", async () => {
    const scheme = new ExactHederaScheme(createSigner(), createConfig());
    const requirements = createRequirements({ extra: { assetTransferMethod: "transferExecutor" } });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({ isValid: true, payer: PAYER });
  });
});

describe("transferExecutor verify: address resolution", () => {
  it.each([
    ["payer", PAYER],
    ["payTo", PAY_TO],
  ])("rejects a %s that does not resolve with address_resolution_failed", async (_, account) => {
    const signer = createSigner();
    signer.resolveEvmAddress.mockImplementation(async ({ account: requested }) =>
      requested === account
        ? undefined
        : { accountId: requested, evmAddress: EVM_ADDRESSES[requested] },
    );
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: ErrAddressResolutionFailed,
      payer: PAYER,
    });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it.each([
    ["payer", PAYER],
    ["payTo", PAY_TO],
    ["fee payer", FEE_PAYER],
  ])("reports a %s lookup that throws as unexpected_verify_error", async (_, account) => {
    const signer = createSigner();
    signer.resolveEvmAddress.mockImplementation(async ({ account: requested }) => {
      if (requested === account) {
        throw new Error("mirror node timeout");
      }
      return { accountId: requested, evmAddress: EVM_ADDRESSES[requested] };
    });
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: ErrUnexpectedVerifyError,
      payer: PAYER,
    });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("reports a fee payer without an EVM address as unexpected_verify_error", async () => {
    const signer = createSigner();
    signer.resolveEvmAddress.mockImplementation(async ({ account }) =>
      account === FEE_PAYER
        ? undefined
        : { accountId: account, evmAddress: EVM_ADDRESSES[account] },
    );
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result.invalidReason).toBe(ErrUnexpectedVerifyError);
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("reports a malformed resolved address as unexpected_verify_error", async () => {
    const signer = createSigner();
    signer.resolveEvmAddress.mockImplementation(async ({ account }) => ({
      accountId: account,
      evmAddress: account === PAYER ? "0x1234" : EVM_ADDRESSES[account],
    }));
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result.invalidReason).toBe(ErrUnexpectedVerifyError);
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it("builds the call with alias addresses for an alias payer and payTo", async () => {
    const aliasPayTo = "0x4444444444444444444444444444444444444444";
    const signer = createSigner();
    signer.resolveEvmAddress.mockImplementation(async ({ account }) =>
      account === aliasPayTo
        ? { accountId: "0.0.7002", evmAddress: aliasPayTo }
        : { accountId: account, evmAddress: EVM_ADDRESSES[account] },
    );
    const scheme = new ExactHederaScheme(signer, { ...createConfig(), aliasPolicy: "allow" });
    const requirements = createRequirements({ payTo: aliasPayTo });

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({ isValid: true, payer: PAYER });
    const { data } = signer.simulateContractCall.mock.calls[0][0];
    expect(data.slice(10, 74)).toBe(`000000000000000000000000${PAYER_EVM.slice(2)}`);
    expect(data.slice(138, 202)).toBe(`000000000000000000000000${aliasPayTo.slice(2)}`);
  });

  it("simulates from the fee payer's alias, not its long-zero address", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    const { from } = signer.simulateContractCall.mock.calls[0][0];
    expect(from).toBe(FEE_PAYER_ALIAS);
  });
});

describe("transferExecutor verify: simulation", () => {
  it("simulates with the configured gas limit", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig({ gasLimit: 123_456 }));
    const requirements = createRequirements();

    await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(signer.simulateContractCall).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 123_456 }),
    );
  });

  it("rejects a reverted simulation with simulation_reverted and the revert reason", async () => {
    const signer = createSigner();
    signer.simulateContractCall.mockResolvedValue({
      reverted: true,
      reason: "authorization consumed",
    });
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({
      isValid: false,
      invalidReason: ErrSimulationReverted,
      invalidMessage: "authorization consumed",
      payer: PAYER,
    });
  });

  it("reports a simulation transport error as unexpected_verify_error, not simulation_reverted", async () => {
    const signer = createSigner();
    signer.simulateContractCall.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({
      isValid: false,
      invalidReason: ErrUnexpectedVerifyError,
      invalidMessage: "connect ETIMEDOUT",
      payer: PAYER,
    });
  });

  it("reports a malformed simulation result as unexpected_verify_error", async () => {
    const signer = createSigner();
    signer.simulateContractCall.mockResolvedValue(undefined as unknown as { reverted: false });
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toMatchObject({ isValid: false, invalidReason: ErrUnexpectedVerifyError });
  });
});

describe("transferExecutor verify: gas ceiling", () => {
  /**
   * Builds a signer whose estimating simulation reports `gasEstimate`.
   *
   * @param gasEstimate - Estimate the second simulation returns
   * @returns Signer with spy capabilities
   */
  function createEstimatingSigner(gasEstimate: number | undefined) {
    const signer = createSigner();
    signer.simulateContractCall.mockImplementation(async ({ estimate }) =>
      estimate ? { reverted: false, gasEstimate } : { reverted: false },
    );
    return signer;
  }

  it("runs one non-estimating simulation when no ceiling is set", async () => {
    const signer = createEstimatingSigner(10_000_000);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result.isValid).toBe(true);
    expect(signer.simulateContractCall).toHaveBeenCalledTimes(1);
    expect(signer.simulateContractCall).toHaveBeenCalledWith(
      expect.objectContaining({ estimate: false }),
    );
  });

  it("rejects an estimate above the ceiling with simulation_gas_exceeded", async () => {
    const signer = createEstimatingSigner(300_001);
    const scheme = new ExactHederaScheme(signer, createConfig({ simulationGasCeiling: 300_000 }));
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: ErrSimulationGasExceeded,
      payer: PAYER,
    });
    expect(signer.simulateContractCall).toHaveBeenLastCalledWith({
      network: TESTNET,
      from: FEE_PAYER_ALIAS,
      to: EXECUTOR_LONG_ZERO,
      data: HBAR_CALLDATA,
      gas: GAS_LIMIT,
      estimate: true,
    });
  });

  it.each([300_000, 21_000])("accepts an estimate of %i under a 300000 ceiling", async gas => {
    const signer = createEstimatingSigner(gas);
    const scheme = new ExactHederaScheme(signer, createConfig({ simulationGasCeiling: 300_000 }));
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({ isValid: true, payer: PAYER });
    expect(signer.simulateContractCall).toHaveBeenCalledTimes(2);
  });

  it("rejects a revert in the estimating simulation with simulation_reverted", async () => {
    const signer = createSigner();
    signer.simulateContractCall.mockImplementation(async ({ estimate }) =>
      estimate ? { reverted: true, reason: "out of gas" } : { reverted: false },
    );
    const scheme = new ExactHederaScheme(signer, createConfig({ simulationGasCeiling: 300_000 }));
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toEqual({
      isValid: false,
      invalidReason: ErrSimulationReverted,
      invalidMessage: "out of gas",
      payer: PAYER,
    });
  });

  it("reports a missing estimate as unexpected_verify_error", async () => {
    const signer = createEstimatingSigner(undefined);
    const scheme = new ExactHederaScheme(signer, createConfig({ simulationGasCeiling: 300_000 }));
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toMatchObject({ isValid: false, invalidReason: ErrUnexpectedVerifyError });
  });
});

describe("verifyTransferExecutor: prepared call for settlement", () => {
  it("returns the call exactly as simulated when the payment is valid", async () => {
    const aliasPayTo = "0x4444444444444444444444444444444444444444";
    const signer = createSigner();
    signer.resolveEvmAddress.mockImplementation(async ({ account }) =>
      account === aliasPayTo
        ? { accountId: "0.0.7002", evmAddress: aliasPayTo }
        : { accountId: account, evmAddress: EVM_ADDRESSES[account] },
    );
    const requirements = createRequirements({ payTo: aliasPayTo });

    const verification = await verifyTransferExecutor(
      { signer, config: createConfig().transferExecutor, aliasPolicy: "allow" },
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    const simulated = signer.simulateContractCall.mock.calls[0][0];
    expect(verification).toEqual({
      response: { isValid: true, payer: PAYER },
      call: {
        network: TESTNET,
        executor: EXECUTOR,
        feePayer: FEE_PAYER,
        payer: PAYER,
        payToAccountId: "0.0.7002",
        functionParameters: simulated.data,
        gas: simulated.gas,
      },
      signer,
    });
    expect(simulated.gas).toBe(GAS_LIMIT);
  });

  it("returns no call when the payment is invalid", async () => {
    const signer = createSigner();
    signer.simulateContractCall.mockResolvedValue({ reverted: true, reason: "denied" });
    const requirements = createRequirements();

    const verification = await verifyTransferExecutor(
      { signer, config: createConfig().transferExecutor, aliasPolicy: "reject" },
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(verification.response.isValid).toBe(false);
    expect(verification).not.toHaveProperty("call");
  });
});

describe("transferExecutor verify: configuration edits", () => {
  it("keeps the gas settings validated at construction", async () => {
    const signer = createSigner();
    signer.simulateContractCall.mockResolvedValue({ reverted: false, gasEstimate: 250_000 });
    const config = createConfig({ simulationGasCeiling: 200_000 });
    const scheme = new ExactHederaScheme(signer, config);
    config.transferExecutor!.gasLimit = 20_000_000;
    config.transferExecutor!.simulationGasCeiling = 300_000;
    const requirements = createRequirements();

    const result = await scheme.verify(
      createPaymentPayload(requirements, createTransferExecutorPayload()),
      requirements,
    );

    expect(result).toMatchObject({ isValid: false, invalidReason: ErrSimulationGasExceeded });
    for (const [params] of signer.simulateContractCall.mock.calls) {
      expect(params.gas).toBe(GAS_LIMIT);
    }
  });
});
