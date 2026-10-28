import { afterEach, describe, expect, it, vi } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";
import { HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS } from "../../src/constants";
import { ExactHederaScheme } from "../../src/exact/facilitator/scheme";
import { ExactHederaScheme as ExactHederaServer } from "../../src/exact/server/scheme";
import type { HederaFacilitatorConfig } from "../../src/exact/facilitator/config";
import {
  ErrExecutorNotAdmitted,
  ErrInvalidPayload,
  ErrInvalidPayloadPayer,
  ErrInvalidPaymentRequirements,
  ErrSettlementPayeeCreditMismatch,
  ErrSettlementPending,
  ErrSettlementStatusNotSuccess,
  ErrSettlementUnexpectedTransfer,
  ErrSimulationReverted,
  ErrUnexpectedSettleError,
} from "../../src/exact/facilitator/errors";
import type {
  FacilitatorHederaSigner,
  HederaContractCallSimulationParams,
  HederaContractCallSimulationResult,
  HederaContractExecuteParams,
  HederaContractExecuteResult,
  HederaEvmAddressResolution,
} from "../../src/signer";
import type { HederaTransactionRecord } from "../../src/types";
import { addressTopic, recordEntry, transferEntry } from "../helpers/transferExecutor";

const TESTNET = "hedera:testnet";
const FEE_PAYER = "0.0.5001";
const PAYER = "0.0.9001";
const PAY_TO = "0.0.4001";
const EXECUTOR = "0.0.7000";
const FEE_COLLECTOR = "0.0.802";
const GAS_LIMIT = 400_000;
const AUTHORIZATION = "0xabcdef";

const AMOUNT = 100_000_000n;
const FEE = 19_682_562n;
const TX_ID = `${FEE_PAYER}@1755500000.000000000`;

const PAYER_EVM = "0x1111111111111111111111111111111111111111";
const PAY_TO_EVM = "0x2222222222222222222222222222222222222222";
const FEE_PAYER_ALIAS = "0x3333333333333333333333333333333333333333";
/**
 * Long-zero address of `FEE_PAYER` (5001 = 0x1389).
 */
const FEE_PAYER_LONG_ZERO = "0x0000000000000000000000000000000000001389";
/**
 * A non-HTS token contract, absent from every transfer list.
 */
const ERC20_CONTRACT = "0x00000000000000000000000000000000000abcde";
/**
 * keccak256("Transfer(address,address,uint256)").
 */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const EVM_ADDRESSES: Record<string, string> = {
  [PAYER]: PAYER_EVM,
  [PAY_TO]: PAY_TO_EVM,
  [FEE_PAYER]: FEE_PAYER_ALIAS,
};

/**
 * Builds `transferExecutor` requirements for an HBAR payment.
 *
 * @param overrides - Fields to replace
 * @returns Payment requirements
 */
function createRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: TESTNET,
    asset: "0.0.0",
    amount: AMOUNT.toString(),
    payTo: PAY_TO,
    maxTimeoutSeconds: 180,
    extra: { assetTransferMethod: "transferExecutor", executors: [EXECUTOR] },
    ...overrides,
  };
}

/**
 * Builds a payment payload whose `accepted` echoes the requirements.
 *
 * @param requirements - Accepted requirements
 * @param overrides - Scheme payload fields to replace
 * @returns Payment payload
 */
function createPaymentPayload(
  requirements: PaymentRequirements,
  overrides: Record<string, unknown> = {},
): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://example.com", description: "resource", mimeType: "application/json" },
    accepted: requirements,
    payload: { payer: PAYER, executor: EXECUTOR, authorization: AUTHORIZATION, ...overrides },
  };
}

/**
 * Builds a consensus record of an HBAR payment from `PAYER` to `PAY_TO`, carried by a
 * child, with the fee payer paying the fee in the parent.
 *
 * @param overrides - Fields to set
 * @returns Record
 */
function createRecord(overrides: Partial<HederaTransactionRecord> = {}): HederaTransactionRecord {
  return {
    transactionId: TX_ID,
    status: "SUCCESS",
    transactionFee: FEE.toString(),
    parent: recordEntry({
      chargedFee: FEE.toString(),
      hbarTransfers: [transferEntry(FEE_COLLECTOR, FEE), transferEntry(FEE_PAYER, -FEE)],
    }),
    children: [
      recordEntry({
        hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
      }),
    ],
    logs: [],
    ...overrides,
  };
}

/**
 * Builds a facilitator signer with every capability, set up for a payment that
 * verifies, broadcasts with a SUCCESS receipt and has a passing record.
 *
 * @param addresses - Facilitator accounts, the fee payer first
 * @returns Signer with spy capabilities
 */
