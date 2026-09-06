import { describe, it, expect, vi, beforeAll } from "vitest";
import { generateKeyPairSigner, type TransactionSigner } from "@solana/kit";
import { createPaymentHeader } from "./createPaymentHeader";
import { PaymentRequirements } from "../types/verify";
import * as exactSvmClient from "../schemes/exact/svm/client";

vi.mock("../schemes/exact/svm/client", () => ({
  createPaymentHeader: vi.fn(),
}));

describe("createPaymentHeader", () => {
  let svmSigner: TransactionSigner;
  let paymentRequirements: PaymentRequirements;

  beforeAll(async () => {
    svmSigner = await generateKeyPairSigner();
    const payToAddress = (await generateKeyPairSigner()).address;
    const assetAddress = (await generateKeyPairSigner()).address;

    paymentRequirements = {
      scheme: "exact",
      network: "solana-devnet",
      payTo: payToAddress,
      asset: assetAddress,
      maxAmountRequired: "1000",
      resource: "http://example.com/resource",
      description: "Test description",
      mimeType: "text/plain",
      maxTimeoutSeconds: 60,
      extra: {
        feePayer: svmSigner.address,
      },
    };
  });

  describe("Custom RPC Configuration", () => {
    it("should propagate config to exact SVM client", async () => {
      // Arrange
      const customRpcUrl = "http://localhost:8899";
      const config = { svmConfig: { rpcUrl: customRpcUrl } };
      vi.mocked(exactSvmClient.createPaymentHeader).mockResolvedValue("mock_payment_header");

      // Act
      await createPaymentHeader(svmSigner, 1, paymentRequirements, config);

      // Assert
      expect(exactSvmClient.createPaymentHeader).toHaveBeenCalledWith(
        svmSigner,
        1,
        paymentRequirements,
        config,
      );
    });

    it("should call exact SVM client without config when not provided", async () => {
      // Arrange
      vi.mocked(exactSvmClient.createPaymentHeader).mockResolvedValue("mock_payment_header");

      // Act
      await createPaymentHeader(svmSigner, 1, paymentRequirements);

      // Assert
      expect(exactSvmClient.createPaymentHeader).toHaveBeenCalledWith(
        svmSigner,
        1,
        paymentRequirements,
        undefined,
      );
    });

    it("should call exact SVM client with empty config object", async () => {
      // Arrange
      const config = {};
      vi.mocked(exactSvmClient.createPaymentHeader).mockResolvedValue("mock_payment_header");

      // Act
      await createPaymentHeader(svmSigner, 1, paymentRequirements, config);

      // Assert
      expect(exactSvmClient.createPaymentHeader).toHaveBeenCalledWith(
        svmSigner,
        1,
        paymentRequirements,
        config,
      );
    });
  });
});
