import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { AccountId, Client, TokenId, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { ExactHederaScheme } from "../../src/exact/facilitator/scheme";
import {
  ErrCustomFeeAsset,
  ErrInvalidAssetTransferMethod,
  ErrInvalidPayload,
  ErrInvalidPayloadPayer,
  ErrUnsupportedAssetTransferMethod,
} from "../../src/exact/facilitator/errors";
import type { FacilitatorHederaSigner } from "../../src/signer";
import {
  createPaymentPayload,
  createStubTransferExecutorSigner,
} from "../helpers/transferExecutor";

const TESTNET = "hedera:testnet";
const FEE_PAYER = "0.0.5001";
const PAYER = "0.0.9001";
const PAY_TO = "0.0.7001";
const ASSET = "0.0.6001";
const AMOUNT = "1000";
const EXECUTOR = "0.0.7000";

const cryptoTransferRequirements: PaymentRequirements = {
  scheme: "exact",
  network: TESTNET,
  asset: ASSET,
  amount: AMOUNT,
  payTo: PAY_TO,
  maxTimeoutSeconds: 180,
  extra: { feePayer: FEE_PAYER },
};

const transferExecutorRequirements: PaymentRequirements = {
  ...cryptoTransferRequirements,
  extra: {
    feePayer: FEE_PAYER,
    assetTransferMethod: "transferExecutor",
    executors: [EXECUTOR],
  },
};

const transferExecutorConfig = { executors: { [TESTNET]: [EXECUTOR] }, gasLimit: 400_000 };

const transferExecutorPayload = {
  payer: PAYER,
  executor: EXECUTOR,
  authorization: "0xabcdef",
};

/**
 * Builds a facilitator signer whose cryptoTransfer capabilities accept everything.
 *
 * @returns Signer with spy capabilities
 */
function createSigner() {
  return {
    getAddresses: () => [FEE_PAYER],
    signAndSubmitTransaction: vi.fn(async () => ({
      transactionId: `${FEE_PAYER}@1700000001.000000000`,
    })),
    resolveAccount: vi.fn(async () => ({ exists: true, isAlias: false })),
    verifyPayerSignature: vi.fn(async () => ({ ok: true })),
    preflightTransfer: vi.fn(async () => ({ ok: true })),
  };
}

/**
 * Builds a frozen token TransferTransaction from payer to payTo.
 *
 * @returns Base64 transaction bytes
 */
async function createTransferTransactionBase64(): Promise<string> {
  const tokenId = TokenId.fromString(ASSET);
  const tx = new TransferTransaction()
    .addTokenTransfer(tokenId, AccountId.fromString(PAYER), `-${AMOUNT}`)
    .addTokenTransfer(tokenId, AccountId.fromString(PAY_TO), AMOUNT)
    .setTransactionId(TransactionId.generate(AccountId.fromString(FEE_PAYER)));
  await tx.freezeWith(Client.forTestnet());
  return Buffer.from(tx.toBytes()).toString("base64");
}

/**
 * Builds a valid cryptoTransfer payment payload for the given requirements.
 *
 * @param requirements - Accepted requirements
 * @returns Payment payload
 */
async function createCryptoTransferPayload(
  requirements: PaymentRequirements,
): Promise<PaymentPayload> {
  return createPaymentPayload(requirements, {
    transaction: await createTransferTransactionBase64(),
  });
}

/**
 * Returns requirements with `extra.assetTransferMethod` set.
 *
 * @param method - Method value, possibly not a string
 * @returns Payment requirements
 */
function withMethod(method: unknown): PaymentRequirements {
  return {
    ...cryptoTransferRequirements,
    extra: { ...cryptoTransferRequirements.extra, assetTransferMethod: method },
  };
}

describe("ExactHederaScheme method selection", () => {
  describe("cryptoTransfer selection", () => {
    it("runs the cryptoTransfer flow when the method is absent", async () => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer);

      const result = await scheme.verify(
        await createCryptoTransferPayload(cryptoTransferRequirements),
        cryptoTransferRequirements,
      );

      expect(result).toEqual({ isValid: true, invalidReason: undefined, payer: PAYER });
      expect(signer.verifyPayerSignature).toHaveBeenCalled();
      expect(signer.preflightTransfer).toHaveBeenCalled();
    });

    it("runs the cryptoTransfer flow when the method is null", async () => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer);
      const requirements = withMethod(null);
      const payload = await createCryptoTransferPayload(requirements);

      const verified = await scheme.verify(payload, requirements);
      const settled = await scheme.settle(payload, requirements);

      expect(verified).toEqual({ isValid: true, invalidReason: undefined, payer: PAYER });
      expect(settled.success).toBe(true);
      expect(signer.signAndSubmitTransaction).toHaveBeenCalledOnce();
    });

    it("runs the cryptoTransfer flow when both sides name cryptoTransfer", async () => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer);
      const requirements = withMethod("cryptoTransfer");
      const payload = await createCryptoTransferPayload(requirements);

      const verified = await scheme.verify(payload, requirements);
      const settled = await scheme.settle(payload, requirements);

      expect(verified).toEqual({ isValid: true, invalidReason: undefined, payer: PAYER });
      expect(signer.verifyPayerSignature).toHaveBeenCalled();
      expect(signer.preflightTransfer).toHaveBeenCalled();
      expect(settled).toEqual({
        success: true,
        network: TESTNET,
        payer: PAYER,
        transaction: `${FEE_PAYER}@1700000001.000000000`,
      });
    });
  });

  describe("undefined assetTransferMethod values", () => {
    it.each(["foo", "default", 123])(
      "rejects %j with invalid_exact_hedera_asset_transfer_method at verify",
      async method => {
        const signer = createSigner();
        const scheme = new ExactHederaScheme(signer);
        const requirements = withMethod(method);

        const result = await scheme.verify(
          await createCryptoTransferPayload(requirements),
          requirements,
        );

        expect(result).toEqual({
          isValid: false,
          invalidReason: ErrInvalidAssetTransferMethod,
          payer: "",
        });
        expect(signer.verifyPayerSignature).not.toHaveBeenCalled();
        expect(signer.preflightTransfer).not.toHaveBeenCalled();
      },
    );

    it.each(["foo", "default", 123])(
      "rejects %j with invalid_exact_hedera_asset_transfer_method at settle",
      async method => {
        const signer = createSigner();
        const scheme = new ExactHederaScheme(signer);
        const requirements = withMethod(method);

        const result = await scheme.settle(
          await createCryptoTransferPayload(requirements),
          requirements,
        );

        expect(result).toEqual({
          success: false,
          network: TESTNET,
          transaction: "",
          errorReason: ErrInvalidAssetTransferMethod,
          payer: "",
        });
        expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
      },
    );
  });
});