function createSigner(addresses: string[] = [FEE_PAYER]) {
  return {
    getAddresses: () => addresses,
    signAndSubmitTransaction: vi.fn(async () => ({ transactionId: TX_ID })),
    verifyPayerSignature: vi.fn(async () => ({ ok: true })),
    preflightTransfer: vi.fn(async () => ({ ok: true })),
    resolveEvmAddress: vi.fn(
      async ({ account }: { account: string }): Promise<HederaEvmAddressResolution | undefined> =>
        EVM_ADDRESSES[account] === undefined
          ? undefined
          : { accountId: account, evmAddress: EVM_ADDRESSES[account] },
    ),
    getTokenCustomFees: vi.fn(async () => ({
      fixedFeeCount: 0,
      fractionalFeeCount: 0,
      royaltyFeeCount: 0,
    })),
    simulateContractCall: vi.fn(
      async (
        _: HederaContractCallSimulationParams,
      ): Promise<HederaContractCallSimulationResult> => ({ reverted: false }),
    ),
    submitContractExecute: vi.fn(
      async (_: HederaContractExecuteParams): Promise<HederaContractExecuteResult> => ({
        transactionId: TX_ID,
        receiptStatus: "SUCCESS",
      }),
    ),
    getTransactionRecord: vi.fn(
      async (_: {
        transactionId: string;
        network: string;
      }): Promise<HederaTransactionRecord | undefined> => createRecord(),
    ),
  } satisfies FacilitatorHederaSigner;
}

/**
 * Makes the signer resolve `PAY_TO_EVM`, an alias, to the account `PAY_TO`.
 *
 * @param signer - Signer from `createSigner`
 */
function resolvePayToAlias(signer: ReturnType<typeof createSigner>): void {
  signer.resolveEvmAddress.mockImplementation(async ({ account }) =>
    account === PAY_TO_EVM
      ? { accountId: PAY_TO, evmAddress: PAY_TO_EVM }
      : { accountId: account, evmAddress: EVM_ADDRESSES[account] },
  );
}

/**
 * Builds a facilitator config admitting `EXECUTOR` on testnet.
 *
 * @param overrides - Facilitator config fields to replace
 * @returns Facilitator config
 */
