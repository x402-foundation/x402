import { describe, expect, it, vi } from "vitest";
import { Wallet, decode, encode } from "xrpl";
import { ExactXrplScheme as ExactXrplClientScheme } from "../../src/exact/client/scheme";
import { ExactXrplScheme as ExactXrplFacilitatorScheme } from "../../src/exact/facilitator/scheme";
import { ExactXrplScheme as ExactXrplServerScheme } from "../../src/exact/server/scheme";
import { createXrplWalletSigner } from "../../src/signer";
import {
  DEFAULT_MAX_FEE_DROPS,
  SETTLEMENT_TTL_MS,
  SettlementCache,
  XRPL_TESTNET,
  compareDecimalStrings,
  createTickets,
  getXrplTicketSequences,
  invoiceIdToInvoiceIdField,
  resolveAssetTransferMethod,
  simulateSignedTransaction,
} from "../../src";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { Client, Payment, Transaction } from "xrpl";

const payerWallet = Wallet.fromSeed("sEdTM1uX8pu2do5XvTnutH6HsouMaM2");
const otherWallet = Wallet.fromSeed("sEd7t79mzn2dwy3vvpvRmaaLbLhvme6");
const payTo = "rGsd42GGEq1tJBPQ3Aoj9iyePZbxiX5Nrv";
const issuer = "rL4JcsJfvkYYAqNhjZ7Gvkh14eF7GXRh3q";
const invoiceId = "INV-2026-XRPL-001";

const baseXrpRequirements: PaymentRequirements = {
  scheme: "exact",
  network: XRPL_TESTNET,
  asset: "XRP",
  amount: "1000000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {
    areFeesSponsored: false,
    invoiceId,
  },
};

const baseIouRequirements: PaymentRequirements = {
  ...baseXrpRequirements,
  asset: "USD",
  amount: "10.5",
  extra: {
    areFeesSponsored: false,
    invoiceId,
    issuer,
    destinationTag: 12345,
  },
};

const ticketXrpRequirements: PaymentRequirements = {
  ...baseXrpRequirements,
  extra: {
    ...baseXrpRequirements.extra,
    assetTransferMethod: "ticketSequence",
  },
};

function signPayment(tx: Payment): string {
  return payerWallet.sign(tx).tx_blob;
}

function buildPayload(
  requirements: PaymentRequirements,
  overrides: Partial<Payment> = {},
): PaymentPayload {
  const isXrp = requirements.asset === "XRP";
  const invoice =
    typeof requirements.extra?.invoiceId === "string"
      ? { InvoiceID: invoiceIdToInvoiceIdField(requirements.extra.invoiceId) }
      : {};
  const basePayment: Payment = {
    TransactionType: "Payment",
    Account: payerWallet.classicAddress,
    Destination: requirements.payTo,
    Amount: isXrp
      ? requirements.amount
      : {
          currency: requirements.asset,
          issuer: String(requirements.extra?.issuer),
          value: requirements.amount,
        },
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: 1_000,
    ...invoice,
    ...(typeof requirements.extra?.destinationTag === "number"
      ? { DestinationTag: requirements.extra.destinationTag }
      : {}),
    ...(!isXrp
      ? {
          SendMax: {
            currency: requirements.asset,
            issuer: String(requirements.extra?.issuer),
            value: requirements.amount,
          },
        }
      : {}),
    ...overrides,
  };

  return {
    x402Version: 2,
    accepted: requirements,
    payload: {
      signedTxBlob: signPayment(basePayment),
    },
  };
}

function buildBlobFromTransaction(tx: Transaction): string {
  return payerWallet.sign(tx).tx_blob;
}

async function preparePaymentForTest(transaction: Payment): Promise<Payment> {
  return {
    ...transaction,
    Sequence: transaction.Sequence ?? 1,
    Fee: transaction.Fee ?? DEFAULT_MAX_FEE_DROPS,
    LastLedgerSequence: transaction.LastLedgerSequence ?? 1_000,
  };
}

function createFacilitator(
  overrides: ConstructorParameters<typeof ExactXrplFacilitatorScheme>[0] = {},
  settlementCache?: SettlementCache,
): ExactXrplFacilitatorScheme {
  return new ExactXrplFacilitatorScheme(
    {
      getCurrentLedgerIndex: async () => 990,
      getAccountSequence: async () => 1,
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
      isTicketAvailable: async () => true,
      maxFeeDrops: DEFAULT_MAX_FEE_DROPS,
      simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS" }),
      ...overrides,
    },
    settlementCache,
  );
}

