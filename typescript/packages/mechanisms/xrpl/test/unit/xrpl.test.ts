import { describe, expect, it, vi } from "vitest";
import { Wallet, decode } from "xrpl";
import { ExactXrplScheme as ExactXrplClientScheme } from "../../src/exact/client/scheme";
import { ExactXrplScheme as ExactXrplFacilitatorScheme } from "../../src/exact/facilitator/scheme";
import { ExactXrplScheme as ExactXrplServerScheme } from "../../src/exact/server/scheme";
import { createXrplWalletSigner } from "../../src/signer";
import {
  DEFAULT_MAX_FEE_DROPS,
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
): ExactXrplFacilitatorScheme {
  return new ExactXrplFacilitatorScheme({
    getCurrentLedgerIndex: async () => 990,
    getAccountSequence: async () => 1,
    isTicketAvailable: async () => true,
    maxFeeDrops: DEFAULT_MAX_FEE_DROPS,
    simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS" }),
    ...overrides,
  });
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

    const ticketSequences = await createTickets(payerWallet, XRPL_TESTNET, 2, {
      clientFactory: () => fakeClient,
    });

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
      createTickets(payerWallet, XRPL_TESTNET, 1, { clientFactory: () => fakeClient }),
    ).rejects.toThrow("tecINSUFFICIENT_RESERVE");
  });

  it("rejects invalid ticket counts before contacting the network", async () => {
    await expect(createTickets(payerWallet, XRPL_TESTNET, 0)).rejects.toThrow("between 1 and 250");
    await expect(createTickets(payerWallet, XRPL_TESTNET, 251)).rejects.toThrow(
      "between 1 and 250",
    );
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

  it("requires an available ticket for ticketSequence payments", async () => {
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      getCurrentLedgerIndex: async () => 980,
      getAvailableTicketSequence: async () => undefined,
      preparePaymentTransaction: preparePaymentForTest,
    });

    await expect(client.createPaymentPayload(2, ticketXrpRequirements)).rejects.toThrow(
      "createTickets",
    );
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

  it.each([
    ["malformed signedTxBlob", { payload: { signedTxBlob: "not-hex" } }, "malformed"],
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
    } else if (caseName === "malformed signedTxBlob") {
      payload = { ...payload, payload: payloadPatch.payload as Record<string, unknown> };
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
});