function createConfig(overrides: Partial<HederaFacilitatorConfig> = {}): HederaFacilitatorConfig {
  return {
    transferExecutor: { executors: { [TESTNET]: [EXECUTOR] }, gasLimit: GAS_LIMIT },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("transferExecutor settle: success", () => {
  it("returns the core v2 shape with the Hedera tx id and the debited account", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toEqual({ success: true, transaction: TX_ID, network: TESTNET, payer: PAYER });
    expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
  });
});

describe("transferExecutor settle: submission", () => {
  it("submits the simulated call with the same gas limit, calldata and fee payer", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(signer.simulateContractCall).toHaveBeenCalledTimes(1);
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
    const simulated = signer.simulateContractCall.mock.calls[0][0];
    const submitted = signer.submitContractExecute.mock.calls[0][0];
    expect(simulated.gas).toBe(GAS_LIMIT);
    expect(submitted.gas).toBe(GAS_LIMIT);
    expect(submitted.functionParameters).toBe(simulated.data);
    expect(submitted.contractId).toBe(EXECUTOR);
    expect(submitted.network).toBe(TESTNET);
    expect(EVM_ADDRESSES[submitted.feePayer]).toBe(simulated.from);
  });

  it("picks the fee payer at random among the facilitator's accounts, once per settle", async () => {
    const otherFeePayer = "0.0.5002";
    const otherFeePayerEvm = "0x4444444444444444444444444444444444444444";
    const signer = createSigner([FEE_PAYER, otherFeePayer]);
    const resolve = signer.resolveEvmAddress.getMockImplementation()!;
    signer.resolveEvmAddress.mockImplementation(async params =>
      params.account === otherFeePayer
        ? { accountId: otherFeePayer, evmAddress: otherFeePayerEvm }
        : resolve(params),
    );
    signer.getTransactionRecord.mockResolvedValue(
      createRecord({
        parent: recordEntry({
          chargedFee: FEE.toString(),
          hbarTransfers: [transferEntry(FEE_COLLECTOR, FEE), transferEntry(otherFeePayer, -FEE)],
        }),
      }),
    );
    // The first draw picks the second account; any later draw would pick the first.
    vi.spyOn(Math, "random").mockReturnValueOnce(0.75).mockReturnValue(0);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(signer.simulateContractCall.mock.calls[0][0].from).toBe(otherFeePayerEvm);
    expect(signer.submitContractExecute.mock.calls[0][0].feePayer).toBe(otherFeePayer);
    expect(result).toEqual({ success: true, transaction: TX_ID, network: TESTNET, payer: PAYER });
  });

  it("never picks a payTo the facilitator controls as the fee payer", async () => {
    const otherFeePayer = "0.0.5002";
    const otherFeePayerEvm = "0x4444444444444444444444444444444444444444";
    const signer = createSigner([FEE_PAYER, otherFeePayer]);
    const resolve = signer.resolveEvmAddress.getMockImplementation()!;
    signer.resolveEvmAddress.mockImplementation(async params =>
      params.account === otherFeePayer
        ? { accountId: otherFeePayer, evmAddress: otherFeePayerEvm }
        : resolve(params),
    );
    signer.getTransactionRecord.mockResolvedValue(
      createRecord({
        parent: recordEntry({
          chargedFee: FEE.toString(),
          hbarTransfers: [transferEntry(FEE_COLLECTOR, FEE), transferEntry(otherFeePayer, -FEE)],
        }),
        children: [
          recordEntry({
            hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(FEE_PAYER, AMOUNT)],
          }),
        ],
      }),
    );
    // A draw over every account would pick the first, which is payTo.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ payTo: FEE_PAYER });

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(signer.submitContractExecute.mock.calls[0][0].feePayer).toBe(otherFeePayer);
    expect(result).toEqual({ success: true, transaction: TX_ID, network: TESTNET, payer: PAYER });
  });

  it.each([0, 0.75])(
    "makes a payer the facilitator controls its own fee payer, whatever the draw (%d)",
    async draw => {
      const signer = createSigner([FEE_PAYER, PAYER]);
      signer.getTransactionRecord.mockResolvedValue(
        createRecord({
          parent: recordEntry({
            chargedFee: FEE.toString(),
            hbarTransfers: [transferEntry(FEE_COLLECTOR, FEE), transferEntry(PAYER, -FEE)],
          }),
        }),
      );
      vi.spyOn(Math, "random").mockReturnValue(draw);
      const scheme = new ExactHederaScheme(signer, createConfig());
      const requirements = createRequirements();

      const result = await scheme.settle(createPaymentPayload(requirements), requirements);

      expect(signer.simulateContractCall.mock.calls[0][0].from).toBe(PAYER_EVM);
      expect(signer.submitContractExecute.mock.calls[0][0].feePayer).toBe(PAYER);
      expect(result).toEqual({ success: true, transaction: TX_ID, network: TESTNET, payer: PAYER });
    },
  );

  it("recognizes the payer among the facilitator's accounts however its id is written", async () => {
    const payerWithLeadingZero = "0.0.09001";
    const signer = createSigner([FEE_PAYER, payerWithLeadingZero]);
    const resolve = signer.resolveEvmAddress.getMockImplementation()!;
    signer.resolveEvmAddress.mockImplementation(async params =>
      params.account === payerWithLeadingZero
        ? { accountId: payerWithLeadingZero, evmAddress: PAYER_EVM }
        : resolve(params),
    );
    signer.getTransactionRecord.mockResolvedValue(
      createRecord({
        parent: recordEntry({
          chargedFee: FEE.toString(),
          hbarTransfers: [transferEntry(FEE_COLLECTOR, FEE), transferEntry(PAYER, -FEE)],
        }),
      }),
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(signer.submitContractExecute.mock.calls[0][0].feePayer).toBe(payerWithLeadingZero);
    expect(result).toEqual({ success: true, transaction: TX_ID, network: TESTNET, payer: PAYER });
  });
});

describe("transferExecutor settle: admission re-check", () => {
  it("rejects with invalid_exact_hedera_executor_not_admitted and submits nothing when the executor is removed during simulation", async () => {
    const signer = createSigner();
    const config = createConfig();
    const admitted = config.transferExecutor!.executors![TESTNET]!;
    signer.simulateContractCall.mockImplementation(async () => {
      admitted.splice(admitted.indexOf(EXECUTOR), 1, "0.0.7999");
      return { reverted: false };
    });
    const scheme = new ExactHederaScheme(signer, config);
    const requirements = createRequirements();

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toMatchObject({
      success: false,
      errorReason: ErrExecutorNotAdmitted,
      transaction: "",
      payer: PAYER,
    });
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });

  it("rejects with invalid_exact_hedera_executor_not_admitted when the operator removes the executor between verify and settle", async () => {
    const signer = createSigner();
    const config = createConfig();
    const scheme = new ExactHederaScheme(signer, config);
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    expect(await scheme.verify(payload, requirements)).toEqual({ isValid: true, payer: PAYER });
    config.transferExecutor!.executors![TESTNET] = ["0.0.7999"];
    const result = await scheme.settle(payload, requirements);

    expect(result).toMatchObject({ success: false, errorReason: ErrExecutorNotAdmitted });
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });
});

