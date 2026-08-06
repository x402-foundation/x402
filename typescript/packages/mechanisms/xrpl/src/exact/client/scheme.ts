import {
  createTickets,
  createXrplClient,
  getMaxLastLedgerSequence,
  getXrplTicketSequences,
  invoiceIdToInvoiceIdField,
  isDecimalString,
  isIntegerString,
  isValidDestinationTag,
  isXrplAssetTransferMethod,
  isXrplNetwork,
  parseXrplNetworkId,
} from "../../utils";
import type { ClientXrplSigner, XrplAssetTransferMethod, XrplClientOptions } from "../../types";
import type {
  Network,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { Payment } from "xrpl";

/**
 * XRPL client implementation for the exact payment scheme.
 */
export class ExactXrplScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new XRPL exact client scheme.
   *
   * @param signer - XRPL signer used to sign payment transactions
   * @param options - Optional client configuration
   */
  constructor(
    private readonly signer: ClientXrplSigner,
    private readonly options: XrplClientOptions = {},
  ) {}

  /**
   * Creates an XRPL exact payment payload.
   *
   * @param x402Version - x402 protocol version
   * @param paymentRequirements - Payment requirements from the resource server
   * @returns Signed payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    this.validatePaymentRequirements(paymentRequirements);
    const method = getSelectedAssetTransferMethod(paymentRequirements);

    const unsignedPayment = await this.buildPaymentTransaction(paymentRequirements, method);
    const preparedPayment = await this.preparePaymentTransaction(
      unsignedPayment,
      paymentRequirements,
      method,
    );
    const signed = await this.signer.sign(preparedPayment);

    return {
      x402Version,
      payload: {
        signedTxBlob: signed.signedTxBlob,
      },
    };
  }

  /**
   * Builds the XRPL Payment transaction that the payer will sign.
   *
   * @param requirements - Payment requirements to encode
   * @param method - Selected asset transfer method
   * @returns Unsigned XRPL payment transaction
   */
  private async buildPaymentTransaction(
    requirements: PaymentRequirements,
    method: XrplAssetTransferMethod,
  ): Promise<Payment> {
    const networkId = parseXrplNetworkId(requirements.network);
    const currentLedgerIndex = this.options.getCurrentLedgerIndex
      ? await this.options.getCurrentLedgerIndex(requirements.network)
      : undefined;
    const lastLedgerSequence =
      currentLedgerIndex === undefined
        ? undefined
        : getMaxLastLedgerSequence(currentLedgerIndex, requirements);
    const invoiceId =
      typeof requirements.extra?.invoiceId === "string" ? requirements.extra.invoiceId : undefined;
    const destinationTag = requirements.extra?.destinationTag;
    if (destinationTag !== undefined && !isValidDestinationTag(destinationTag)) {
      throw new Error(
        "XRPL exact payments require extra.destinationTag to be a 32-bit unsigned integer",
      );
    }
    const isXrp = requirements.asset === "XRP";
    let amount: Payment["Amount"] = requirements.amount;
    let sendMax: Payment["SendMax"];
    if (!isXrp) {
      amount = {
        currency: requirements.asset,
        issuer: String(requirements.extra?.issuer),
        value: requirements.amount,
      };
      sendMax = {
        currency: requirements.asset,
        issuer: String(requirements.extra?.issuer),
        value: requirements.amount,
      };
    }
    const transaction: Payment = {
      TransactionType: "Payment",
      Account: this.signer.classicAddress,
      Destination: requirements.payTo,
      Amount: amount,
      ...(invoiceId !== undefined ? { InvoiceID: invoiceIdToInvoiceIdField(invoiceId) } : {}),
      ...(this.options.feeDrops !== undefined ? { Fee: this.options.feeDrops } : {}),
      ...(lastLedgerSequence !== undefined ? { LastLedgerSequence: lastLedgerSequence } : {}),
      ...(destinationTag !== undefined ? { DestinationTag: destinationTag } : {}),
      ...(networkId > 1024 ? { NetworkID: networkId } : {}),
    };

    if (sendMax !== undefined) {
      transaction.SendMax = sendMax;
    }

    if (method === "ticketSequence") {
      transaction.Sequence = 0;
      transaction.TicketSequence = await this.getAvailableTicketSequence(requirements.network);
    }

    return transaction;
  }

  /**
   * Finds an available ticket sequence for the payer account.
   *
   * @param network - XRPL network id
   * @returns Available ticket sequence
   */
  private async getAvailableTicketSequence(network: Network): Promise<number> {
    const account = this.signer.classicAddress;
    const ticketSequence = this.options.getAvailableTicketSequence
      ? await this.options.getAvailableTicketSequence(account, network)
      : (await getXrplTicketSequences(account, network, this.options))[0];
    if (ticketSequence !== undefined) {
      return ticketSequence;
    }

    const ticketCreateCount = this.options.ticketCreateCount ?? 1;
    if (ticketCreateCount === 0) {
      throw new Error(
        `No available XRPL ticket for ${account}; automatic ticket creation is disabled`,
      );
    }

    const [createdTicketSequence] = await createTickets(
      this.signer,
      network,
      ticketCreateCount,
      this.options,
    );
    if (createdTicketSequence === undefined) {
      throw new Error(`TicketCreate returned no tickets for ${account}`);
    }
    return createdTicketSequence;
  }

  /**
   * Prepares an XRPL Payment with ledger-derived fields before signing.
   *
   * @param transaction - Locally built payment transaction
   * @param requirements - Payment requirements to satisfy
   * @param method - Selected asset transfer method
   * @returns Prepared XRPL payment transaction
   */
  private async preparePaymentTransaction(
    transaction: Payment,
    requirements: PaymentRequirements,
    method: XrplAssetTransferMethod,
  ): Promise<Payment> {
    const preparedPayment = this.options.preparePaymentTransaction
      ? await this.options.preparePaymentTransaction(transaction, requirements)
      : await this.autofillPaymentTransaction(transaction, requirements);

    this.validatePreparedPaymentTransaction(preparedPayment, requirements.network, method);
    return preparedPayment;
  }

  /**
   * Uses xrpl.js autofill to populate Sequence and any other ledger-derived fields.
   *
   * @param transaction - Locally built payment transaction
   * @param requirements - Payment requirements to satisfy
   * @returns Autofilled XRPL payment transaction
   */
  private async autofillPaymentTransaction(
    transaction: Payment,
    requirements: PaymentRequirements,
  ): Promise<Payment> {
    const client = createXrplClient(requirements.network, this.options);

    try {
      await client.connect();
      const currentLedgerIndex = this.options.getCurrentLedgerIndex
        ? await this.options.getCurrentLedgerIndex(requirements.network)
        : await client.getLedgerIndex();
      const paymentWithExpiry: Payment = {
        ...transaction,
        LastLedgerSequence:
          transaction.LastLedgerSequence ??
          getMaxLastLedgerSequence(currentLedgerIndex, requirements),
      };

      return client.autofill(paymentWithExpiry);
    } finally {
      await client.disconnect();
    }
  }

  /**
   * Ensures the transaction can be submitted after signing.
   *
   * @param transaction - Prepared XRPL payment transaction
   * @param network - XRPL network id
   * @param method - Selected asset transfer method
   */
  private validatePreparedPaymentTransaction(
    transaction: Payment,
    network: Network,
    method: XrplAssetTransferMethod,
  ): void {
    if (transaction.TransactionType !== "Payment") {
      throw new Error("preparePaymentTransaction must return an XRPL Payment transaction");
    }
    if (method === "sequence") {
      if (transaction.TicketSequence !== undefined) {
        throw new Error("sequence payments must not set TicketSequence");
      }
      if (typeof transaction.Sequence !== "number" || transaction.Sequence === 0) {
        throw new Error("sequence payments must set the account Sequence");
      }
    } else {
      if (transaction.Sequence !== 0) {
        throw new Error("ticketSequence payments must set Sequence to 0");
      }
      if (typeof transaction.TicketSequence !== "number") {
        throw new Error("ticketSequence payments must set TicketSequence");
      }
    }
    if (typeof transaction.Fee !== "string" || !/^\d+$/.test(transaction.Fee)) {
      throw new Error("preparePaymentTransaction must set Fee in drops");
    }
    if (typeof transaction.LastLedgerSequence !== "number") {
      throw new Error("preparePaymentTransaction must set LastLedgerSequence");
    }
    const networkId = parseXrplNetworkId(network);
    if (networkId <= 1024 && transaction.NetworkID !== undefined) {
      throw new Error(
        "preparePaymentTransaction must not set NetworkID for standard XRPL networks",
      );
    }
    if (networkId > 1024) {
      if (transaction.NetworkID !== networkId) {
        throw new Error("preparePaymentTransaction must set NetworkID for custom XRPL networks");
      }
    }
  }

  /**
   * Validates requirements before building a signed payment.
   *
   * @param requirements - Payment requirements to validate
   */
  private validatePaymentRequirements(requirements: PaymentRequirements): void {
    if (requirements.scheme !== "exact") {
      throw new Error(`Unsupported scheme: ${requirements.scheme}`);
    }
    if (!isXrplNetwork(requirements.network)) {
      throw new Error(`Unsupported XRPL network: ${requirements.network}`);
    }
    if (requirements.extra?.areFeesSponsored !== false) {
      throw new Error(
        "XRPL exact payments require extra.areFeesSponsored to be false; the payer pays the XRPL transaction fee",
      );
    }
    if (requirements.extra?.invoiceId !== undefined) {
      if (typeof requirements.extra.invoiceId !== "string" || requirements.extra.invoiceId === "") {
        throw new Error("XRPL exact payments require a non-empty extra.invoiceId when provided");
      }
    }
    if (requirements.asset === "XRP") {
      if (!isIntegerString(requirements.amount)) {
        throw new Error("XRPL native payments require amount as an integer drops string");
      }
      return;
    }
    if (typeof requirements.extra?.issuer !== "string") {
      throw new Error("XRPL IOU payments require extra.issuer");
    }
    if (!isDecimalString(requirements.amount)) {
      throw new Error(
        "XRPL IOU payments require amount as an issued-currency decimal value string",
      );
    }
  }
}

/**
 * Reads the asset transfer method pinned by the payment requirements.
 *
 * Clients follow the method advertised in the requirements and default to
 * "sequence"; offering "ticketSequence" is done by advertising a separate
 * accepts entry that pins it.
 *
 * @param requirements - Payment requirements from the resource server
 * @returns Selected asset transfer method
 */
function getSelectedAssetTransferMethod(
  requirements: PaymentRequirements,
): XrplAssetTransferMethod {
  const method = requirements.extra?.assetTransferMethod;
  if (method === undefined) {
    return "sequence";
  }
  if (!isXrplAssetTransferMethod(method)) {
    throw new Error(`Unsupported assetTransferMethod: ${String(method)}`);
  }
  return method;
}