describe("ExactHederaScheme accepted method parity", () => {
  it("rejects transferExecutor requirements whose accepted omits the method", async () => {
    const signer = createStubTransferExecutorSigner();
    const scheme = new ExactHederaScheme(signer, { transferExecutor: transferExecutorConfig });
    const payload = createPaymentPayload(cryptoTransferRequirements, transferExecutorPayload);

    const result = await scheme.verify(payload, transferExecutorRequirements);

    expect(result).toEqual({ isValid: false, invalidReason: ErrInvalidPayload, payer: "" });
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
  });

  it.each([
    ["transferExecutor", transferExecutorRequirements],
    ["cryptoTransfer", cryptoTransferRequirements],
  ])(
    "rejects an undefined method in accepted under %s requirements with invalid_exact_hedera_asset_transfer_method",
    async (_, requirements) => {
      const signer = createStubTransferExecutorSigner();
      const scheme = new ExactHederaScheme(signer, {
        transferExecutor: transferExecutorConfig,
      });
      const accepted = {
        ...requirements,
        extra: { ...requirements.extra, assetTransferMethod: "foo" },
      };

      const result = await scheme.verify(
        createPaymentPayload(accepted, transferExecutorPayload),
        requirements,
      );

      expect(result).toEqual({
        isValid: false,
        invalidReason: ErrInvalidAssetTransferMethod,
        payer: "",
      });
      expect(signer.simulateContractCall).not.toHaveBeenCalled();
      expect(signer.verifyPayerSignature).not.toHaveBeenCalled();
    },
  );

  it("rejects requirements that omit the method when accepted names transferExecutor", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload = await createCryptoTransferPayload(transferExecutorRequirements);

    const result = await scheme.verify(payload, cryptoTransferRequirements);

    expect(result).toEqual({
      isValid: false,
      invalidReason: "accepted_payment_requirements_mismatch",
      payer: "",
    });
    expect(signer.verifyPayerSignature).not.toHaveBeenCalled();
  });

  it("rejects a method mismatch at settle without submitting", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload = await createCryptoTransferPayload(transferExecutorRequirements);

    const result = await scheme.settle(payload, cryptoTransferRequirements);

    expect(result).toEqual({
      success: false,
      network: TESTNET,
      transaction: "",
      errorReason: "accepted_payment_requirements_mismatch",
      payer: "",
    });
    expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
  });

  it("treats an explicit cryptoTransfer in accepted as matching absent requirements", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload = await createCryptoTransferPayload(withMethod("cryptoTransfer"));

    const result = await scheme.verify(payload, cryptoTransferRequirements);

    expect(result).toEqual({ isValid: true, invalidReason: undefined, payer: PAYER });
    expect(signer.verifyPayerSignature).toHaveBeenCalled();
    expect(signer.preflightTransfer).toHaveBeenCalled();
  });
});