describe("transferExecutor settle: before broadcast", () => {
  it("returns verification's rejection for a cryptoTransfer-shaped payload", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = { ...createPaymentPayload(requirements), payload: { transaction: "AAAA" } };

    const results = await Promise.all([
      scheme.settle(payload, requirements),
      scheme.settle(payload, requirements),
    ]);

    for (const result of results) {
      expect(result).toEqual({
        success: false,
        network: TESTNET,
        transaction: "",
        errorReason: ErrInvalidPayloadPayer,
        payer: "",
      });
    }
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-empty array", [{ payTo: "0.0.4002", amount: "100" }]],
    ["an object", { payTo: "0.0.4002", amount: "100" }],
    ["a string", "0.0.4002"],
    ["a number", 1],
  ])("rejects an extra.splits that is %s and submits nothing", async (_, splits) => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({
      extra: { assetTransferMethod: "transferExecutor", executors: [EXECUTOR], splits },
    });

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toEqual({
      success: false,
      network: TESTNET,
      transaction: "",
      errorReason: ErrInvalidPaymentRequirements,
      errorMessage: "transferExecutor does not implement extra.splits",
      payer: "",
    });
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });

  it("rejects an amount the mirror node can't report exactly and submits nothing", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ amount: (2n ** 53n).toString() });

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toMatchObject({
      success: false,
      transaction: "",
      errorReason: ErrInvalidPaymentRequirements,
    });
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });

  it("rejects a payTo that is the facilitator's only account and submits nothing", async () => {
    const signer = createSigner();
    // What the chain records if it submits: payTo also pays the fee, so it nets amount - fee.
    signer.getTransactionRecord.mockResolvedValue(
      createRecord({
        children: [
          recordEntry({
            hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(FEE_PAYER, AMOUNT)],
          }),
        ],
      }),
    );
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements({ payTo: FEE_PAYER });

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toEqual({
      success: false,
      network: TESTNET,
      transaction: "",
      errorReason: ErrInvalidPaymentRequirements,
      errorMessage: `payTo ${FEE_PAYER} is the facilitator's only account, so it would pay the fee and be credited amount - fee`,
      payer: PAYER,
    });
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });

  it("settles a payload at most once: its replay simulates as a revert", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    const first = await scheme.settle(payload, requirements);
    signer.simulateContractCall.mockResolvedValue({
      reverted: true,
      reason: "CONTRACT_REVERT_EXECUTED: authorization used",
    });
    const replay = await scheme.settle(payload, requirements);

    expect(first.success).toBe(true);
    expect(replay).toEqual({
      success: false,
      network: TESTNET,
      transaction: "",
      errorReason: ErrSimulationReverted,
      errorMessage: "CONTRACT_REVERT_EXECUTED: authorization used",
      payer: PAYER,
    });
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
  });

  it("returns unexpected_settle_error and submits nothing when a facilitator address can't be resolved", async () => {
    const otherFacilitator = "0.0.5002";
    const signer = createSigner([FEE_PAYER, otherFacilitator]);
    const resolve = signer.resolveEvmAddress.getMockImplementation()!;
    signer.resolveEvmAddress.mockImplementation(async params => {
      if (params.account === otherFacilitator) {
        throw new Error("mirror node unavailable");
      }
      return resolve(params);
    });
    // Verify draws the resolvable fee payer, so only settle's address lookup fails.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toMatchObject({
      success: false,
      transaction: "",
      errorReason: ErrUnexpectedSettleError,
      payer: PAYER,
    });
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
  });

  it("returns unexpected_settle_error with no tx id when the submission throws", async () => {
    const signer = createSigner();
    signer.submitContractExecute.mockRejectedValue(
      new Error("transaction precheck failed: INSUFFICIENT_PAYER_BALANCE"),
    );
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toMatchObject({
      success: false,
      network: TESTNET,
      transaction: "",
      errorReason: ErrUnexpectedSettleError,
      payer: PAYER,
    });
    expect(result.errorMessage).toContain("INSUFFICIENT_PAYER_BALANCE");
  });
});

describe("transferExecutor settle: after broadcast", () => {
  it.each([
    [
      "settlement_status_not_success when the receipt is not SUCCESS",
      (signer: ReturnType<typeof createSigner>) =>
        signer.submitContractExecute.mockResolvedValue({
          transactionId: TX_ID,
          receiptStatus: "CONTRACT_REVERT_EXECUTED",
        }),
      ErrSettlementStatusNotSuccess,
      "CONTRACT_REVERT_EXECUTED",
    ],
    [
      "settlement_pending when the receipt is unavailable",
      (signer: ReturnType<typeof createSigner>) =>
        signer.submitContractExecute.mockResolvedValue({ transactionId: TX_ID }),
      ErrSettlementPending,
      "receipt could not be obtained",
    ],
    [
      "settlement_pending when the record is unavailable",
      (signer: ReturnType<typeof createSigner>) =>
        signer.getTransactionRecord.mockResolvedValue(undefined),
      ErrSettlementPending,
      "record not available yet",
    ],
    [
      "settlement_pending when reading the record throws",
      (signer: ReturnType<typeof createSigner>) =>
        signer.getTransactionRecord.mockRejectedValue(new Error("mirror node timeout")),
      ErrSettlementPending,
      "mirror node timeout",
    ],
  ])("returns %s, with the tx id", async (_, arrange, errorReason, detail) => {
    const signer = createSigner();
    arrange(signer);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toMatchObject({
      success: false,
      network: TESTNET,
      transaction: TX_ID,
      errorReason,
      payer: PAYER,
    });
    expect(result.errorMessage).toContain(detail);
  });
});

