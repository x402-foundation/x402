import { createHash } from "crypto";
import {
  Client,
  decode,
  hashes,
  isValidClassicAddress,
  type Payment,
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
  const parsedLeft = parseUnsignedDecimal(left);
  const parsedRight = parseUnsignedDecimal(right);
  return compareParsedDecimals(parsedLeft, parsedRight);
}

/**
 * Checks issued-currency metadata equality within one XRPL precision unit.
 *
 * XRPL issued currencies use 15 decimal digits of precision and successful
 * non-partial payments can report a delivered amount one least-significant
 * precision unit away from the requested amount because of ledger rounding.
 *
 * @param delivered - Metadata delivered amount value
 * @param required - Negotiated destination value
 * @returns Whether the values are XRPL-precision equivalent
 */
export function areXrplTokenAmountsEquivalent(delivered: string, required: string): boolean {
  if (!isValidXrplTokenValue(delivered, true) || !isValidXrplTokenValue(required, true)) {
    return false;
  }
  let parsedDelivered: ParsedDecimal;
  let parsedRequired: ParsedDecimal;
  try {
    parsedDelivered = parseUnsignedDecimal(delivered);
    parsedRequired = parseUnsignedDecimal(required);
  } catch {
    return false;
  }
  if (compareParsedDecimals(parsedDelivered, parsedRequired) === 0) return true;
  if (parsedRequired.coefficient === 0n || parsedDelivered.coefficient === 0n) return false;

  const requiredMagnitude =
    parsedRequired.coefficient.toString().length - 1 + parsedRequired.exponent;
  const toleranceExponent = requiredMagnitude - 14;
  const commonExponent = Math.min(
    parsedDelivered.exponent,
    parsedRequired.exponent,
    toleranceExponent,
  );
  const deliveredInteger =
    parsedDelivered.coefficient * powerOfTen(parsedDelivered.exponent - commonExponent);
  const requiredInteger =
    parsedRequired.coefficient * powerOfTen(parsedRequired.exponent - commonExponent);
  const difference =
    deliveredInteger >= requiredInteger
      ? deliveredInteger - requiredInteger
      : requiredInteger - deliveredInteger;
  const tolerance = powerOfTen(toleranceExponent - commonExponent);
  return difference <= tolerance;
}

/**
 * Checks whether an XRPL amount is positive and valid for a cross-currency source cap.
 *
 * @param amount - Source amount to validate
 * @returns Whether the amount is positive XRP or an issued-currency amount
 */
export function isPositiveXrplAmount(amount: unknown): amount is NonNullable<Payment["SendMax"]> {
  if (typeof amount === "string") {
    return /^\d+$/.test(amount) && BigInt(amount) > 0n;
  }
  return (
    isIssuedCurrencyAmount(amount) &&
    isValidClassicAddress(amount.issuer) &&
    isValidXrplTokenValue(amount.value, false)
  );
}

/**
 * Checks that a positive source cap uses a different asset or issue from the destination.
 *
 * @param sourceAmount - Signed SendMax source cap
 * @param destinationAmount - Exact destination Amount or DeliverMax
 * @returns Whether the payment exchanges a different source asset or issue
 */
export function isDifferentXrplSourceAsset(
  sourceAmount: unknown,
  destinationAmount: unknown,
): boolean {
  if (!isPositiveXrplAmount(sourceAmount)) return false;
  if (typeof destinationAmount === "string") {
    return isIssuedCurrencyAmount(sourceAmount);
  }
  if (!isIssuedCurrencyAmount(destinationAmount)) return false;
  if (typeof sourceAmount === "string") return true;
  if (!isIssuedCurrencyAmount(sourceAmount)) return false;
  return (
    sourceAmount.currency !== destinationAmount.currency ||
    sourceAmount.issuer !== destinationAmount.issuer
  );
}

/**
 * Checks that an explicit XRPL path set contains at least one non-empty path.
 *
 * @param paths - Signed Payment Paths field
 * @returns Whether the path set is non-empty and usable
 */
