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
} from "xrpl";
import {
  DEFAULT_LEDGER_CLOSE_SECONDS,
  DEFAULT_LEDGER_TOLERANCE,
  LSF_DISABLE_MASTER,
  MAX_ACCOUNT_TICKETS,
  MAX_DESTINATION_TAG,
  XRPL_DEVNET,
  XRPL_DEVNET_WS_URL,
  XRPL_MAINNET,
  XRPL_MAINNET_WS_URL,
  XRPL_TESTNET,
  XRPL_TESTNET_WS_URL,
} from "./constants";
import type {
  ClientXrplSigner,
  ExactXrplPayload,
  XrplAccountAuthorization,
  XrplAssetTransferMethod,
  XrplClientFactory,
  XrplFacilitatorOptions,
  XrplNetwork,
  XrplSettlementResult,
  XrplSimulationResult,
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
 * Checks whether a network id is an XRPL CAIP-2 id.
 *
 * @param network - Network id to inspect
 * @returns Whether the network id is XRPL
 */
export function isXrplNetwork(network: Network): network is XrplNetwork {
  return /^xrpl:\d+$/.test(network);
}

/**
 * Parses an XRPL CAIP-2 network id into its numeric NetworkID.
 *
 * @param network - XRPL network id
 * @returns Numeric XRPL NetworkID
 */
export function parseXrplNetworkId(network: Network): number {
  if (!isXrplNetwork(network)) {
    throw new Error(`Invalid XRPL network: ${network}`);
  }

  const value = Number(network.slice("xrpl:".length));
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Invalid XRPL network id: ${network}`);
  }

  return value;
}

/**
 * Checks whether a value is a supported XRPL asset transfer method.
 *
 * @param value - Value to inspect
 * @returns Whether the value is "sequence" or "ticketSequence"
 */
export function isXrplAssetTransferMethod(value: unknown): value is XrplAssetTransferMethod {
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
): { method: XrplAssetTransferMethod } | { error: string } {
  const requiredMethod = requirements.extra?.assetTransferMethod;
  const acceptedMethod = payload.accepted.extra?.assetTransferMethod;
  if (requiredMethod !== undefined && !isXrplAssetTransferMethod(requiredMethod)) {
    return { error: "invalid_exact_xrpl_asset_transfer_method" };
  }
  if (acceptedMethod !== undefined && !isXrplAssetTransferMethod(acceptedMethod)) {
    return { error: "invalid_exact_xrpl_asset_transfer_method" };
  }

  const selectedMethod: XrplAssetTransferMethod = isXrplAssetTransferMethod(acceptedMethod)
    ? acceptedMethod
    : isXrplAssetTransferMethod(requiredMethod)
      ? requiredMethod
      : "sequence";
  if (requiredMethod !== undefined && selectedMethod !== requiredMethod) {
    return { error: "invalid_exact_xrpl_asset_transfer_method_mismatch" };
  }
  return { method: selectedMethod };
}

/**
 * Resolves an XRPL WebSocket URL for a network.
 *
 * @param network - XRPL network id
 * @param options - Facilitator options
 * @returns WebSocket URL
 */
export function resolveXrplWsUrl(
  network: Network,
  options: Pick<XrplFacilitatorOptions, "wsUrlByNetwork"> = {},
): string {
  const xrplNetwork = network as XrplNetwork;
  if (options.wsUrlByNetwork?.[xrplNetwork]) {
    return options.wsUrlByNetwork[xrplNetwork]!;
  }

  if (network === XRPL_MAINNET) return XRPL_MAINNET_WS_URL;
  if (network === XRPL_TESTNET) return XRPL_TESTNET_WS_URL;
  if (network === XRPL_DEVNET) return XRPL_DEVNET_WS_URL;

  throw new Error(`No XRPL WebSocket URL configured for ${network}`);
}

/**
 * Converts an invoice id to the XRPL InvoiceID field value.
 *
 * @param invoiceId - Invoice id
 * @returns Uppercase SHA-256 hex digest
 */
export function invoiceIdToInvoiceIdField(invoiceId: string): string {
  return createHash("sha256").update(invoiceId, "utf8").digest("hex").toUpperCase();
}

/**
 * Decodes a signed XRPL transaction blob.
 *
 * @param signedTxBlob - Hex-encoded signed transaction blob
 * @returns Decoded transaction
 */
export function decodeSignedTransactionBlob(signedTxBlob: string): Transaction {
  if (!/^[A-Fa-f0-9]+$/.test(signedTxBlob)) {
    throw new Error("signedTxBlob must be hex");
  }
  return decode(signedTxBlob) as Transaction;
}

/**
 * Extracts the exact XRPL payload from a payment payload.
 *
 * @param payload - x402 payment payload
 * @returns XRPL exact payload
 */
export function getExactXrplPayload(payload: PaymentPayload): ExactXrplPayload {
  if (!isRecord(payload.payload) || typeof payload.payload.signedTxBlob !== "string") {
    throw new Error("XRPL exact payload requires signedTxBlob");
  }
  return payload.payload as ExactXrplPayload;
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
 * Checks whether a value is a non-negative decimal string usable as an XRPL
 * issued-currency value.
 *
 * @param value - Value to inspect
 * @returns Whether the value is a decimal string
 */
export function isDecimalString(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

/**
 * Checks whether a value is a valid XRPL destination tag.
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
 * Validates and returns a classic XRPL address.
 *
 * @param address - Address to validate
 * @param fieldName - Field name for error messages
 * @returns The same address
 */
export function requireClassicAddress(address: unknown, fieldName: string): string {
  if (typeof address !== "string" || !isValidClassicAddress(address)) {
    throw new Error(`${fieldName} must be a valid XRPL classic address`);
  }
  return address;
}

/**
 * Returns true for XRPL issued currency amount objects.
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
 * @returns XRPL transaction hash
 */
export function getSignedTransactionHash(signedTxBlob: string): string {
  return hashes.hashSignedTx(signedTxBlob);
}

/**
 * Creates an XRPL SDK client.
 *
 * @param network - XRPL network id
 * @param options - Facilitator options
 * @returns XRPL client
 */
export function createXrplClient(
  network: Network,
  options: Pick<XrplFacilitatorOptions, "wsUrlByNetwork" | "clientFactory"> = {},
): Client {
  const wsUrl = resolveXrplWsUrl(network, options);
  const factory: XrplClientFactory = options.clientFactory ?? (url => new Client(url));
  return factory(wsUrl);
}

/**
 * Gets the current validated ledger index.
 *
 * @param network - XRPL network id
 * @param options - Facilitator options
 * @returns Current ledger index
 */
export async function getCurrentLedgerIndex(
  network: Network,
  options: Pick<
    XrplFacilitatorOptions,
    "getCurrentLedgerIndex" | "wsUrlByNetwork" | "clientFactory"
  >,
): Promise<number> {
  if (options.getCurrentLedgerIndex) {
    return options.getCurrentLedgerIndex(network);
  }

  const client = createXrplClient(network, options);
  try {
    await client.connect();
    return await client.getLedgerIndex();
  } finally {
    await client.disconnect();
  }
}

/**
 * Gets the current on-network sequence for an XRPL account.
 *
 * @param account - XRPL classic address
 * @param network - XRPL network id
 * @param options - Facilitator options
 * @returns Current account sequence
 */
export async function getXrplAccountSequence(
  account: string,
  network: Network,
  options: Pick<XrplFacilitatorOptions, "getAccountSequence" | "wsUrlByNetwork" | "clientFactory">,
): Promise<number> {
  if (options.getAccountSequence) {
    return options.getAccountSequence(account, network);
  }

  const client = createXrplClient(network, options);
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
 * Gets the signing authorization state for an XRPL account.
 *
 * Reads the account's configured regular key and master-key status from the
 * validated ledger so verification can bind the payload's `SigningPubKey` to
 * a key pair that is currently authorized to sign for `Account`.
 *
 * @param account - XRPL classic address
 * @param network - XRPL network id
 * @param options - Facilitator options
 * @returns Regular key and master-key status for the account
 */
export async function getXrplAccountAuthorization(
  account: string,
  network: Network,
  options: Pick<
    XrplFacilitatorOptions,
    "getAccountAuthorization" | "wsUrlByNetwork" | "clientFactory"
  >,
): Promise<XrplAccountAuthorization> {
  if (options.getAccountAuthorization) {
    return options.getAccountAuthorization(account, network);
  }

  const client = createXrplClient(network, options);
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
 * Lists the available ticket sequences for an XRPL account.
 *
 * @param account - XRPL classic address
 * @param network - XRPL network id
 * @param options - Client or facilitator connection options
 * @returns Ascending list of available ticket sequences
 */
export async function getXrplTicketSequences(
  account: string,
  network: Network,
  options: Pick<XrplFacilitatorOptions, "wsUrlByNetwork" | "clientFactory"> = {},
): Promise<number[]> {
  const client = createXrplClient(network, options);
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
 * Checks whether a ticket sequence is available for an XRPL account.
 *
 * @param account - XRPL classic address
 * @param ticketSequence - Ticket sequence the signed transaction consumes
 * @param network - XRPL network id
 * @param options - Facilitator options
 * @returns Whether the ticket is available
 */
export async function isXrplTicketAvailable(
  account: string,
  ticketSequence: number,
  network: Network,
  options: Pick<XrplFacilitatorOptions, "isTicketAvailable" | "wsUrlByNetwork" | "clientFactory">,
): Promise<boolean> {
  if (options.isTicketAvailable) {
    return options.isTicketAvailable(account, ticketSequence, network);
  }

  const ticketSequences = await getXrplTicketSequences(account, network, options);
  return ticketSequences.includes(ticketSequence);
}

/**
 * Creates XRPL tickets for ticketSequence payments.
 *
 * Submits a `TicketCreate` transaction and waits for a validated result.
 * Each outstanding ticket locks owner reserve until it is used or deleted,
 * and an account can hold at most 250 outstanding tickets.
 *
 * @param signer - XRPL account that owns and signs the TicketCreate
 * @param network - XRPL network id
 * @param ticketCount - Number of tickets to create
 * @param options - Client connection options
 * @returns Ascending list of created ticket sequences
 */
export async function createTickets(
  signer: ClientXrplSigner,
  network: Network,
  ticketCount: number,
  options: Pick<XrplFacilitatorOptions, "wsUrlByNetwork" | "clientFactory"> = {},
): Promise<number[]> {
  if (!Number.isInteger(ticketCount) || ticketCount < 1 || ticketCount > MAX_ACCOUNT_TICKETS) {
    throw new Error(`ticketCount must be an integer between 1 and ${MAX_ACCOUNT_TICKETS}`);
  }

  const client = createXrplClient(network, options);
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
 * @param network - XRPL network id
 * @param options - Facilitator options
 * @returns Settlement result
 */
export async function submitSignedTransaction(
  signedTxBlob: string,
  network: Network,
  options: Pick<
    XrplFacilitatorOptions,
    "submitSignedTransaction" | "wsUrlByNetwork" | "clientFactory"
  >,
): Promise<XrplSettlementResult> {
  if (options.submitSignedTransaction) {
    return options.submitSignedTransaction(signedTxBlob, network);
  }

  const client = createXrplClient(network, options);
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
 * Simulates a signed XRPL transaction without submitting it.
 *
 * The XRPL simulate API only accepts unsigned transactions, so the signature
 * fields are stripped from the decoded transaction before simulation.
 *
 * @param signedTxBlob - Hex-encoded signed transaction blob
 * @param network - XRPL network id
 * @param options - Facilitator options
 * @returns XRPL simulation result
 */
export async function simulateSignedTransaction(
  signedTxBlob: string,
  network: Network,
  options: Pick<
    XrplFacilitatorOptions,
    "simulateSignedTransaction" | "wsUrlByNetwork" | "clientFactory"
  >,
): Promise<XrplSimulationResult> {
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

  const client = createXrplClient(network, options);
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