describe("transferExecutor settle: record checks", () => {
  it.each([
    ["alias returned by resolution", FEE_PAYER_ALIAS],
    ["long-zero address", FEE_PAYER_LONG_ZERO],
  ])(
    "returns settlement_unexpected_transfer when a contract log moves funds out of a facilitator %s",
    async (_, from) => {
      const signer = createSigner();
      signer.getTransactionRecord.mockResolvedValue(
        createRecord({
          logs: [
            {
              address: ERC20_CONTRACT,
              topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(PAY_TO_EVM)],
              data: `0x${"0".repeat(63)}1`,
            },
          ],
        }),
      );
      const scheme = new ExactHederaScheme(signer, createConfig());
      const requirements = createRequirements();

      const result = await scheme.settle(createPaymentPayload(requirements), requirements);

      expect(result).toMatchObject({
        success: false,
        transaction: TX_ID,
        errorReason: ErrSettlementUnexpectedTransfer,
        payer: PAYER,
      });
    },
  );

  it("compares an alias payTo's credit as its resolved account id", async () => {
    const signer = createSigner();
    resolvePayToAlias(signer);
    const scheme = new ExactHederaScheme(signer, createConfig({ aliasPolicy: "allow" }));
    const requirements = createRequirements({ payTo: PAY_TO_EVM });

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toEqual({ success: true, transaction: TX_ID, network: TESTNET, payer: PAYER });
  });

  it("returns settlement_payee_credit_mismatch when the record credits an account other than the alias payTo's", async () => {
    const signer = createSigner();
    resolvePayToAlias(signer);
    signer.getTransactionRecord.mockResolvedValue(
      createRecord({
        children: [
          recordEntry({
            hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry("0.0.4002", AMOUNT)],
          }),
        ],
      }),
    );
    const scheme = new ExactHederaScheme(signer, createConfig({ aliasPolicy: "allow" }));
    const requirements = createRequirements({ payTo: PAY_TO_EVM });

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toMatchObject({
      success: false,
      transaction: TX_ID,
      errorReason: ErrSettlementPayeeCreditMismatch,
      payer: PAYER,
    });
  });

  it("returns settlement_payee_credit_mismatch for a SUCCESS receipt and a passing simulation whose record moves nothing", async () => {
    const signer = createSigner();
    signer.getTransactionRecord.mockResolvedValue(createRecord({ children: [] }));
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(result).toMatchObject({
      success: false,
      transaction: TX_ID,
      errorReason: ErrSettlementPayeeCreditMismatch,
      payer: PAYER,
    });
  });

  it("succeeds when the payer is the fee payer and its one HBAR debit is amount plus fee", async () => {
    const signer = createSigner();
    signer.getTransactionRecord.mockResolvedValue(
      createRecord({
        parent: recordEntry({
          chargedFee: FEE.toString(),
          hbarTransfers: [
            transferEntry(FEE_COLLECTOR, FEE),
            transferEntry(FEE_PAYER, -(AMOUNT + FEE)),
            transferEntry(PAY_TO, AMOUNT),
          ],
        }),
        children: [],
      }),
    );
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    const result = await scheme.settle(
      createPaymentPayload(requirements, { payer: FEE_PAYER }),
      requirements,
    );

    expect(result).toEqual({
      success: true,
      transaction: TX_ID,
      network: TESTNET,
      payer: FEE_PAYER,
    });
  });
});

