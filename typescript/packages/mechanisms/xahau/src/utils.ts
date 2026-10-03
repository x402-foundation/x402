import { createHash } from "crypto";
import {
  Client,
  decode,
  hashes,
  isValidClassicAddress,
  type SubmittableTransaction,
  type TicketCreate,
  type Transaction,
  type TransactionMetadata,
} from "xahau";
import {
  DEFAULT_LEDGER_CLOSE_SECONDS,
  DEFAULT_LEDGER_TOLERANCE,
  LSF_DISABLE_MASTER,
  MAX_ACCOUNT_TICKETS,
  MAX_DESTINATION_TAG,
  XAHAU_MAINNET,
  XAHAU_MAINNET_WS_URL,
  XAHAU_TESTNET,
  XAHAU_TESTNET_WS_URL,
} from "./constants";
import type {
  ClientXahauSigner,
  ExactXahauPayload,
  XahauAccountAuthorization,
  XahauAssetTransferMethod,
  XahauClientFactory,
  XahauFacilitatorOptions,
  XahauNetwork,
  XahauSettlementResult,
  XahauSimulationResult,
} from "./types";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * Returns true when a value is a plain object record.
 *
 * @param value - Value to inspect
 * @returns Whether value is a record
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a network id is a Xahau CAIP-2 id.
 *
 * @param network - Network id to inspect
 * @returns Whether the network id is Xahau
 */
export function isXahauNetwork(network: Network): network is XahauNetwork {
  return /^xahau:\d+$/.test(network);
}

/**
 * Parses a Xahau CAIP-2 network id into its numeric NetworkID.
 *
 * @param network - Xahau network id
 * @returns Numeric Xahau NetworkID
 */