describe("XRPL exact utilities", () => {
  it("encodes invoice binding values", () => {
    expect(invoiceIdToInvoiceIdField("INV-1")).toMatch(/^[A-F0-9]{64}$/);
  });

  it("compares issued-currency decimal values exactly", () => {
    expect(compareDecimalStrings("10.5", "10.50")).toBe(0);
    expect(compareDecimalStrings("10.5", "10.49")).toBe(1);
    expect(compareDecimalStrings("0.000001", "0.00001")).toBe(-1);
  });

  it("defaults the asset transfer method to sequence", () => {
    const payload = buildPayload(baseXrpRequirements);

    expect(resolveAssetTransferMethod(payload, baseXrpRequirements)).toEqual({
      method: "sequence",
    });
  });

  it("selects the method declared by the payload when requirements omit it", () => {
    const payload = buildPayload({
      ...baseXrpRequirements,
      extra: { ...baseXrpRequirements.extra, assetTransferMethod: "ticketSequence" },
    });

    expect(resolveAssetTransferMethod(payload, baseXrpRequirements)).toEqual({
      method: "ticketSequence",
    });
  });

  it("rejects a payload method that differs from the required method", () => {
    const payload = buildPayload({
      ...baseXrpRequirements,
      extra: { ...baseXrpRequirements.extra, assetTransferMethod: "ticketSequence" },
    });

    const resolution = resolveAssetTransferMethod(payload, {
      ...baseXrpRequirements,
      extra: { ...baseXrpRequirements.extra, assetTransferMethod: "sequence" },
    });

    expect(resolution).toEqual({ error: "invalid_exact_xrpl_asset_transfer_method_mismatch" });
  });

  it("rejects unknown asset transfer methods", () => {
    const requirements: PaymentRequirements = {
      ...baseXrpRequirements,
      extra: { ...baseXrpRequirements.extra, assetTransferMethod: "nonce" },
    };

    expect(resolveAssetTransferMethod(buildPayload(requirements), requirements)).toEqual({
      error: "invalid_exact_xrpl_asset_transfer_method",
    });
  });

  it("simulates signed transactions through the default XRPL client path", async () => {
    const simulate = vi.fn(async () => ({
      result: {
        engine_result: "tesSUCCESS",
        engine_result_message: "The transaction was applied.",
      },
    }));
    const fakeClient = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      simulate,
    } as unknown as Client;
    const clientFactory = vi.fn(() => fakeClient);
    const signedTxBlob = String(buildPayload(baseXrpRequirements).payload.signedTxBlob);

    const result = await simulateSignedTransaction(signedTxBlob, XRPL_TESTNET, {
      clientFactory,
    });

    expect(clientFactory).toHaveBeenCalledOnce();
    expect(fakeClient.connect).toHaveBeenCalledOnce();
    // The XRPL simulate API only accepts unsigned transactions
    expect(simulate).toHaveBeenCalledWith(expect.objectContaining({ TransactionType: "Payment" }));
    expect(simulate).toHaveBeenCalledWith(
      expect.not.objectContaining({ TxnSignature: expect.anything() }),
    );
    expect(fakeClient.disconnect).toHaveBeenCalledOnce();
    expect(result).toEqual({
      engineResult: "tesSUCCESS",
      engineResultMessage: "The transaction was applied.",
    });
  });

  it("lists available ticket sequences across paginated ledger objects", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          account_objects: [{ LedgerEntryType: "Ticket", TicketSequence: 9 }],
          marker: "page-2",
        },
      })
      .mockResolvedValueOnce({
        result: {
          account_objects: [{ LedgerEntryType: "Ticket", TicketSequence: 4 }],
        },
      });
    const fakeClient = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      request,
    } as unknown as Client;

    const ticketSequences = await getXrplTicketSequences(payerWallet.classicAddress, XRPL_TESTNET, {
      clientFactory: () => fakeClient,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "account_objects", marker: "page-2" }),
    );
    expect(ticketSequences).toEqual([4, 9]);
  });

  it("creates tickets and returns the created ticket sequences", async () => {
    const autofill = vi.fn(async (transaction: Transaction) => ({
      ...transaction,
      Fee: "12",
      Sequence: 3,
      LastLedgerSequence: 1_000,
    }));
    const submitAndWait = vi.fn(async () => ({
      result: {
        hash: "C".repeat(64),
        validated: true,
        meta: {
          TransactionIndex: 0,
          TransactionResult: "tesSUCCESS",
          AffectedNodes: [
            {
              CreatedNode: {
                LedgerEntryType: "Ticket",
                LedgerIndex: "0".repeat(64),
                NewFields: { TicketSequence: 8 },
              },
            },
            {
              CreatedNode: {
                LedgerEntryType: "Ticket",
                LedgerIndex: "1".repeat(64),
                NewFields: { TicketSequence: 4 },
              },
            },
          ],
        },
      },
    }));
    const fakeClient = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      autofill,
      submitAndWait,
    } as unknown as Client;

    const ticketSequences = await createTickets(
      createXrplWalletSigner(payerWallet),
      XRPL_TESTNET,
      2,
      {
        clientFactory: () => fakeClient,
      },
    );

    expect(autofill).toHaveBeenCalledWith(
      expect.objectContaining({ TransactionType: "TicketCreate", TicketCount: 2 }),
    );
    expect(submitAndWait).toHaveBeenCalledOnce();
    expect(ticketSequences).toEqual([4, 8]);
  });

  it("rejects ticket creation that fails on-network", async () => {
    const fakeClient = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      autofill: vi.fn(async (transaction: Transaction) => ({
        ...transaction,
        Fee: "12",
        Sequence: 3,
        LastLedgerSequence: 1_000,
      })),
      submitAndWait: vi.fn(async () => ({
        result: {
          hash: "C".repeat(64),
          validated: true,
          meta: {
            TransactionIndex: 0,
            TransactionResult: "tecINSUFFICIENT_RESERVE",
            AffectedNodes: [],
          },
        },
      })),
    } as unknown as Client;

    await expect(
      createTickets(createXrplWalletSigner(payerWallet), XRPL_TESTNET, 1, {
        clientFactory: () => fakeClient,
      }),
    ).rejects.toThrow("tecINSUFFICIENT_RESERVE");
  });

  it("rejects invalid ticket counts before contacting the network", async () => {
    const signer = createXrplWalletSigner(payerWallet);

    await expect(createTickets(signer, XRPL_TESTNET, 0)).rejects.toThrow("between 1 and 250");
    await expect(createTickets(signer, XRPL_TESTNET, 251)).rejects.toThrow("between 1 and 250");
  });
});

