import { describe, expect, it, vi } from "vitest";
import { Wallet } from "xahau";
import { ExactXahauScheme } from "../../src/exact/facilitator/scheme";
import { invoiceIdToInvoiceIdField } from "../../src";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { Payment } from "xahau";

const payerWallet = Wallet.fromSeed("sEdTM1uX8pu2do5XvTnutH6HsouMaM2");
const invoiceId = "INV-2026-Xahau-SETTLE";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "xahau:1",
  asset: "XAH",
  amount: "1000000",
  payTo: "rGsd42GGEq1tJBPQ3Aoj9iyePZbxiX5Nrv",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: false, invoiceId },
};

function payload(): PaymentPayload {
  const tx: Payment = {
    TransactionType: "Payment",
    Account: payerWallet.classicAddress,
    Destination: requirements.payTo,
    Amount: requirements.amount,
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: 1_000,
    InvoiceID: invoiceIdToInvoiceIdField(invoiceId),
  };

  return {
    x402Version: 2,
    accepted: requirements,
    payload: { signedTxBlob: payerWallet.sign(tx).tx_blob },
  };
}

describe("ExactXahauScheme settlement", () => {
  it("settles a validated tesSUCCESS transaction", async () => {
    const submitSignedTransaction = vi.fn().mockResolvedValue({
      hash: "A".repeat(64),
      validated: true,
      resultCode: "tesSUCCESS",
    });
    const facilitator = new ExactXahauScheme({
      getCurrentLedgerIndex: async () => 990,
      getAccountSequence: async () => 1,
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
      submitSignedTransaction,
      simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS" }),
    });

    const result = await facilitator.settle(payload(), requirements);

    expect(result).toMatchObject({
      success: true,
      transaction: "A".repeat(64),
      network: "xahau:1",
      payer: payerWallet.classicAddress,
    });
    expect(submitSignedTransaction).toHaveBeenCalledOnce();
  });

  it("fails settlement for a validated non-success result", async () => {
    const facilitator = new ExactXahauScheme({
      getCurrentLedgerIndex: async () => 990,
      getAccountSequence: async () => 1,
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
      simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS" }),
      submitSignedTransaction: vi.fn().mockResolvedValue({
        hash: "B".repeat(64),
        validated: true,
        resultCode: "tecNO_DST",
      }),
    });

    const result = await facilitator.settle(payload(), requirements);

    expect(result).toMatchObject({
      success: false,
      transaction: "B".repeat(64),
      network: "xahau:1",
      payer: payerWallet.classicAddress,
    });
    expect(result.errorReason).toContain("tecNO_DST");
  });
});