describe("transferExecutor settle: in-flight guard", () => {
  it("submits one contract call for two concurrent identical settles", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    const results = await Promise.all([
      scheme.settle(payload, requirements),
      scheme.settle(structuredClone(payload), requirements),
    ]);

    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
    expect(results.map(result => result.success).sort()).toEqual([false, true]);
    expect(results.find(result => !result.success)).toEqual({
      success: false,
      network: TESTNET,
      transaction: "",
      errorReason: ErrInvalidPayload,
      errorMessage: "payload already in flight",
      payer: PAYER,
    });
  });

  it("rejects a standalone verify while a settle holds the key", async () => {
    const signer = createSigner();
    let finishSimulation: (result: HederaContractCallSimulationResult) => void = () => {};
    signer.simulateContractCall.mockImplementationOnce(
      () => new Promise(resolve => (finishSimulation = resolve)),
    );
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    const settling = scheme.settle(payload, requirements);
    const verified = await scheme.verify(payload, requirements);
    finishSimulation({ reverted: false });

    expect(verified).toEqual({
      isValid: false,
      invalidReason: ErrInvalidPayload,
      invalidMessage: "payload already in flight",
      payer: PAYER,
    });
    expect((await settling).success).toBe(true);
  });

  it("never takes the key in a standalone verify", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    const [first, second] = await Promise.all([
      scheme.verify(payload, requirements),
      scheme.verify(payload, requirements),
    ]);
    const settled = await scheme.settle(payload, requirements);

    expect(first).toEqual({ isValid: true, payer: PAYER });
    expect(second).toEqual({ isValid: true, payer: PAYER });
    expect(settled.success).toBe(true);
  });

  it("judges a duplicate of a pending settlement from the submitted transaction's record, with no simulation or submit", async () => {
    const signer = createSigner();
    signer.getTransactionRecord.mockResolvedValueOnce(undefined);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    const first = await scheme.settle(payload, requirements);
    const duplicate = await scheme.settle(structuredClone(payload), structuredClone(requirements));

    expect(first).toEqual({
      success: false,
      network: TESTNET,
      transaction: TX_ID,
      errorReason: ErrSettlementPending,
      errorMessage: "transaction record not available yet",
      payer: PAYER,
    });
    expect(duplicate).toEqual({
      success: true,
      transaction: TX_ID,
      network: TESTNET,
      payer: PAYER,
    });
    expect(signer.simulateContractCall).toHaveBeenCalledTimes(1);
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
    expect(signer.getTransactionRecord).toHaveBeenCalledTimes(2);
  });

  it("keeps a settlement pending, with its tx id, while the retry's record read fails", async () => {
    const signer = createSigner();
    signer.getTransactionRecord
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("mirror node timeout"));
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    await scheme.settle(payload, requirements);
    const retried = await scheme.settle(payload, requirements);
    const retriedAgain = await scheme.settle(payload, requirements);

    expect(retried).toMatchObject({
      success: false,
      transaction: TX_ID,
      errorReason: ErrSettlementPending,
      errorMessage: "transaction record could not be obtained: mirror node timeout",
    });
    expect(retriedAgain).toEqual({
      success: true,
      transaction: TX_ID,
      network: TESTNET,
      payer: PAYER,
    });
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
    expect(signer.getTransactionRecord).toHaveBeenCalledTimes(3);
  });

  it("rejects an identical settle while a retry is reading the pending record", async () => {
    const signer = createSigner();
    let finishRecord: (record: HederaTransactionRecord) => void = () => {};
    signer.getTransactionRecord
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise(resolve => (finishRecord = resolve)));
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    await scheme.settle(payload, requirements);
    const retrying = scheme.settle(payload, requirements);
    const concurrent = await scheme.settle(payload, requirements);
    finishRecord(createRecord());

    expect(concurrent).toEqual({
      success: false,
      network: TESTNET,
      transaction: "",
      errorReason: ErrInvalidPayload,
      errorMessage: "payload already in flight",
      payer: PAYER,
    });
    expect((await retrying).success).toBe(true);
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
    expect(signer.getTransactionRecord).toHaveBeenCalledTimes(2);
  });

  it("rejects a duplicate of a pending settlement that names other requirements, and keeps it pending", async () => {
    const signer = createSigner();
    signer.getTransactionRecord.mockResolvedValueOnce(undefined);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const otherRequirements = createRequirements({ payTo: "0.0.4002" });

    await scheme.settle(createPaymentPayload(requirements), requirements);
    const other = await scheme.settle(createPaymentPayload(otherRequirements), otherRequirements);
    const retried = await scheme.settle(createPaymentPayload(requirements), requirements);

    expect(other).toMatchObject({
      success: false,
      transaction: "",
      errorReason: ErrInvalidPayload,
      errorMessage: "payload already in flight",
    });
    expect(retried).toMatchObject({ success: true, transaction: TX_ID });
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
    expect(signer.getTransactionRecord).toHaveBeenCalledTimes(2);
  });

  it("rejects a standalone verify while a pending settlement holds the key", async () => {
    const signer = createSigner();
    signer.getTransactionRecord.mockResolvedValueOnce(undefined);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    await scheme.settle(payload, requirements);
    const verified = await scheme.verify(payload, requirements);

    expect(verified).toEqual({
      isValid: false,
      invalidReason: ErrInvalidPayload,
      invalidMessage: "payload already in flight",
      payer: PAYER,
    });
  });

  it("reports the pending settlement's payer to a duplicate naming it with leading zeros", async () => {
    const signer = createSigner();
    signer.getTransactionRecord.mockResolvedValueOnce(undefined);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();

    await scheme.settle(createPaymentPayload(requirements), requirements);
    const duplicate = await scheme.settle(
      createPaymentPayload(requirements, { payer: "0.0.09001" }),
      requirements,
    );

    expect(duplicate).toEqual({
      success: true,
      transaction: TX_ID,
      network: TESTNET,
      payer: PAYER,
    });
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
  });

  it("keeps the key after settlement_pending until the TTL passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const signer = createSigner();
    signer.getTransactionRecord.mockResolvedValue(undefined);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    expect((await scheme.settle(payload, requirements)).errorReason).toBe(ErrSettlementPending);
    const retried = await scheme.settle(payload, requirements);
    vi.advanceTimersByTime(HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS - 1);
    const beforeExpiry = await scheme.settle(payload, requirements);
    vi.advanceTimersByTime(1);
    signer.getTransactionRecord.mockResolvedValue(createRecord());
    const afterExpiry = await scheme.settle(payload, requirements);

    const stillPending = { success: false, errorReason: ErrSettlementPending, transaction: TX_ID };
    expect(retried).toMatchObject(stillPending);
    expect(beforeExpiry).toMatchObject(stillPending);
    expect(afterExpiry.success).toBe(true);
    expect(signer.simulateContractCall).toHaveBeenCalledTimes(2);
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(2);
  });

  it("restarts the TTL at submission, so a slow verification doesn't shorten it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const signer = createSigner();
    const verification = 60_000;
    signer.simulateContractCall.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(verification);
      return { reverted: false };
    });
    signer.getTransactionRecord.mockResolvedValueOnce(undefined);
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    expect((await scheme.settle(payload, requirements)).errorReason).toBe(ErrSettlementPending);
    // The TTL has passed since the key was taken, but not since submission.
    vi.advanceTimersByTime(HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS - verification);
    const duplicate = await scheme.settle(payload, requirements);

    expect(duplicate).toMatchObject({ success: true, transaction: TX_ID });
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
  });

  it("counts the TTL from submission, not from the pending result", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const signer = createSigner();
    signer.getTransactionRecord.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(1_000);
      return undefined;
    });
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    expect((await scheme.settle(payload, requirements)).errorReason).toBe(ErrSettlementPending);
    vi.advanceTimersByTime(HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS - 1_000);
    const afterExpiry = await scheme.settle(payload, requirements);

    expect(afterExpiry.success).toBe(true);
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(2);
  });

  it("keeps the key for a pending result that arrives after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const signer = createSigner();
    signer.getTransactionRecord.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS);
      return undefined;
    });
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    expect((await scheme.settle(payload, requirements)).errorReason).toBe(ErrSettlementPending);
    const duplicate = await scheme.settle(payload, requirements);

    expect(duplicate).toMatchObject({ success: true, transaction: TX_ID });
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
    expect(signer.getTransactionRecord).toHaveBeenCalledTimes(2);
  });

  it("does not free a later settle's key when an earlier one outlives the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const signer = createSigner();
    let finishSubmission: (result: HederaContractExecuteResult) => void = () => {};
    signer.submitContractExecute.mockImplementationOnce(
      () => new Promise(resolve => (finishSubmission = resolve)),
    );
    const scheme = new ExactHederaScheme(signer, createConfig());
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    const earlier = scheme.settle(payload, requirements);
    await vi.waitFor(() => expect(signer.submitContractExecute).toHaveBeenCalledOnce());
    vi.advanceTimersByTime(HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS);
    let finishSimulation: (result: HederaContractCallSimulationResult) => void = () => {};
    signer.simulateContractCall.mockImplementationOnce(
      () => new Promise(resolve => (finishSimulation = resolve)),
    );
    const later = scheme.settle(payload, requirements);
    finishSubmission({ transactionId: TX_ID, receiptStatus: "SUCCESS" });
    expect((await earlier).success).toBe(true);
    const verified = await scheme.verify(payload, requirements);
    finishSimulation({ reverted: false });
    await later;

    expect(verified).toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidPayload,
      invalidMessage: "payload already in flight",
    });
  });

  it.each([
    [
      "success",
      () => {
        /* default signer */
      },
    ],
    [
      "a failed receipt",
      (signer: ReturnType<typeof createSigner>) =>
        signer.submitContractExecute.mockResolvedValueOnce({
          transactionId: TX_ID,
          receiptStatus: "CONTRACT_REVERT_EXECUTED",
        }),
    ],
    [
      "a failed record check",
      (signer: ReturnType<typeof createSigner>) =>
        signer.getTransactionRecord.mockResolvedValueOnce(createRecord({ children: [] })),
    ],
    [
      "a submission that throws",
      (signer: ReturnType<typeof createSigner>) =>
        signer.submitContractExecute.mockRejectedValueOnce(new Error("precheck failed")),
    ],
    [
      "a failed verification",
      (signer: ReturnType<typeof createSigner>) =>
        signer.simulateContractCall.mockResolvedValueOnce({ reverted: true, reason: "nope" }),
    ],
    [
      "a failed admission re-check",
      (signer: ReturnType<typeof createSigner>, config: HederaFacilitatorConfig) =>
        signer.simulateContractCall.mockImplementationOnce(async () => {
          config.transferExecutor!.executors![TESTNET] = ["0.0.7999"];
          return { reverted: false };
        }),
    ],
  ])("frees the key after %s", async (_, arrange) => {
    const signer = createSigner();
    const config = createConfig();
    arrange(signer, config);
    const scheme = new ExactHederaScheme(signer, config);
    const requirements = createRequirements();
    const payload = createPaymentPayload(requirements);

    await scheme.settle(payload, requirements);
    config.transferExecutor!.executors![TESTNET] = [EXECUTOR];
    const verified = await scheme.verify(payload, requirements);

    expect(verified).toEqual({ isValid: true, payer: PAYER });
  });
});