export function isNonEmptyXrplPathSet(paths: Payment["Paths"]): boolean {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.some(path => Array.isArray(path) && path.length > 0)
  );
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
    const deliveredAmount =
      typeof response.result.meta === "object" && response.result.meta !== null
        ? response.result.meta.delivered_amount
        : undefined;
    return {
      hash: response.result.hash ?? getSignedTransactionHash(signedTxBlob),
      validated: response.result.validated === true,
      resultCode,
      deliveredAmount,
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
    const deliveredAmount =
      typeof response.result.meta === "object" && response.result.meta !== null
        ? response.result.meta.delivered_amount
        : undefined;
    return {
      engineResult: response.result.engine_result,
      engineResultMessage: response.result.engine_result_message,
      deliveredAmount,
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
 * Parsed arbitrary-precision decimal representation.
 *
 * The represented value is `coefficient * 10^exponent`.
 */
type ParsedDecimal = {
  coefficient: bigint;
  exponent: number;
};

/**
 * Parses a non-negative decimal or scientific-notation value without using
 * binary floating point.
 *
 * @param value - Decimal string
 * @returns Integer coefficient and base-10 exponent
 */
function parseUnsignedDecimal(value: string): ParsedDecimal {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error(`Invalid decimal string: ${value}`);
  const explicitExponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(explicitExponent) || Math.abs(explicitExponent) > 1_000) {
    throw new Error(`Invalid decimal exponent: ${value}`);
  }
  const fraction = match[2] ?? "";
  const rawDigits = `${match[1]}${fraction}`.replace(/^0+/, "");
  if (rawDigits === "") return { coefficient: 0n, exponent: 0 };

  let coefficientDigits = rawDigits;
  let exponent = explicitExponent - fraction.length;
  while (coefficientDigits.endsWith("0")) {
    coefficientDigits = coefficientDigits.slice(0, -1);
    exponent += 1;
  }
  return { coefficient: BigInt(coefficientDigits), exponent };
}

/**
 * Validates the XRPL issued-currency numeric range and precision.
 *
 * @param value - Issued-currency value
 * @param allowZero - Whether zero is valid
 * @returns Whether the value can be represented by XRPL issued currency
 */
function isValidXrplTokenValue(value: string, allowZero: boolean): boolean {
  try {
    const parsed = parseUnsignedDecimal(value);
    if (parsed.coefficient === 0n) return allowZero;
    const coefficientDigits = parsed.coefficient.toString().length;
    const magnitude = coefficientDigits - 1 + parsed.exponent;
    return coefficientDigits <= 16 && magnitude >= -81 && magnitude <= 95;
  } catch {
    return false;
  }
}

/**
 * Compares parsed non-negative decimal values.
 *
 * @param left - Left parsed decimal
 * @param right - Right parsed decimal
 * @returns -1, 0, or 1
 */
function compareParsedDecimals(left: ParsedDecimal, right: ParsedDecimal): number {
  if (left.coefficient === 0n || right.coefficient === 0n) {
    if (left.coefficient === right.coefficient) return 0;
    return left.coefficient === 0n ? -1 : 1;
  }
  const leftMagnitude = left.coefficient.toString().length + left.exponent;
  const rightMagnitude = right.coefficient.toString().length + right.exponent;
  if (leftMagnitude !== rightMagnitude) return leftMagnitude > rightMagnitude ? 1 : -1;

  const commonExponent = Math.min(left.exponent, right.exponent);
  const leftInteger = left.coefficient * powerOfTen(left.exponent - commonExponent);
  const rightInteger = right.coefficient * powerOfTen(right.exponent - commonExponent);
  if (leftInteger === rightInteger) return 0;
  return leftInteger > rightInteger ? 1 : -1;
}

/**
 * Computes a bounded non-negative power of ten as bigint.
 *
 * @param exponent - Non-negative exponent
 * @returns 10 raised to exponent
 */
function powerOfTen(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 2_000) {
    throw new Error(`Invalid decimal scaling exponent: ${exponent}`);
  }
  return 10n ** BigInt(exponent);
}