export function parseXahauNetworkId(network: Network): number {
  if (!isXahauNetwork(network)) {
    throw new Error(`Invalid Xahau network: ${network}`);
  }

  const value = Number(network.slice("xahau:".length));
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Invalid Xahau network id: ${network}`);
  }

  return value;
}

/**
 * Checks whether a value is a supported Xahau asset transfer method.
 *
 * @param value - Value to inspect
 * @returns Whether the value is "sequence" or "ticketSequence"
 */
export function isXahauAssetTransferMethod(value: unknown): value is XahauAssetTransferMethod {
  return value === "sequence" || value === "ticketSequence";
}

/**
 * Resolves the selected asset transfer method for a payment payload.
 *
 * Resolution order: `accepted.extra.assetTransferMethod`, then
 * `paymentRequirements.extra.assetTransferMethod`, then `"sequence"`. When the
 * requirements pin a method, the payload must not select a different one.
 *
 * @param payload - x402 payment payload
 * @param requirements - Payment requirements
 * @returns The selected method, or an invalid reason
 */
export function resolveAssetTransferMethod(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): { method: XahauAssetTransferMethod } | { error: string } {
  const requiredMethod = requirements.extra?.assetTransferMethod;
  const acceptedMethod = payload.accepted.extra?.assetTransferMethod;
  if (requiredMethod !== undefined && !isXahauAssetTransferMethod(requiredMethod)) {
    return { error: "invalid_exact_xahau_asset_transfer_method" };
  }
  if (acceptedMethod !== undefined && !isXahauAssetTransferMethod(acceptedMethod)) {
    return { error: "invalid_exact_xahau_asset_transfer_method" };
  }

  const selectedMethod: XahauAssetTransferMethod = isXahauAssetTransferMethod(acceptedMethod)
    ? acceptedMethod
    : isXahauAssetTransferMethod(requiredMethod)
      ? requiredMethod
      : "sequence";
  if (requiredMethod !== undefined && selectedMethod !== requiredMethod) {
    return { error: "invalid_exact_xahau_asset_transfer_method_mismatch" };
  }
  return { method: selectedMethod };
}

/**
 * Resolves a Xahau WebSocket URL for a network.
 *
 * @param network - Xahau network id
 * @param options - Facilitator options
 * @returns WebSocket URL
 */
export function resolveXahauWsUrl(
  network: Network,
  options: Pick<XahauFacilitatorOptions, "wsUrlByNetwork"> = {},
): string {
  const xahauNetwork = network as XahauNetwork;
  if (options.wsUrlByNetwork?.[xahauNetwork]) {
    return options.wsUrlByNetwork[xahauNetwork]!;
  }

  if (network === XAHAU_MAINNET) return XAHAU_MAINNET_WS_URL;
  if (network === XAHAU_TESTNET) return XAHAU_TESTNET_WS_URL;

  throw new Error(`No Xahau WebSocket URL configured for ${network}`);
}

/**
 * Converts an invoice id to the Xahau InvoiceID field value.
 *
 * @param invoiceId - Invoice id
 * @returns Uppercase SHA-256 hex digest
 */
export function invoiceIdToInvoiceIdField(invoiceId: string): string {
  return createHash("sha256").update(invoiceId, "utf8").digest("hex").toUpperCase();
}

/**
 * Decodes a signed Xahau transaction blob.
 *
 * @param signedTxBlob - Hex-encoded signed transaction blob
 * @returns Decoded transaction
 */
export function decodeSignedTransactionBlob(signedTxBlob: string): Transaction {
  if (!/^[A-Fa-f0-9]+$/.test(signedTxBlob)) {
    throw new Error("signedTxBlob must be hex");
  }
  return decode(signedTxBlob) as unknown as Transaction;
}

/**
 * Extracts the exact Xahau payload from a payment payload.
 *
 * @param payload - x402 payment payload
 * @returns Xahau exact payload
 */
export function getExactXahauPayload(payload: PaymentPayload): ExactXahauPayload {
  if (!isRecord(payload.payload) || typeof payload.payload.signedTxBlob !== "string") {
    throw new Error("Xahau exact payload requires signedTxBlob");
  }
  return payload.payload as ExactXahauPayload;
}

/**
 * Checks whether a value is a base-10 unsigned integer string.
 *
 * @param value - Value to inspect
 * @returns Whether the value is an integer string
 */
export function isIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Checks whether a value is a non-negative decimal string usable as a Xahau
 * issued-currency value.
 *
 * @param value - Value to inspect
 * @returns Whether the value is a decimal string
 */
export function isDecimalString(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

/**
 * Checks whether a value is a valid Xahau destination tag.
 *
 * @param value - Value to inspect
 * @returns Whether the value is a 32-bit unsigned integer
 */
export function isValidDestinationTag(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DESTINATION_TAG
  );
}

/**
 * Builds the max allowed LastLedgerSequence for requirements.
 *
 * @param currentLedgerIndex - Current validated ledger index
 * @param requirements - Payment requirements
 * @returns Maximum allowed LastLedgerSequence
 */
export function getMaxLastLedgerSequence(
  currentLedgerIndex: number,
  requirements: PaymentRequirements,
): number {
  return (
    currentLedgerIndex +
    Math.ceil(requirements.maxTimeoutSeconds / DEFAULT_LEDGER_CLOSE_SECONDS) +
    DEFAULT_LEDGER_TOLERANCE
  );
}

/**
 * Validates and returns a classic Xahau address.
 *
 * @param address - Address to validate
 * @param fieldName - Field name for error messages
 * @returns The same address
 */
export function requireClassicAddress(address: unknown, fieldName: string): string {
  if (typeof address !== "string" || !isValidClassicAddress(address)) {
    throw new Error(`${fieldName} must be a valid Xahau classic address`);
  }
  return address;
}

/**
 * Returns true for Xahau issued currency amount objects.
 *
 * @param amount - Amount value to inspect
 * @returns Whether the amount is an issued-currency object
 */
export function isIssuedCurrencyAmount(amount: unknown): amount is {
  currency: string;
  issuer: string;
  value: string;
} {
  return (
    isRecord(amount) &&
    typeof amount.currency === "string" &&
    typeof amount.issuer === "string" &&
    typeof amount.value === "string"
  );
}

/**
 * Compares non-negative decimal strings without floating point arithmetic.
 *
 * @param left - Left decimal string
 * @param right - Right decimal string
 * @returns -1, 0, or 1
 */
export function compareDecimalStrings(left: string, right: string): number {
  const normalizedLeft = normalizeDecimalString(left);
  const normalizedRight = normalizeDecimalString(right);

  if (normalizedLeft.whole.length !== normalizedRight.whole.length) {
    return normalizedLeft.whole.length > normalizedRight.whole.length ? 1 : -1;
  }
  if (normalizedLeft.whole !== normalizedRight.whole) {
    return normalizedLeft.whole > normalizedRight.whole ? 1 : -1;
  }

  const maxFractionLength = Math.max(
    normalizedLeft.fraction.length,
    normalizedRight.fraction.length,
  );
  const leftFraction = normalizedLeft.fraction.padEnd(maxFractionLength, "0");
  const rightFraction = normalizedRight.fraction.padEnd(maxFractionLength, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction > rightFraction ? 1 : -1;
}

/**
 * Computes the transaction hash for a signed blob.
 *
 * @param signedTxBlob - Hex-encoded signed transaction blob
 * @returns Xahau transaction hash
 */
export function getSignedTransactionHash(signedTxBlob: string): string {
  return hashes.hashSignedTx(signedTxBlob);
}

/**
 * Creates a Xahau SDK client.
 *
 * @param network - Xahau network id
 * @param options - Facilitator options
 * @returns Xahau client
 */
export function createXahauClient(
  network: Network,
  options: Pick<XahauFacilitatorOptions, "wsUrlByNetwork" | "clientFactory"> = {},
): Client {
  const wsUrl = resolveXahauWsUrl(network, options);
  const factory: XahauClientFactory = options.clientFactory ?? (url => new Client(url));
  return factory(wsUrl);
}

/**
 * Gets the current validated ledger index.
 *
 * @param network - Xahau network id
 * @param options - Facilitator options
 * @returns Current ledger index
 */
export async function getCurrentLedgerIndex(
  network: Network,
  options: Pick<
    XahauFacilitatorOptions,
    "getCurrentLedgerIndex" | "wsUrlByNetwork" | "clientFactory"
  >,
): Promise<number> {
  if (options.getCurrentLedgerIndex) {
    return options.getCurrentLedgerIndex(network);
  }

  const client = createXahauClient(network, options);
  try {
    await client.connect();
    return await client.getLedgerIndex();
  } finally {
    await client.disconnect();
  }
}

/**
 * Gets the current on-network sequence for a Xahau account.
 *
 * @param account - Xahau classic address
 * @param network - Xahau network id
 * @param options - Facilitator options
 * @returns Current account sequence
 */
export async function getXahauAccountSequence(
  account: string,
  network: Network,
  options: Pick<XahauFacilitatorOptions, "getAccountSequence" | "wsUrlByNetwork" | "clientFactory">,
): Promise<number> {
  if (options.getAccountSequence) {
    return options.getAccountSequence(account, network);
  }

  const client = createXahauClient(network, options);
  try {
    await client.connect();
    const response = await client.request({
      command: "account_info",
      account,
      ledger_index: "validated",
    });
    return response.result.account_data.Sequence;
  } finally {
    await client.disconnect();
  }
}

/**
 * Gets the signing authorization state for a Xahau account.
 *
 * Reads the account's configured regular key and master-key status from the
 * validated ledger so verification can bind the payload's `SigningPubKey` to
 * a key pair that is currently authorized to sign for `Account`.
 *
 * @param account - Xahau classic address
 * @param network - Xahau network id
 * @param options - Facilitator options
 * @returns Regular key and master-key status for the account
 */
export async function getXahauAccountAuthorization(
  account: string,
  network: Network,
  options: Pick<
    XahauFacilitatorOptions,
    "getAccountAuthorization" | "wsUrlByNetwork" | "clientFactory"
  >,
): Promise<XahauAccountAuthorization> {
  if (options.getAccountAuthorization) {
    return options.getAccountAuthorization(account, network);
  }

  const client = createXahauClient(network, options);
  try {
    await client.connect();
    const response = await client.request({
      command: "account_info",
      account,
      ledger_index: "validated",
    });
    const accountData = response.result.account_data;
    return {
      regularKey: accountData.RegularKey,
      isMasterKeyDisabled: ((accountData.Flags ?? 0) & LSF_DISABLE_MASTER) !== 0,
    };
  } finally {
    await client.disconnect();
  }
}

/**
 * Lists the available ticket sequences for a Xahau account.
 *
 * @param account - Xahau classic address
 * @param network - Xahau network id
 * @param options - Client or facilitator connection options
 * @returns Ascending list of available ticket sequences
 */
export async function getXahauTicketSequences(
  account: string,
  network: Network,
  options: Pick<XahauFacilitatorOptions, "wsUrlByNetwork" | "clientFactory"> = {},
): Promise<number[]> {
  const client = createXahauClient(network, options);
  try {
    await client.connect();
    const ticketSequences: number[] = [];
    let marker: unknown;
    do {
      const response = await client.request({
        command: "account_objects",
        account,
        type: "ticket",
        ledger_index: "validated",
        ...(marker !== undefined ? { marker } : {}),
      });
      for (const ledgerObject of response.result.account_objects) {
        if (ledgerObject.LedgerEntryType === "Ticket") {
          ticketSequences.push(ledgerObject.TicketSequence);
        }
      }
      marker = response.result.marker;
    } while (marker !== undefined);
    return ticketSequences.sort((left, right) => left - right);
  } finally {
    await client.disconnect();
  }
}

/**
 * Checks whether a ticket sequence is available for a Xahau account.
 *
 * @param account - Xahau classic address
 * @param ticketSequence - Ticket sequence the signed transaction consumes
 * @param network - Xahau network id
 * @param options - Facilitator options
 * @returns Whether the ticket is available
 */
export async function isXahauTicketAvailable(
  account: string,
  ticketSequence: number,
  network: Network,
  options: Pick<XahauFacilitatorOptions, "isTicketAvailable" | "wsUrlByNetwork" | "clientFactory">,
): Promise<boolean> {
  if (options.isTicketAvailable) {
    return options.isTicketAvailable(account, ticketSequence, network);
  }

  const ticketSequences = await getXahauTicketSequences(account, network, options);
  return ticketSequences.includes(ticketSequence);
}

/**
 * Creates Xahau tickets for ticketSequence payments.
 *
 * Submits a `TicketCreate` transaction and waits for a validated result.
 * Each outstanding ticket locks owner reserve until it is used or deleted,
 * and an account can hold at most 250 outstanding tickets.
 *
 * @param signer - Xahau account that owns and signs the TicketCreate
 * @param network - Xahau network id
 * @param ticketCount - Number of tickets to create
 * @param options - Client connection options
 * @returns Ascending list of created ticket sequences
 */
export async function createTickets(
  signer: ClientXahauSigner,
  network: Network,
  ticketCount: number,
  options: Pick<XahauFacilitatorOptions, "wsUrlByNetwork" | "clientFactory"> = {},
): Promise<number[]> {
  if (!Number.isInteger(ticketCount) || ticketCount < 1 || ticketCount > MAX_ACCOUNT_TICKETS) {
    throw new Error(`ticketCount must be an integer between 1 and ${MAX_ACCOUNT_TICKETS}`);
  }

  const client = createXahauClient(network, options);
  try {
    await client.connect();
    const ticketCreate: TicketCreate = {
      TransactionType: "TicketCreate",
      Account: signer.classicAddress,
      TicketCount: ticketCount,
    };
    const prepared = await client.autofill(ticketCreate);
    const signed = await signer.sign(prepared);
    const response = await client.submitAndWait(signed.signedTxBlob, {
      autofill: false,
      failHard: true,
    });
    const meta = response.result.meta;
    if (typeof meta !== "object" || meta === null) {
      throw new Error("TicketCreate returned no transaction metadata");
    }
    if (meta.TransactionResult !== "tesSUCCESS") {
      throw new Error(`TicketCreate failed: ${meta.TransactionResult}`);
    }
    return extractCreatedTicketSequences(meta);
  } finally {
    await client.disconnect();
  }
}

/**
 * Submits a signed transaction and waits for a validated result.
 *
 * @param signedTxBlob - Hex-encoded signed transaction blob
 * @param network - Xahau network id
 * @param options - Facilitator options
 * @returns Settlement result
 */
export async function submitSignedTransaction(
  signedTxBlob: string,
  network: Network,
  options: Pick<
    XahauFacilitatorOptions,
    "submitSignedTransaction" | "wsUrlByNetwork" | "clientFactory"
  >,
): Promise<XahauSettlementResult> {
  if (options.submitSignedTransaction) {
    return options.submitSignedTransaction(signedTxBlob, network);
  }

  const client = createXahauClient(network, options);
  try {
    await client.connect();
    const response = await client.submitAndWait(signedTxBlob, {
      autofill: false,
      failHard: true,
    });
    const resultCode =
      typeof response.result.meta === "object" && response.result.meta !== null
        ? response.result.meta.TransactionResult
        : "unknown";
    return {
      hash: response.result.hash ?? getSignedTransactionHash(signedTxBlob),
      validated: response.result.validated === true,
      resultCode,
    };
  } finally {
    await client.disconnect();
  }
}

/**
 * Simulates a signed Xahau transaction without submitting it.
 *
 * The Xahau simulate API only accepts unsigned transactions, so the signature
 * fields are stripped from the decoded transaction before simulation.
 *
 * @param signedTxBlob - Hex-encoded signed transaction blob
 * @param network - Xahau network id
 * @param options - Facilitator options
 * @returns Xahau simulation result
 */
export async function simulateSignedTransaction(
  signedTxBlob: string,
  network: Network,
  options: Pick<
    XahauFacilitatorOptions,
    "simulateSignedTransaction" | "wsUrlByNetwork" | "clientFactory"
  >,
): Promise<XahauSimulationResult> {
  if (options.simulateSignedTransaction) {
    return options.simulateSignedTransaction(signedTxBlob, network);
  }

  const decoded = decodeSignedTransactionBlob(signedTxBlob) as Transaction & {
    TxnSignature?: string;
    SigningPubKey?: string;
  };
  const { TxnSignature, SigningPubKey, Signers, ...unsignedTransaction } = decoded;
  void TxnSignature;
  void SigningPubKey;
  void Signers;

  const client = createXahauClient(network, options);
  try {
    await client.connect();
    const response = await client.simulate(unsignedTransaction as SubmittableTransaction);
    return {
      engineResult: response.result.engine_result,
      engineResultMessage: response.result.engine_result_message,
    };
  } finally {
    await client.disconnect();
  }
}

/**
 * Extracts the ticket sequences created by a validated TicketCreate.
 *
 * @param meta - Validated transaction metadata
 * @returns Ascending list of created ticket sequences
 */
function extractCreatedTicketSequences(meta: TransactionMetadata): number[] {
  const ticketSequences: number[] = [];
  for (const affectedNode of meta.AffectedNodes) {
    if (!("CreatedNode" in affectedNode)) {
      continue;
    }
    if (affectedNode.CreatedNode.LedgerEntryType !== "Ticket") {
      continue;
    }
    const ticketSequence = affectedNode.CreatedNode.NewFields.TicketSequence;
    if (typeof ticketSequence === "number") {
      ticketSequences.push(ticketSequence);
    }
  }
  return ticketSequences.sort((left, right) => left - right);
}

/**
 * Normalizes a decimal string for exact decimal comparison.
 *
 * @param value - Decimal string
 * @returns Normalized decimal parts
 */
function normalizeDecimalString(value: string): { whole: string; fraction: string } {
  if (!isDecimalString(value)) {
    throw new Error(`Invalid decimal string: ${value}`);
  }
  const [rawWhole, rawFraction = ""] = value.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "") || "0";
  const fraction = rawFraction.replace(/0+$/, "");
  return { whole, fraction };
}