/**
 * Settles through core's real resource server and facilitator, recording each
 * response the facilitator returns.
 *
 * @param signer - Signer from `createSigner`
 * @returns The final result and every facilitator settle response
 */
async function settleThroughCore(signer: ReturnType<typeof createSigner>) {
  const facilitator = new x402Facilitator().register(
    TESTNET,
    new ExactHederaScheme(signer, createConfig()),
  );
  const settleResponses: SettleResponse[] = [];
  const facilitatorClient: FacilitatorClient = {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: async (payload, requirements) => {
      const response = await facilitator.settle(payload, requirements);
      settleResponses.push(response);
      return response;
    },
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
  const server = new x402ResourceServer(facilitatorClient);
  server.register(TESTNET, new ExactHederaServer());
  await server.initialize();
  const requirements = createRequirements();

  const result = await server.settlePayment(createPaymentPayload(requirements), requirements);
  return { result, settleResponses };
}

describe("transferExecutor settle: core's pending retry", () => {
  it.each([
    [
      "the record was not available yet",
      (signer: ReturnType<typeof createSigner>) =>
        signer.getTransactionRecord.mockResolvedValueOnce(undefined),
      2,
    ],
    [
      "the receipt could not be obtained",
      (signer: ReturnType<typeof createSigner>) =>
        signer.submitContractExecute.mockResolvedValueOnce({ transactionId: TX_ID }),
      1,
    ],
  ])(
    "settles on x402ResourceServer's retry by re-reading the submitted transaction's record when %s",
    async (_, arrange, recordReads) => {
      const signer = createSigner();
      arrange(signer);

      const { result, settleResponses } = await settleThroughCore(signer);

      expect(settleResponses.map(response => response.errorReason)).toEqual([
        ErrSettlementPending,
        undefined,
      ]);
      expect(result).toEqual({ success: true, transaction: TX_ID, network: TESTNET, payer: PAYER });
      expect(signer.simulateContractCall).toHaveBeenCalledTimes(1);
      expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
      expect(signer.getTransactionRecord).toHaveBeenCalledTimes(recordReads);
      expect(signer.getTransactionRecord).toHaveBeenLastCalledWith({
        transactionId: TX_ID,
        network: TESTNET,
      });
    },
  );

  it("keeps settlement_pending and the tx id when the retry's record read finds nothing, with one submit", async () => {
    const signer = createSigner();
    signer.getTransactionRecord.mockResolvedValue(undefined);

    const { result, settleResponses } = await settleThroughCore(signer);

    expect(settleResponses).toHaveLength(2);
    expect(result).toEqual({
      success: false,
      network: TESTNET,
      transaction: TX_ID,
      errorReason: ErrSettlementPending,
      errorMessage: "transaction record not available yet",
      payer: PAYER,
    });
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
    expect(signer.getTransactionRecord).toHaveBeenCalledTimes(2);
  });

  it("returns the record's terminal failure, with the tx id, on the retry", async () => {
    const signer = createSigner();
    signer.getTransactionRecord
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(createRecord({ children: [] }));

    const { result } = await settleThroughCore(signer);

    expect(result).toMatchObject({
      success: false,
      transaction: TX_ID,
      errorReason: ErrSettlementPayeeCreditMismatch,
      payer: PAYER,
    });
    expect(signer.submitContractExecute).toHaveBeenCalledTimes(1);
  });
});