describe("ExactXrplScheme server", () => {
  it("passes through explicit AssetAmount pricing", async () => {
    const server = new ExactXrplServerScheme();

    await expect(
      server.parsePrice(
        {
          amount: "1000000",
          asset: "XRP",
          extra: { invoiceId: "custom-invoice" },
        },
        XRPL_TESTNET,
      ),
    ).resolves.toEqual({
      amount: "1000000",
      asset: "XRP",
      extra: { invoiceId: "custom-invoice" },
    });
  });

  it("passes through explicit IOU AssetAmount pricing", async () => {
    const server = new ExactXrplServerScheme();

    await expect(
      server.parsePrice(
        {
          amount: "10.5",
          asset: "USD",
          extra: { issuer },
        },
        XRPL_TESTNET,
      ),
    ).resolves.toEqual({
      amount: "10.5",
      asset: "USD",
      extra: { issuer },
    });
  });

  it("rejects IOU AssetAmount pricing without issuer", async () => {
    const server = new ExactXrplServerScheme();

    await expect(
      server.parsePrice(
        {
          amount: "10.5",
          asset: "USD",
          extra: {},
        },
        XRPL_TESTNET,
      ),
    ).rejects.toThrow("extra.issuer");
  });

  it("rejects IOU AssetAmount pricing with a non-decimal amount", async () => {
    const server = new ExactXrplServerScheme();

    await expect(
      server.parsePrice(
        {
          amount: "10.5.5",
          asset: "USD",
          extra: { issuer },
        },
        XRPL_TESTNET,
      ),
    ).rejects.toThrow("decimal value string");
  });

  it("rejects non-drop native AssetAmount pricing", async () => {
    const server = new ExactXrplServerScheme();

    await expect(
      server.parsePrice(
        {
          amount: "10.50",
          asset: "XRP",
        },
        XRPL_TESTNET,
      ),
    ).rejects.toThrow("integer drops");
  });

  it("rejects unsupported asset transfer methods in pricing extras", async () => {
    const server = new ExactXrplServerScheme();

    await expect(
      server.parsePrice(
        {
          amount: "1000000",
          asset: "XRP",
          extra: { assetTransferMethod: "nonce" },
        },
        XRPL_TESTNET,
      ),
    ).rejects.toThrow("assetTransferMethod");
  });

  it("rejects plain Money pricing without a custom parser", async () => {
    const server = new ExactXrplServerScheme();

    await expect(server.parsePrice("$0.01", XRPL_TESTNET)).rejects.toThrow(
      "require explicit AssetAmount",
    );
  });

  it("rejects malformed Money pricing before custom parser dispatch", async () => {
    const parser = vi.fn();
    const server = new ExactXrplServerScheme().registerMoneyParser(parser);

    await expect(server.parsePrice("$1abc", XRPL_TESTNET)).rejects.toThrow("Invalid money format");
    expect(parser).not.toHaveBeenCalled();
  });

  it("parses Money before custom parser dispatch", async () => {
    const parser = vi.fn(async (amount: number) => ({
      amount: String(amount),
      asset: "USD",
      extra: { issuer },
    }));
    const server = new ExactXrplServerScheme().registerMoneyParser(parser);

    await expect(server.parsePrice("$0.01", XRPL_TESTNET)).resolves.toEqual({
      amount: "0.01",
      asset: "USD",
      extra: { issuer },
    });
    expect(parser).toHaveBeenCalledWith(0.01, XRPL_TESTNET);
  });

  it("adds fee metadata while preserving caller extras", async () => {
    const server = new ExactXrplServerScheme();

    const result = await server.enhancePaymentRequirements(
      {
        ...baseIouRequirements,
        extra: { issuer, destinationTag: 12345, invoiceId },
      },
      {
        x402Version: 2,
        scheme: "exact",
        network: XRPL_TESTNET,
      },
      [],
    );

    expect(result.extra).toEqual({
      issuer,
      destinationTag: 12345,
      areFeesSponsored: false,
      invoiceId,
    });
  });

  it("stays deterministic when no invoice id is configured", async () => {
    const server = new ExactXrplServerScheme();
    const requirements = { ...baseXrpRequirements, extra: {} };
    const supportedKind = { x402Version: 2, scheme: "exact", network: XRPL_TESTNET } as const;

    const first = await server.enhancePaymentRequirements(requirements, supportedKind, []);
    const second = await server.enhancePaymentRequirements(requirements, supportedKind, []);

    expect(first.extra).toEqual({ areFeesSponsored: false });
    expect(second).toEqual(first);
  });

  it("rejects empty invoice ids when enhancing requirements", () => {
    const server = new ExactXrplServerScheme();

    expect(() =>
      server.enhancePaymentRequirements(
        { ...baseXrpRequirements, extra: { invoiceId: "" } },
        { x402Version: 2, scheme: "exact", network: XRPL_TESTNET },
        [],
      ),
    ).toThrow("invoiceId");
  });

  it("preserves a pinned asset transfer method when enhancing requirements", async () => {
    const server = new ExactXrplServerScheme();

    const result = await server.enhancePaymentRequirements(
      ticketXrpRequirements,
      {
        x402Version: 2,
        scheme: "exact",
        network: XRPL_TESTNET,
      },
      [],
    );

    expect(result.extra?.assetTransferMethod).toBe("ticketSequence");
    expect(result.extra?.areFeesSponsored).toBe(false);
  });

  it("rejects unsupported asset transfer methods when enhancing requirements", () => {
    const server = new ExactXrplServerScheme();

    expect(() =>
      server.enhancePaymentRequirements(
        {
          ...baseXrpRequirements,
          extra: { assetTransferMethod: "nonce" },
        },
        {
          x402Version: 2,
          scheme: "exact",
          network: XRPL_TESTNET,
        },
        [],
      ),
    ).toThrow("assetTransferMethod");
  });

  it("rejects malformed destination tags when enhancing requirements", () => {
    const server = new ExactXrplServerScheme();

    expect(() =>
      server.enhancePaymentRequirements(
        {
          ...baseIouRequirements,
          extra: { ...baseIouRequirements.extra, destinationTag: "12345" },
        } as unknown as PaymentRequirements,
        { x402Version: 2, scheme: "exact", network: XRPL_TESTNET },
        [],
      ),
    ).toThrow("destinationTag");
  });
});