describe("ExactHederaScheme disabled transferExecutor", () => {
  const disabledCases: Array<{
    name: string;
    signer: () => FacilitatorHederaSigner;
    config: ConstructorParameters<typeof ExactHederaScheme>[1];
  }> = [
    {
      name: "no transferExecutor config",
      signer: createStubTransferExecutorSigner,
      config: {},
    },
    {
      name: "no executors for the network",
      signer: createStubTransferExecutorSigner,
      config: {
        transferExecutor: { executors: { "hedera:mainnet": [EXECUTOR] }, gasLimit: 400_000 },
      },
    },
    {
      name: "a missing signer capability",
      signer: () => {
        const signer: FacilitatorHederaSigner = createStubTransferExecutorSigner();
        delete signer.simulateContractCall;
        return signer;
      },
      config: { transferExecutor: transferExecutorConfig },
    },
  ];

  it.each(disabledCases)(
    "rejects at verify with invalid_exact_hedera_unsupported_asset_transfer_method given $name",
    async ({ signer, config }) => {
      const scheme = new ExactHederaScheme(signer(), config);
      const payload = createPaymentPayload(transferExecutorRequirements, transferExecutorPayload);

      const result = await scheme.verify(payload, transferExecutorRequirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ErrUnsupportedAssetTransferMethod);
    },
  );

  it.each(disabledCases)(
    "rejects at settle with invalid_exact_hedera_unsupported_asset_transfer_method given $name",
    async ({ signer, config }) => {
      const scheme = new ExactHederaScheme(signer(), config);
      const payload = createPaymentPayload(transferExecutorRequirements, transferExecutorPayload);

      const result = await scheme.settle(payload, transferExecutorRequirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ErrUnsupportedAssetTransferMethod);
      expect(result.transaction).toBe("");
    },
  );
});

describe("ExactHederaScheme never falls back between methods", () => {
  it("rejects a cryptoTransfer-shaped payload under transferExecutor requirements", async () => {
    const signer = createStubTransferExecutorSigner();
    const scheme = new ExactHederaScheme(signer, { transferExecutor: transferExecutorConfig });

    const payload = await createCryptoTransferPayload(transferExecutorRequirements);
    const verified = await scheme.verify(payload, transferExecutorRequirements);
    const settled = await scheme.settle(payload, transferExecutorRequirements);

    expect(verified).toMatchObject({ isValid: false, invalidReason: ErrInvalidPayloadPayer });
    expect(settled).toMatchObject({ success: false, errorReason: ErrInvalidPayloadPayer });
    expect(signer.verifyPayerSignature).not.toHaveBeenCalled();
    expect(signer.preflightTransfer).not.toHaveBeenCalled();
    expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
  });

  it("never runs the cryptoTransfer signature or preflight checks on a transferExecutor payload", async () => {
    const signer = createStubTransferExecutorSigner();
    const scheme = new ExactHederaScheme(signer, { transferExecutor: transferExecutorConfig });

    signer.getTokenCustomFees.mockResolvedValue({
      fixedFeeCount: 1,
      fractionalFeeCount: 0,
      royaltyFeeCount: 0,
    });

    const payload = createPaymentPayload(transferExecutorRequirements, transferExecutorPayload);
    const verified = await scheme.verify(payload, transferExecutorRequirements);
    const settled = await scheme.settle(payload, transferExecutorRequirements);

    expect(verified).toMatchObject({ isValid: false, invalidReason: ErrCustomFeeAsset });
    expect(settled).toMatchObject({ success: false, errorReason: ErrCustomFeeAsset });
    expect(signer.verifyPayerSignature).not.toHaveBeenCalled();
    expect(signer.preflightTransfer).not.toHaveBeenCalled();
    expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
  });

  it("rejects a transferExecutor-shaped payload under cryptoTransfer requirements", async () => {
    const signer = createStubTransferExecutorSigner();
    const scheme = new ExactHederaScheme(signer, { transferExecutor: transferExecutorConfig });
    const payload = createPaymentPayload(cryptoTransferRequirements, transferExecutorPayload);

    const verified = await scheme.verify(payload, cryptoTransferRequirements);
    const settled = await scheme.settle(payload, cryptoTransferRequirements);

    const notDecoded = "invalid_exact_hedera_payload_transaction_could_not_be_decoded";
    expect(verified).toMatchObject({ isValid: false, invalidReason: notDecoded });
    expect(settled).toMatchObject({ success: false, errorReason: notDecoded });
    expect(signer.getTokenCustomFees).not.toHaveBeenCalled();
    expect(signer.simulateContractCall).not.toHaveBeenCalled();
    expect(signer.submitContractExecute).not.toHaveBeenCalled();
    expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
  });

  it("does not submit an unknown method's valid cryptoTransfer payload", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const requirements = withMethod("foo");

    const result = await scheme.settle(
      await createCryptoTransferPayload(requirements),
      requirements,
    );

    expect(result.errorReason).toBe(ErrInvalidAssetTransferMethod);
    expect(signer.verifyPayerSignature).not.toHaveBeenCalled();
    expect(signer.preflightTransfer).not.toHaveBeenCalled();
    expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
  });
});

describe("ExactHederaScheme constructor", () => {
  it("throws on an invalid transferExecutor config", () => {
    expect(
      () =>
        new ExactHederaScheme(createStubTransferExecutorSigner(), {
          transferExecutor: { executors: { [TESTNET]: [EXECUTOR] }, gasLimit: 0 },
        }),
    ).toThrow(/gasLimit/);
  });
});
