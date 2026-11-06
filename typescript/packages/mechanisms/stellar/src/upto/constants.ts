import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2 } from "../constants";

export const UPTO_SCHEME = "upto";

/** The settlement contract's entry point and the event it emits once per settlement. */
export const SETTLE_FUNCTION = "settle";
export const SETTLED_EVENT = "upto_settled";

/** A deployed settlement contract. */
export interface UptoContractDeployment {
  readonly address: string;
  /** Hex sha256 of the installed WASM. */
  readonly wasmHash: string;
}

/** The testnet deployment of `contracts/stellar/upto` (`contracts/stellar/deployments/testnet.json`). */
export const UPTO_TESTNET_DEPLOYMENT: UptoContractDeployment = Object.freeze({
  address: "CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U",
  wasmHash: "cc2d2fefe77d1a470abe88be8563679a9d40f49c127683947784c0cb2d0ca797",
});

/** Canonical deployments by network. Pubnet is not deployed yet. */
export const UPTO_DEPLOYMENTS: Readonly<Record<string, UptoContractDeployment | undefined>> =
  Object.freeze({
    [STELLAR_TESTNET_CAIP2]: UPTO_TESTNET_DEPLOYMENT,
    [STELLAR_PUBNET_CAIP2]: undefined,
  });

/** `Error(Contract, #n)` raised by the settlement contract. */
export const UptoContractError = Object.freeze({
  InvalidMaxAmount: 1,
  NegativeAmount: 2,
  AmountExceedsMax: 3,
  NotYetValid: 4,
  Expired: 5,
  InvalidRecipient: 6,
} as const);

export const MAX_AUTHORIZATION_BASE64_LENGTH = 8 * 1024;
export const MAX_SIGNER_AUTHORIZATIONS = 4;

/** Target ledger close time; the upper bound on the expiration never assumes slower ledgers. */
export const NOMINAL_LEDGER_SECONDS = 5;
/** Ledgers of slack on the upper bound of the expiration ledger, as in `exact`. */
export const EXPIRATION_LEDGER_TOLERANCE = 2;
/** Ledgers that must remain before the expiration for a payment to be accepted. */
export const EXPIRATION_MARGIN_LEDGERS = 2;
/** Shortest `maxTimeoutSeconds` that can pass the margin: one ledger more than it (15 s). */
export const MIN_TIMEOUT_SECONDS = (EXPIRATION_MARGIN_LEDGERS + 1) * NOMINAL_LEDGER_SECONDS;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/**
 * Default ceiling on the settlement fee in stroops. It covers `G…` payers paying through a Stellar
 * Asset Contract (about 50,000), not every smart-account payer or first payment through a contract
 * token (see the spec, rule 11).
 */
export const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 500_000;