describe("ExactXrplScheme client", () => {
  it("creates a signed XRP payment payload", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      preparePaymentTransaction: preparePaymentForTest,
    });

    const result = await client.createPaymentPayload(2, baseXrpRequirements);
    const signedTxBlob = result.payload.signedTxBlob;
    const decoded = decode(String(signedTxBlob)) as Payment;

    expect(result.x402Version).toBe(2);
    expect(typeof signedTxBlob).toBe("string");
    expect(decoded.TransactionType).toBe("Payment");
    expect(decoded.Account).toBe(payerWallet.classicAddress);
    expect(decoded.Destination).toBe(baseXrpRequirements.payTo);
    expect(decoded.Amount).toBe(baseXrpRequirements.amount);
    expect(decoded.InvoiceID).toBe(invoiceIdToInvoiceIdField(invoiceId));
    expect(decoded.Sequence).toBe(1);
    expect(decoded.Fee).toBe(DEFAULT_MAX_FEE_DROPS);
    expect(decoded.LastLedgerSequence).toBe(994);
  });

  it("creates a signed IOU payment payload with SendMax and destination tag", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      preparePaymentTransaction: preparePaymentForTest,
    });

    const result = await client.createPaymentPayload(2, baseIouRequirements);
    const decoded = decode(String(result.payload.signedTxBlob)) as Payment;

    expect(decoded.Amount).toEqual({
      currency: "USD",
      issuer,
      value: "10.5",
    });
    expect(decoded.SendMax).toEqual({
      currency: "USD",
      issuer,
      value: "10.5",
    });
    expect(decoded.DestinationTag).toBe(12345);
    expect(decoded.Sequence).toBe(1);
    expect(decoded.Fee).toBe(DEFAULT_MAX_FEE_DROPS);
    expect(decoded.LastLedgerSequence).toBe(994);
  });

  it("creates a ticketSequence payment when the requirements pin the method", async () => {
    const getAvailableTicketSequence = vi.fn(async () => 7);
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      getAvailableTicketSequence,
      preparePaymentTransaction: preparePaymentForTest,
    });

    const result = await client.createPaymentPayload(2, ticketXrpRequirements);
    const decoded = decode(String(result.payload.signedTxBlob)) as Payment;

    expect(getAvailableTicketSequence).toHaveBeenCalledWith(
      payerWallet.classicAddress,
      XRPL_TESTNET,
    );
    expect(decoded.Sequence).toBe(0);
    expect(decoded.TicketSequence).toBe(7);
  });

  it.each([
    ["the default policy", undefined, 1],
    ["a configured policy", 3, 3],
  ])("auto-creates tickets with %s", async (_label, ticketCreateCount, expectedCount) => {
    const autofill = vi.fn(async (transaction: Transaction) => ({
      ...transaction,
      Fee: "12",
      Sequence: 3,
      LastLedgerSequence: 1_000,
    }));
    const submitAndWait = vi.fn(async () => ({
      result: {
        hash: "C".repeat(64),
        validated: true,
        meta: {
          TransactionIndex: 0,
          TransactionResult: "tesSUCCESS",
          AffectedNodes: Array.from({ length: expectedCount }, (_, index) => ({
            CreatedNode: {
              LedgerEntryType: "Ticket",
              LedgerIndex: String(index).padStart(64, "0"),
              NewFields: { TicketSequence: 8 + index },
            },
          })),
        },
      },
    }));
    const fakeClient = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      autofill,
      submitAndWait,
    } as unknown as Client;
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      getAvailableTicketSequence: async () => undefined,
      ...(ticketCreateCount === undefined ? {} : { ticketCreateCount }),
      clientFactory: () => fakeClient,
      preparePaymentTransaction: preparePaymentForTest,
    });

    const result = await client.createPaymentPayload(2, ticketXrpRequirements);
    const decoded = decode(String(result.payload.signedTxBlob)) as Payment;

    expect(autofill).toHaveBeenCalledWith(
      expect.objectContaining({ TransactionType: "TicketCreate", TicketCount: expectedCount }),
    );
    expect(submitAndWait).toHaveBeenCalledOnce();
    expect(decoded.Sequence).toBe(0);
    expect(decoded.TicketSequence).toBe(8);
  });

  it("does not auto-create tickets when the policy is disabled", async () => {
    const clientFactory = vi.fn();
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      getAvailableTicketSequence: async () => undefined,
      ticketCreateCount: 0,
      clientFactory,
      preparePaymentTransaction: preparePaymentForTest,
    });

    await expect(client.createPaymentPayload(2, ticketXrpRequirements)).rejects.toThrow(
      "automatic ticket creation is disabled",
    );
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, 251])("rejects an invalid ticket creation policy of %s", async count => {
    const clientFactory = vi.fn();
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      getAvailableTicketSequence: async () => undefined,
      ticketCreateCount: count,
      clientFactory,
      preparePaymentTransaction: preparePaymentForTest,
    });

    await expect(client.createPaymentPayload(2, ticketXrpRequirements)).rejects.toThrow(
      "between 1 and 250",
    );
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("rejects requirements without areFeesSponsored=false", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      preparePaymentTransaction: preparePaymentForTest,
    });

    await expect(
      client.createPaymentPayload(2, {
        ...baseXrpRequirements,
        extra: { invoiceId },
      }),
    ).rejects.toThrow("areFeesSponsored");
  });

  it("rejects unsupported asset transfer methods", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      preparePaymentTransaction: preparePaymentForTest,
    });

    await expect(
      client.createPaymentPayload(2, {
        ...baseXrpRequirements,
        extra: { ...baseXrpRequirements.extra, assetTransferMethod: "nonce" },
      }),
    ).rejects.toThrow("assetTransferMethod");
  });

  it("autofills ledger-derived fields before signing by default", async () => {
    const autofill = vi.fn(async (transaction: Payment) => ({
      ...transaction,
      Sequence: 7,
      Fee: "12",
    }));
    const fakeClient = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getLedgerIndex: vi.fn(async () => 980),
      autofill,
    } as unknown as Client;
    const clientFactory = vi.fn(() => fakeClient);
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      clientFactory,
    });

    const result = await client.createPaymentPayload(2, baseXrpRequirements);
    const decoded = decode(String(result.payload.signedTxBlob)) as Payment;

    expect(clientFactory).toHaveBeenCalledOnce();
    expect(fakeClient.connect).toHaveBeenCalledOnce();
    expect(fakeClient.getLedgerIndex).toHaveBeenCalledOnce();
    expect(autofill).toHaveBeenCalledWith(
      expect.objectContaining({
        LastLedgerSequence: 994,
      }),
    );
    expect(fakeClient.disconnect).toHaveBeenCalledOnce();
    expect(decoded.Sequence).toBe(7);
    expect(decoded.Fee).toBe("12");
    expect(decoded.LastLedgerSequence).toBe(994);
  });

  it("rejects custom preparers that do not populate ledger-derived fields", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      preparePaymentTransaction: async transaction => transaction,
    });

    await expect(client.createPaymentPayload(2, baseXrpRequirements)).rejects.toThrow(
      "must set the account Sequence",
    );
  });

  it("rejects malformed destination tag requirements", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      preparePaymentTransaction: preparePaymentForTest,
    });

    await expect(
      client.createPaymentPayload(2, {
        ...baseIouRequirements,
        extra: { ...baseIouRequirements.extra, destinationTag: 1.5 },
      }),
    ).rejects.toThrow("destinationTag");
  });

  it("adds the custom NetworkID before preparing and signing", async () => {
    const preparePaymentTransaction = vi.fn(preparePaymentForTest);
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      preparePaymentTransaction,
    });

    const result = await client.createPaymentPayload(2, {
      ...baseXrpRequirements,
      network: "xrpl:21337",
    });
    const decoded = decode(String(result.payload.signedTxBlob)) as Payment;

    expect(preparePaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ NetworkID: 21337 }),
      expect.objectContaining({ network: "xrpl:21337" }),
    );
    expect(decoded.NetworkID).toBe(21337);
  });

  it("rejects custom preparers that remove the custom NetworkID", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      preparePaymentTransaction: async transaction => ({
        ...(await preparePaymentForTest(transaction)),
        NetworkID: undefined,
      }),
    });

    await expect(
      client.createPaymentPayload(2, { ...baseXrpRequirements, network: "xrpl:21337" }),
    ).rejects.toThrow("NetworkID");
  });

  it("rejects custom preparers that replace the custom NetworkID", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      preparePaymentTransaction: async transaction => ({
        ...(await preparePaymentForTest(transaction)),
        NetworkID: 21338,
      }),
    });

    await expect(
      client.createPaymentPayload(2, { ...baseXrpRequirements, network: "xrpl:21337" }),
    ).rejects.toThrow("NetworkID");
  });

  it("rejects prepared standard-network payments that set a NetworkID", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      preparePaymentTransaction: async transaction => ({
        ...(await preparePaymentForTest(transaction)),
        NetworkID: 1,
      }),
    });

    await expect(client.createPaymentPayload(2, baseXrpRequirements)).rejects.toThrow("NetworkID");
  });
});

