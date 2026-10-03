import type { Client, Payment, SubmittableTransaction } from "xahau";
import type { Network, PaymentRequirements } from "@x402/core/types";

/**
 * Xahau CAIP-2 network identifier.
 */
export type XahauNetwork = `xahau:${number}`;

/**
 * Asset transfer methods supported by the Xahau exact scheme.
 *
 * - `sequence`: the signed transaction consumes the payer account's current
 *   `Sequence`, so each account has at most one pending payment.
 * - `ticketSequence`: the signed transaction consumes a pre-created Xahau
 *   Ticket (`Sequence = 0` plus `TicketSequence`), allowing multiple
 *   concurrent pending payments per account.
 */
export type XahauAssetTransferMethod = "sequence" | "ticketSequence";

/**
 * Xahau exact scheme payload.
 */
export type ExactXahauPayload = {
  /**
   * Hex-encoded signed Xahau transaction blob.
   */
  signedTxBlob: string;
};

/**
 * Extra payment requirements for Xahau exact payments.
 */
export type XahauPaymentRequirementsExtra = {
  /**
   * Always false: the payer pays the Xahau transaction fee embedded in the
   * signed transaction, so facilitator fee sponsorship is not supported.
   */
  areFeesSponsored: boolean;
  /**
   * Selects how the signed transaction is sequenced. Defaults to "sequence".
   */
  assetTransferMethod?: XahauAssetTransferMethod;
  /**
   * Unique invoice id committed into the signed transaction.
   */
  invoiceId?: string;
  /**
   * Optional destination tag required by the receiver.
   */
  destinationTag?: number;
  /**
   * Required IOU issuer address for issued-currency payments.
   */
  issuer?: string;
};

/**
 * Client signer abstraction for Xahau transactions.
 */
export type ClientXahauSigner = {
  /**
   * Xahau classic address that signs and pays the transaction fee.
   */
  classicAddress: string;
  /**
   * Sign a Xahau transaction without submitting it.
   */
  sign(
    transaction: SubmittableTransaction,
  ): Promise<{ signedTxBlob: string; hash?: string }> | { signedTxBlob: string; hash?: string };
};

/**
 * Options for Xahau exact client payment creation.
 */
export type XahauClientOptions = {
  /**
   * Optional fee to place on locally-built transactions, in drops.
   */
  feeDrops?: string;
  /**
   * Optional function used to fetch current validated ledger index.
   */
  getCurrentLedgerIndex?: (network: Network) => Promise<number>;
  /**
   * Optional function returning an available ticket sequence for
   * ticketSequence payments. Defaults to reading the account's validated
   * ticket objects from the ledger.
   */
  getAvailableTicketSequence?: (account: string, network: Network) => Promise<number | undefined>;
  /**
   * Number of tickets to create when a ticketSequence payment finds none.
   * Defaults to 1. Set to 0 to disable automatic ticket creation.
   */
  ticketCreateCount?: number;
  /**
   * Optional function to prepare/autofill the transaction before signing.
   */
  preparePaymentTransaction?: (
    transaction: Payment,
    requirements: PaymentRequirements,
  ) => Promise<Payment>;
  /**
   * Optional WebSocket endpoint map by x402 network id.
   */
  wsUrlByNetwork?: Partial<Record<XahauNetwork, string>>;
  /**
   * Optional Xahau client factory.
   */
  clientFactory?: XahauClientFactory;
};

/**
 * Result of submitting a signed Xahau transaction.
 */
export type XahauSettlementResult = {
  /**
   * Xahau transaction hash.
   */
  hash: string;
  /**
   * Whether the returned result is validated.
   */
  validated: boolean;
  /**
   * Xahau transaction result code.
   */
  resultCode: string;
};

/**
 * Result of simulating a signed Xahau transaction.
 */
export type XahauSimulationResult = {
  /**
   * Xahau engine result code returned by simulate.
   */
  engineResult: string;
  /**
   * Human-readable engine result message.
   */
  engineResultMessage?: string;
};

/**
 * Signing authorization state for a Xahau account.
 */
export type XahauAccountAuthorization = {
  /**
   * Classic address of the account's configured regular key, if one is set.
   */
  regularKey?: string;
  /**
   * Whether the account's master key pair is disabled (lsfDisableMaster).
   */
  isMasterKeyDisabled: boolean;
};

/**
 * Factory for creating Xahau SDK clients.
 */
export type XahauClientFactory = (wsUrl: string) => Client;

/**
 * Options for Xahau facilitator verification and settlement.
 */
export type XahauFacilitatorOptions = {
  /**
   * Maximum accepted fee in drops.
   */
  maxFeeDrops?: string;
  /**
   * Optional function used to fetch current validated ledger index.
   */
  getCurrentLedgerIndex?: (network: Network) => Promise<number>;
  /**
   * Optional function used to fetch the account's current on-network
   * sequence. Defaults to a validated account_info lookup.
   */
  getAccountSequence?: (account: string, network: Network) => Promise<number>;
  /**
   * Optional function used to fetch the account's signing authorization
   * (regular key and master-key status). Defaults to a validated
   * account_info lookup.
   */
  getAccountAuthorization?: (
    account: string,
    network: Network,
  ) => Promise<XahauAccountAuthorization>;
  /**
   * Optional function used to check ticket availability for an account.
   * Defaults to a validated account_objects lookup.
   */
  isTicketAvailable?: (
    account: string,
    ticketSequence: number,
    network: Network,
  ) => Promise<boolean>;
  /**
   * Optional custom submission function for tests or custom infrastructure.
   */
  submitSignedTransaction?: (
    signedTxBlob: string,
    network: Network,
  ) => Promise<XahauSettlementResult>;
  /**
   * Optional custom simulation function for tests or custom infrastructure.
   */
  simulateSignedTransaction?: (
    signedTxBlob: string,
    network: Network,
  ) => Promise<XahauSimulationResult>;
  /**
   * Optional WebSocket endpoint map by x402 network id.
   */
  wsUrlByNetwork?: Partial<Record<XahauNetwork, string>>;
  /**
   * Optional Xahau client factory.
   */
  clientFactory?: XahauClientFactory;
};
