import { describe, expect, it } from "vitest";
import {
  createClientHederaSigner,
  HBAR_ASSET_ID,
  HEDERA_MAINNET_CAIP2,
  HEDERA_TESTNET_CAIP2,
  ExactHederaPayloadV2,
} from "../../src";
import { ExactHederaScheme as ExactHederaClient } from "../../src/exact/client/scheme";
import { ExactHederaScheme as ExactHederaServer } from "../../src/exact/server/scheme";
import { ExactHederaScheme as ExactHederaFacilitator } from "../../src/exact/facilitator/scheme";
import {
  createHederaGetTokenCustomFees,
  createHederaGetTransactionRecord,
  createHederaResolveEvmAddress,
  createHederaSimulateContractCall,
  createHederaSubmitContractExecute,
  isCryptoTransferPayload,
  isTransferExecutorPayload,
  isValidHexBytes,
  type ExactHederaTransferExecutorPayload,
  type FacilitatorHederaSigner,
  type HederaMirrorNodeConfig,
  type HederaTransactionRecordConfig,
} from "../../src";
import * as root from "../../src";
import * as facilitatorEntry from "../../src/exact/facilitator";
import type {
  HederaAliasPolicy,
  HederaFacilitatorConfig,
  HederaTransferExecutorConfig,
} from "../../src/exact/facilitator";

describe("@x402/hedera", () => {
  it("exports expected constants", () => {
    expect(HEDERA_MAINNET_CAIP2).toBe("hedera:mainnet");
    expect(HEDERA_TESTNET_CAIP2).toBe("hedera:testnet");
    expect(HBAR_ASSET_ID).toBe("0.0.0");
  });

  it("exports exact payload type shape", () => {
    const payload: ExactHederaPayloadV2 = { transaction: "dGVzdA==" };
    expect(payload.transaction).toBe("dGVzdA==");
  });

  it("exports all scheme classes", () => {
    expect(ExactHederaClient).toBeDefined();
    expect(ExactHederaServer).toBeDefined();
    expect(ExactHederaFacilitator).toBeDefined();
  });

  it("exports signer helpers", () => {
    expect(createClientHederaSigner).toBeTypeOf("function");
  });
});

describe("@x402/hedera transferExecutor exports", () => {
  it("exports the default transferExecutor signer capability factories from the root", () => {
    const mirror: HederaMirrorNodeConfig = { mirrorNodeUrl: "https://mirror.example" };
    const record: HederaTransactionRecordConfig = { ...mirror, timeoutMs: 1, pollIntervalMs: 1 };

    expect(createHederaResolveEvmAddress(mirror)).toBeTypeOf("function");
    expect(createHederaGetTokenCustomFees(mirror)).toBeTypeOf("function");
    expect(createHederaSimulateContractCall(mirror)).toBeTypeOf("function");
    expect(createHederaGetTransactionRecord(record)).toBeTypeOf("function");
    expect(createHederaSubmitContractExecute).toBeTypeOf("function");
  });

  it("exports the payload shape guards from the root", () => {
    const transferExecutor: ExactHederaTransferExecutorPayload = {
      payer: "0.0.9001",
      executor: "0.0.7000",
      authorization: "0x01",
    };
    const cryptoTransfer = { transaction: "dGVzdA==" };

    expect(isTransferExecutorPayload(transferExecutor)).toBe(true);
    expect(isTransferExecutorPayload(cryptoTransfer)).toBe(false);
    expect(isCryptoTransferPayload(cryptoTransfer)).toBe(true);
    expect(isCryptoTransferPayload(transferExecutor)).toBe(false);
  });

  it("exports the authorization hex check from the root", () => {
    expect(isValidHexBytes("0x0f")).toBe(true);
    expect(isValidHexBytes("0xzz")).toBe(false);
  });

  it.each([
    "isJsonObject",
    "errorMessage",
    "isStringArray",
    "executorListAdmits",
    "parseTransferExecutorPayload",
    "hasSplits",
  ])("keeps the internal helper %s off the root", name => {
    expect(Object.keys(root)).not.toContain(name);
  });

  it("exports the scheme and every error code from the facilitator subpath", () => {
    expect(Object.keys(facilitatorEntry).sort()).toEqual([
      "ErrAddressResolutionFailed",
      "ErrCustomFeeAsset",
      "ErrExecutorNotAdmitted",
      "ErrInvalidAssetTransferMethod",
      "ErrInvalidNetwork",
      "ErrInvalidPayload",
      "ErrInvalidPayloadAuthorization",
      "ErrInvalidPayloadExecutor",
      "ErrInvalidPayloadPayer",
      "ErrInvalidPaymentRequirements",
      "ErrInvalidScheme",
      "ErrInvalidTransferExecutorPayload",
      "ErrSettlementCheckFailed",
      "ErrSettlementFeePayerDebitMismatch",
      "ErrSettlementPayeeCreditMismatch",
      "ErrSettlementPayerDebitMismatch",
      "ErrSettlementPending",
      "ErrSettlementStatusNotSuccess",
      "ErrSettlementUnexpectedDebit",
      "ErrSettlementUnexpectedTransfer",
      "ErrSimulationGasExceeded",
      "ErrSimulationReverted",
      "ErrUnexpectedSettleError",
      "ErrUnexpectedVerifyError",
      "ErrUnsupportedAssetTransferMethod",
      "ExactHederaScheme",
    ]);
  });

  it("exports the facilitator config types from the facilitator subpath", () => {
    const signer: FacilitatorHederaSigner = {
      getAddresses: () => ["0.0.5001"],
      signAndSubmitTransaction: async () => ({ transactionId: "0.0.5001@1700000000.000000000" }),
      verifyPayerSignature: async () => ({ ok: true }),
      preflightTransfer: async () => ({ ok: true }),
    };
    const aliasPolicy: HederaAliasPolicy = "reject";
    const transferExecutor: HederaTransferExecutorConfig = {
      executors: { "hedera:testnet": ["0.0.7000"] },
      gasLimit: 400_000,
      simulationGasCeiling: 300_000,
    };
    const config: HederaFacilitatorConfig = { aliasPolicy, transferExecutor };

    // The signer has no transferExecutor capabilities, so only feePayer is advertised.
    expect(
      new facilitatorEntry.ExactHederaScheme(signer, config).getExtra("hedera:testnet"),
    ).toEqual({ feePayer: "0.0.5001" });
  });
});