describe("ExactXrplScheme facilitator verify", () => {
  const facilitator = createFacilitator();

  it("accepts a valid XRP payment", async () => {
    const result = await facilitator.verify(buildPayload(baseXrpRequirements), baseXrpRequirements);

    expect(result).toMatchObject({
      isValid: true,
      payer: payerWallet.classicAddress,
    });
  });

  it("accepts a valid IOU payment", async () => {
    const result = await facilitator.verify(buildPayload(baseIouRequirements), baseIouRequirements);

    expect(result).toMatchObject({
      isValid: true,
      payer: payerWallet.classicAddress,
    });
  });

  it("advertises unsponsored fees in supported metadata", () => {
    expect(facilitator.getExtra(XRPL_TESTNET)).toEqual({ areFeesSponsored: false });
  });

  it("returns a stable reason and separate message for malformed payloads", async () => {
    const payload = buildPayload(baseXrpRequirements);

    const result = await facilitator.verify(
      {
        ...payload,
        payload: { signedTxBlob: "not-hex" },
      },
      baseXrpRequirements,
    );

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_xrpl_facilitator_error",
      invalidMessage: expect.any(String),
      payer: "",
    });
    expect(result.invalidMessage?.length).toBeGreaterThan(0);
  });

  it.each([
    ["wrong network", { accepted: { ...baseXrpRequirements, network: "xrpl:0" } }, "network"],
    ["wrong destination", {}, "destination"],
    ["amount mismatch", {}, "amount"],
    ["missing invoice binding", {}, "invoice"],
    ["memos not allowed", {}, "memos"],
    ["expired LastLedgerSequence", {}, "expired"],
    ["fee over cap", {}, "fee"],
    ["XRP SendMax", {}, "sendmax"],
    ["Paths", {}, "paths"],
    ["DeliverMin", {}, "delivermin"],
    ["XRP partial payment", {}, "partial_payment"],
    ["custom network missing NetworkID", {}, "network"],
    ["custom network wrong NetworkID", {}, "network"],
  ])("rejects %s", async (caseName, payloadPatch, expectedReason) => {
    let requirements = baseXrpRequirements;
    let payload = buildPayload(requirements);

    if (caseName === "wrong destination") {
      payload = buildPayload(requirements, { Destination: issuer });
    } else if (caseName === "amount mismatch") {
      payload = buildPayload(requirements, { Amount: "999999" });
    } else if (caseName === "missing invoice binding") {
      payload = buildPayload(requirements, { InvoiceID: undefined });
    } else if (caseName === "memos not allowed") {
      payload = buildPayload(requirements, {
        Memos: [{ Memo: { MemoData: "494E562D31" } }],
      });
    } else if (caseName === "expired LastLedgerSequence") {
      payload = buildPayload(requirements, { LastLedgerSequence: 989 });
    } else if (caseName === "fee over cap") {
      payload = buildPayload(requirements, { Fee: "10001" });
    } else if (caseName === "XRP SendMax") {
      payload = buildPayload(requirements, { SendMax: "1000000" } as Partial<Payment>);
    } else if (caseName === "Paths") {
      payload = buildPayload(requirements, { Paths: [[{ account: issuer }]] } as Partial<Payment>);
    } else if (caseName === "DeliverMin") {
      payload = buildPayload(requirements, {
        DeliverMin: "1",
        Flags: 0x00020000,
      } as Partial<Payment>);
    } else if (caseName === "XRP partial payment") {
      payload = buildPayload(requirements, { Flags: 0x00020000 } as Partial<Payment>);
    } else if (caseName === "custom network missing NetworkID") {
      requirements = { ...baseXrpRequirements, network: "xrpl:21337" };
      payload = buildPayload(requirements);
    } else if (caseName === "custom network wrong NetworkID") {
      requirements = { ...baseXrpRequirements, network: "xrpl:21337" };
      payload = buildPayload(requirements, { NetworkID: 21338 } as Partial<Payment>);
    } else if (caseName === "wrong network") {
      payload = { ...payload, ...payloadPatch } as PaymentPayload;
    }

    const result = await facilitator.verify(payload, requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason?.toLowerCase()).toContain(expectedReason);
  });

  it("rejects mismatched maxTimeoutSeconds between accepted and requirements", async () => {
    const payload = buildPayload(baseXrpRequirements);

    const result = await facilitator.verify(
      {
        ...payload,
        accepted: { ...baseXrpRequirements, maxTimeoutSeconds: 120 },
      },
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("max_timeout");
  });

  it("rejects requirements that omit areFeesSponsored", async () => {
    const requirements: PaymentRequirements = {
      ...baseXrpRequirements,
      extra: { invoiceId },
    };

    const result = await facilitator.verify(buildPayload(requirements), requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("fees_sponsored");
  });

  it("rejects payloads that claim sponsored fees", async () => {
    const payload = buildPayload(baseXrpRequirements);

    const result = await facilitator.verify(
      {
        ...payload,
        accepted: {
          ...baseXrpRequirements,
          extra: { ...baseXrpRequirements.extra, areFeesSponsored: true },
        },
      },
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("fees_sponsored");
  });

  it("rejects mismatched destination tags between accepted and requirements", async () => {
    const payload = buildPayload(baseIouRequirements);

    const result = await facilitator.verify(
      {
        ...payload,
        accepted: {
          ...baseIouRequirements,
          extra: { ...baseIouRequirements.extra, destinationTag: 54321 },
        },
      },
      baseIouRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("destination_tag");
  });

  it("rejects IOU envelopes when both issuers are missing", async () => {
    const requirements: PaymentRequirements = {
      ...baseIouRequirements,
      extra: {
        areFeesSponsored: false,
        invoiceId,
        destinationTag: 12345,
      },
    };
    const payload = {
      ...buildPayload(baseIouRequirements),
      accepted: requirements,
    };

    const result = await facilitator.verify(payload, requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_xrpl_iou_issuer_missing");
  });

  it("rejects IOU envelopes with an invalid accepted issuer", async () => {
    const payload = buildPayload(baseIouRequirements);

    const result = await facilitator.verify(
      {
        ...payload,
        accepted: {
          ...baseIouRequirements,
          extra: { ...baseIouRequirements.extra, issuer: "not-a-classic-address" },
        },
      },
      baseIouRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_xrpl_iou_issuer_missing");
  });

  it("rejects IOU envelopes with an invalid required issuer", async () => {
    const requirements: PaymentRequirements = {
      ...baseIouRequirements,
      extra: { ...baseIouRequirements.extra, issuer: "not-a-classic-address" },
    };

    const result = await facilitator.verify(buildPayload(baseIouRequirements), requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_xrpl_iou_issuer_missing");
  });

  it("distinguishes mismatched valid IOU issuers from missing issuers", async () => {
    const payload = buildPayload(baseIouRequirements);

    const result = await facilitator.verify(
      {
        ...payload,
        accepted: {
          ...baseIouRequirements,
          extra: { ...baseIouRequirements.extra, issuer: otherWallet.classicAddress },
        },
      },
      baseIouRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_xrpl_iou_issuer_mismatch");
  });

  it("rejects payloads that select a method differing from the required one", async () => {
    const sequenceRequirements: PaymentRequirements = {
      ...baseXrpRequirements,
      extra: { ...baseXrpRequirements.extra, assetTransferMethod: "sequence" },
    };
    const payload = buildPayload(sequenceRequirements);

    const result = await facilitator.verify(
      {
        ...payload,
        accepted: {
          ...sequenceRequirements,
          extra: { ...sequenceRequirements.extra, assetTransferMethod: "ticketSequence" },
        },
      },
      sequenceRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("asset_transfer_method_mismatch");
  });

  it("rejects a transaction with a Delegate field", async () => {
    const payload = buildPayload(baseXrpRequirements, {
      Delegate: issuer,
    } as Partial<Payment>);

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("delegate");
  });

  it("rejects a sequence payment that carries a TicketSequence", async () => {
    const payload = buildPayload(baseXrpRequirements, { TicketSequence: 5 });

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("ticket_sequence_not_allowed");
  });

  it("rejects a sequence payment that is not current on the ledger", async () => {
    const staleFacilitator = createFacilitator({ getAccountSequence: async () => 2 });

    const result = await staleFacilitator.verify(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("sequence_not_current");
  });

  it("accepts a ticketSequence payment consuming an available ticket", async () => {
    const isTicketAvailable = vi.fn(async () => true);
    const ticketFacilitator = createFacilitator({ isTicketAvailable });
    const payload = buildPayload(ticketXrpRequirements, { Sequence: 0, TicketSequence: 5 });

    const result = await ticketFacilitator.verify(payload, ticketXrpRequirements);

    expect(isTicketAvailable).toHaveBeenCalledWith(payerWallet.classicAddress, 5, XRPL_TESTNET);
    expect(result).toMatchObject({
      isValid: true,
      payer: payerWallet.classicAddress,
    });
  });

  it("rejects a ticketSequence payment when the ticket is unavailable", async () => {
    const ticketFacilitator = createFacilitator({ isTicketAvailable: async () => false });
    const payload = buildPayload(ticketXrpRequirements, { Sequence: 0, TicketSequence: 5 });

    const result = await ticketFacilitator.verify(payload, ticketXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("ticket_not_available");
  });

  it("rejects a ticketSequence payment with a nonzero Sequence", async () => {
    const payload = buildPayload(ticketXrpRequirements, { Sequence: 1, TicketSequence: 5 });

    const result = await facilitator.verify(payload, ticketXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("sequence_must_be_zero");
  });

  it("rejects a ticketSequence payment without a TicketSequence", async () => {
    const payload = buildPayload(ticketXrpRequirements, { Sequence: 0 });

    const result = await facilitator.verify(payload, ticketXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("ticket_sequence_missing");
  });

  it("accepts a payment without invoice binding when no invoice id is required", async () => {
    const requirements: PaymentRequirements = {
      ...baseXrpRequirements,
      extra: { areFeesSponsored: false },
    };

    const result = await facilitator.verify(buildPayload(requirements), requirements);

    expect(result).toMatchObject({
      isValid: true,
      payer: payerWallet.classicAddress,
    });
  });

  it("rejects an invalid XRPL transaction signature", async () => {
    const payload = buildPayload(baseXrpRequirements);
    const signedTxBlob = String(payload.payload.signedTxBlob);
    const replacement = signedTxBlob.endsWith("0") ? "1" : "0";

    const result = await facilitator.verify(
      {
        ...payload,
        payload: {
          signedTxBlob: `${signedTxBlob.slice(0, -1)}${replacement}`,
        },
      },
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("signature");
  });

  it("rejects a transaction that fails XRPL simulation", async () => {
    const simulator = createFacilitator({
      simulateSignedTransaction: async () => ({ engineResult: "tecUNFUNDED_PAYMENT" }),
    });

    const result = await simulator.verify(buildPayload(baseXrpRequirements), baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("simulation_failed");
  });

  it("rejects a non-Payment transaction", async () => {
    const blob = buildBlobFromTransaction({
      TransactionType: "AccountSet",
      Account: payerWallet.classicAddress,
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: 1_000,
    });

    const result = await facilitator.verify(
      {
        x402Version: 2,
        accepted: baseXrpRequirements,
        payload: { signedTxBlob: blob },
      },
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("transaction_type");
  });

  it.each([
    ["currency", { currency: "EUR", issuer, value: "10.5" }],
    ["issuer", { currency: "USD", issuer: payTo, value: "10.5" }],
    ["value", { currency: "USD", issuer, value: "10.49" }],
  ])("rejects IOU %s mismatch", async (_field, amount) => {
    const result = await facilitator.verify(
      buildPayload(baseIouRequirements, {
        Amount: amount,
        SendMax: amount,
      }),
      baseIouRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason?.toLowerCase()).toContain("iou");
  });

  it("rejects IOU partial payments", async () => {
    const result = await facilitator.verify(
      buildPayload(baseIouRequirements, { Flags: 0x00020000 }),
      baseIouRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("partial_payment");
  });

  it.each([
    ["Paths", { Paths: [[{ account: issuer }]] } as Partial<Payment>, "paths"],
    [
      "DeliverMin",
      {
        DeliverMin: { currency: "USD", issuer, value: "0.01" },
        Flags: 0x00020000,
      } as Partial<Payment>,
      "delivermin",
    ],
  ])("rejects IOU %s", async (_field, override, expectedReason) => {
    const result = await facilitator.verify(
      buildPayload(baseIouRequirements, override),
      baseIouRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason?.toLowerCase()).toContain(expectedReason);
  });

  it("rejects IOU SendMax below destination amount", async () => {
    const result = await facilitator.verify(
      buildPayload(baseIouRequirements, {
        SendMax: { currency: "USD", issuer, value: "10.49" },
      }),
      baseIouRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason?.toLowerCase()).toContain("sendmax");
  });

  it("rejects payloads with an unsupported x402 version", async () => {
    const payload = buildPayload(baseXrpRequirements);

    const result = await facilitator.verify(
      { ...payload, x402Version: 1 } as PaymentPayload,
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("x402_version");
  });

  it("rejects payloads that accept a non-exact scheme", async () => {
    const payload = buildPayload(baseXrpRequirements);

    const result = await facilitator.verify(
      {
        ...payload,
        accepted: { ...baseXrpRequirements, scheme: "upto" },
      } as unknown as PaymentPayload,
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("scheme");
  });

  it.each([
    ["asset", { asset: "USD" }, "asset_mismatch"],
    ["amount", { amount: "999999" }, "amount_mismatch"],
    ["payTo", { payTo: issuer }, "pay_to_mismatch"],
  ])(
    "rejects mismatched %s between accepted and requirements",
    async (_field, acceptedPatch, expectedReason) => {
      const payload = buildPayload(baseXrpRequirements);

      const result = await facilitator.verify(
        { ...payload, accepted: { ...baseXrpRequirements, ...acceptedPatch } },
        baseXrpRequirements,
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain(expectedReason);
    },
  );

  it("accepts a custom-network payment with the matching NetworkID", async () => {
    const requirements = { ...baseXrpRequirements, network: "xrpl:21337" };
    const payload = buildPayload(requirements, { NetworkID: 21337 } as Partial<Payment>);

    const result = await facilitator.verify(payload, requirements);

    expect(result).toMatchObject({
      isValid: true,
      payer: payerWallet.classicAddress,
    });
  });

  it("rejects a standard-network payment that carries a NetworkID", async () => {
    const payload = buildPayload(baseXrpRequirements, { NetworkID: 1 } as Partial<Payment>);

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("network_id_for_standard_network");
  });

  it("rejects an XRP payment whose amount is an issued-currency object", async () => {
    const payload = buildPayload(baseXrpRequirements, {
      Amount: { currency: "USD", issuer, value: "1" },
    });

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("amount_xrp");
  });

  it("rejects an IOU payment without SendMax", async () => {
    const payload = buildPayload(baseIouRequirements, { SendMax: undefined });

    const result = await facilitator.verify(payload, baseIouRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("sendmax_required");
  });

  it("rejects an IOU SendMax with a mismatched currency", async () => {
    const payload = buildPayload(baseIouRequirements, {
      SendMax: { currency: "EUR", issuer, value: "10.5" },
    });

    const result = await facilitator.verify(payload, baseIouRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("sendmax_iou_mismatch");
  });

  it("rejects a payment without a LastLedgerSequence", async () => {
    const payload = buildPayload(baseXrpRequirements, { LastLedgerSequence: undefined });

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("lastledgersequence_missing");
  });

  it("rejects a LastLedgerSequence beyond the timeout policy", async () => {
    const payload = buildPayload(baseXrpRequirements, { LastLedgerSequence: 1_005 });

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("lastledgersequence_too_large");
  });

  it("rejects a sequence payment with Sequence 0", async () => {
    const payload = buildPayload(baseXrpRequirements, { Sequence: 0 });

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("sequence_missing");
  });

  it("rejects an InvoiceID that does not match the invoice id hash", async () => {
    const payload = buildPayload(baseXrpRequirements, { InvoiceID: "AB".repeat(32) });

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("invoice_id_mismatch");
  });

  it("rejects a transaction that omits the required destination tag", async () => {
    const payload = buildPayload(baseIouRequirements, { DestinationTag: undefined });

    const result = await facilitator.verify(payload, baseIouRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("destination_tag_mismatch");
  });

  it("rejects malformed destination tags in requirements", async () => {
    const requirements = {
      ...baseIouRequirements,
      extra: { ...baseIouRequirements.extra, destinationTag: "12345" },
    } as unknown as PaymentRequirements;
    const payload = buildPayload(requirements);

    const result = await facilitator.verify(payload, requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("destination_tag_malformed");
  });

  it("checks signer authorization against the payer account", async () => {
    const getAccountAuthorization = vi.fn(async () => ({ isMasterKeyDisabled: false }));
    const authFacilitator = createFacilitator({ getAccountAuthorization });

    const result = await authFacilitator.verify(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(true);
    expect(getAccountAuthorization).toHaveBeenCalledWith(payerWallet.classicAddress, XRPL_TESTNET);
  });

  it("rejects a payment signed by a key that is not authorized for the account", async () => {
    const payload = buildPayload(baseXrpRequirements, {
      Account: otherWallet.classicAddress,
    } as Partial<Payment>);

    const result = await facilitator.verify(payload, baseXrpRequirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("signer_not_authorized");
  });

  it("accepts a payment signed by the account's configured regular key", async () => {
    const regularKeyFacilitator = createFacilitator({
      getAccountAuthorization: async () => ({
        regularKey: payerWallet.classicAddress,
        isMasterKeyDisabled: true,
      }),
    });
    const payload = buildPayload(baseXrpRequirements, {
      Account: otherWallet.classicAddress,
    } as Partial<Payment>);

    const result = await regularKeyFacilitator.verify(payload, baseXrpRequirements);

    expect(result).toMatchObject({
      isValid: true,
      payer: otherWallet.classicAddress,
    });
  });

  it("rejects a master-key signature when the account's master key is disabled", async () => {
    const disabledMasterFacilitator = createFacilitator({
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: true }),
    });

    const result = await disabledMasterFacilitator.verify(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("signer_not_authorized");
  });

  it("accepts a legacy master-key signature when the master key is also the regular key", async () => {
    // rippled's fixMasterKeyAsRegularKey authorizes the regular key before the
    // master-disabled check; mirror that for legacy accounts whose RegularKey
    // equals their own address.
    const legacyFacilitator = createFacilitator({
      getAccountAuthorization: async () => ({
        regularKey: payerWallet.classicAddress,
        isMasterKeyDisabled: true,
      }),
    });

    const result = await legacyFacilitator.verify(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result).toMatchObject({
      isValid: true,
      payer: payerWallet.classicAddress,
    });
  });

  it("rejects a non-canonical signing public key", async () => {
    const payload = buildPayload(baseXrpRequirements);
    const decoded = decode(String(payload.payload.signedTxBlob)) as unknown as Record<
      string,
      unknown
    >;
    decoded.SigningPubKey = `04${"AB".repeat(64)}`;
    const nonCanonicalBlob = encode(decoded as unknown as Transaction);

    const result = await facilitator.verify(
      { ...payload, payload: { signedTxBlob: nonCanonicalBlob } },
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("signing_pub_key");
  });

  it("rejects a single-signed transaction that carries a Signers array", async () => {
    const payload = buildPayload(baseXrpRequirements);
    const decoded = decode(String(payload.payload.signedTxBlob)) as unknown as Record<
      string,
      unknown
    >;
    decoded.Signers = [
      {
        Signer: {
          Account: otherWallet.classicAddress,
          SigningPubKey: otherWallet.publicKey,
          TxnSignature: "AA".repeat(35),
        },
      },
    ];
    const hybridBlob = encode(decoded as unknown as Transaction);

    const result = await facilitator.verify(
      { ...payload, payload: { signedTxBlob: hybridBlob } },
      baseXrpRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("multisig_not_supported");
  });
});

describe("ExactXrplScheme facilitator settle", () => {
  const settledHash = "C".repeat(64);

  it("settles a validated tesSUCCESS submission", async () => {
    const submitSignedTransaction = vi.fn(async () => ({
      hash: settledHash,
      validated: true,
      resultCode: "tesSUCCESS",
    }));
    const settleFacilitator = createFacilitator({ submitSignedTransaction });

    const result = await settleFacilitator.settle(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result).toMatchObject({
      success: true,
      transaction: settledHash,
      network: XRPL_TESTNET,
      payer: payerWallet.classicAddress,
    });
    expect(submitSignedTransaction).toHaveBeenCalledOnce();
  });

  it("does not submit when re-verification fails", async () => {
    const submitSignedTransaction = vi.fn(async () => ({
      hash: settledHash,
      validated: true,
      resultCode: "tesSUCCESS",
    }));
    const settleFacilitator = createFacilitator({
      submitSignedTransaction,
      simulateSignedTransaction: async () => ({ engineResult: "tecUNFUNDED_PAYMENT" }),
    });

    const result = await settleFacilitator.settle(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toContain("simulation_failed");
    expect(submitSignedTransaction).not.toHaveBeenCalled();
  });

  it("fails settlement for a validated non-success result", async () => {
    const settleFacilitator = createFacilitator({
      submitSignedTransaction: async () => ({
        hash: settledHash,
        validated: true,
        resultCode: "tecPATH_DRY",
      }),
    });

    const result = await settleFacilitator.settle(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result.success).toBe(false);
    expect(result.transaction).toBe(settledHash);
    expect(result.errorReason).toContain("tecPATH_DRY");
  });

  it("fails settlement when the transaction is not validated", async () => {
    const settleFacilitator = createFacilitator({
      submitSignedTransaction: async () => ({
        hash: settledHash,
        validated: false,
        resultCode: "tesSUCCESS",
      }),
    });

    const result = await settleFacilitator.settle(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toContain("transaction_failed");
  });

  it("reports submission errors without settling", async () => {
    const settleFacilitator = createFacilitator({
      submitSignedTransaction: async () => {
        throw new Error("websocket disconnected");
      },
    });

    const result = await settleFacilitator.settle(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toContain("transaction_failed");
    expect(result.transaction).toMatch(/^[A-F0-9]{64}$/);
    expect(result.payer).toBe(payerWallet.classicAddress);
  });
});

describe("ExactXrplScheme facilitator settlement dedup", () => {
  const settledHash = "C".repeat(64);
  const successfulSubmission = {
    hash: settledHash,
    validated: true,
    resultCode: "tesSUCCESS",
  };

  it("rejects a second settlement of the same signed blob", async () => {
    const submitSignedTransaction = vi.fn(async () => successfulSubmission);
    const settleFacilitator = createFacilitator({ submitSignedTransaction });
    const payload = buildPayload(baseXrpRequirements);

    const first = await settleFacilitator.settle(payload, baseXrpRequirements);
    const second = await settleFacilitator.settle(payload, baseXrpRequirements);

    expect(first.success).toBe(true);
    expect(second).toMatchObject({
      success: false,
      errorReason: "duplicate_settlement",
      transaction: "",
      network: XRPL_TESTNET,
      payer: payerWallet.classicAddress,
    });
    expect(submitSignedTransaction).toHaveBeenCalledOnce();
  });

  it("settles exactly once across concurrent calls with the same signed blob", async () => {
    let resolveSubmission: (result: typeof successfulSubmission) => void = () => {};
    const submitSignedTransaction = vi.fn(
      () =>
        new Promise<typeof successfulSubmission>(resolve => {
          resolveSubmission = resolve;
        }),
    );
    const settleFacilitator = createFacilitator({ submitSignedTransaction });
    const payload = buildPayload(baseXrpRequirements);

    const settlements = Array.from({ length: 10 }, () =>
      settleFacilitator.settle(payload, baseXrpRequirements),
    );
    // Wait for every call to pass verification and reach the cache check
    // while the winning submission is still in flight.
    await vi.waitFor(() => expect(submitSignedTransaction).toHaveBeenCalledOnce());
    resolveSubmission(successfulSubmission);
    const results = await Promise.all(settlements);

    expect(results.filter(result => result.success)).toHaveLength(1);
    const duplicates = results.filter(result => !result.success);
    expect(duplicates).toHaveLength(9);
    for (const duplicate of duplicates) {
      expect(duplicate.errorReason).toBe("duplicate_settlement");
    }
    expect(submitSignedTransaction).toHaveBeenCalledOnce();
  });

  it("does not block settlements of distinct transactions", async () => {
    const submitSignedTransaction = vi.fn(async () => successfulSubmission);
    const settleFacilitator = createFacilitator({ submitSignedTransaction });

    const first = await settleFacilitator.settle(
      buildPayload(baseXrpRequirements),
      baseXrpRequirements,
    );
    const second = await settleFacilitator.settle(
      buildPayload(baseXrpRequirements, { Fee: "10" }),
      baseXrpRequirements,
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(submitSignedTransaction).toHaveBeenCalledTimes(2);
  });

  it("blocks duplicates across scheme instances sharing a settlement cache", async () => {
    const sharedCache = new SettlementCache();
    const submitSignedTransaction = vi.fn(async () => successfulSubmission);
    const firstScheme = createFacilitator({ submitSignedTransaction }, sharedCache);
    const secondScheme = createFacilitator({ submitSignedTransaction }, sharedCache);
    const payload = buildPayload(baseXrpRequirements);

    const first = await firstScheme.settle(payload, baseXrpRequirements);
    const second = await secondScheme.settle(payload, baseXrpRequirements);

    expect(first.success).toBe(true);
    expect(second.errorReason).toBe("duplicate_settlement");
    expect(submitSignedTransaction).toHaveBeenCalledOnce();
  });

  it("evicts a cache entry only after its transaction's landable window elapses", async () => {
    vi.useFakeTimers();
    try {
      const submitSignedTransaction = vi.fn(async () => successfulSubmission);
      const settleFacilitator = createFacilitator({ submitSignedTransaction });
      const payload = buildPayload(baseXrpRequirements);
      const entryTtlMs = baseXrpRequirements.maxTimeoutSeconds * 1000 + SETTLEMENT_TTL_MS;

      const first = await settleFacilitator.settle(payload, baseXrpRequirements);
      // Still within the landable window: a slow-to-validate duplicate must not
      // slip through because the cache entry was evicted early.
      vi.advanceTimersByTime(SETTLEMENT_TTL_MS + 1);
      const duringWindow = await settleFacilitator.settle(payload, baseXrpRequirements);
      // Past the landable window: the transaction can no longer land, so re-use
      // of the key is harmless and the entry is evicted.
      vi.advanceTimersByTime(entryTtlMs);
      const afterWindow = await settleFacilitator.settle(payload, baseXrpRequirements);

      expect(first.success).toBe(true);
      expect(duringWindow.errorReason).toBe("duplicate_settlement");
      expect(afterWindow.success).toBe(true);
      expect(submitSignedTransaction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors heterogeneous per-entry TTLs when pruning", () => {
    vi.useFakeTimers();
    try {
      const cache = new SettlementCache();

      cache.isDuplicate("tx-short", SETTLEMENT_TTL_MS);
      cache.isDuplicate("tx-long", 10 * SETTLEMENT_TTL_MS);
      vi.advanceTimersByTime(SETTLEMENT_TTL_MS + 1);

      expect(cache.isDuplicate("tx-short", SETTLEMENT_TTL_MS)).toBe(false); // expired, re-inserted
      expect(cache.isDuplicate("tx-long", 10 * SETTLEMENT_TTL_MS)).toBe(true); // still within its window
    } finally {
      vi.useRealTimers();
    }
  });
});
