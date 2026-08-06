import type { PaymentRequirements } from "@x402/core/types";
import type { NearAccessKeyView, NearAccountView, NearSettlementOutcome } from "./types";

/**
 * Input passed to the client-side signer for creating a signed delegate action.
 */
export type NearSignedDelegateInput = {
  x402Version: number;
  paymentRequirements: PaymentRequirements;
};

/**
 * Client signer abstraction for NEAR exact payments.
 *
 * Implementations own block-height and access-key-nonce reads, set
 * `max_block_height` per the deterministic timeout mapping (spec §5), build the
 * single `ft_transfer` delegate action, sign it (ed25519 or secp256k1), and
 * return the base64 Borsh `SignedDelegate`.
 */
export type ClientNearSigner = {
  /**
   * Create a base64-encoded Borsh `SignedDelegate` for the selected requirement.
   *
   * @param input - x402 version and the selected payment requirements
   * @returns base64 Borsh `SignedDelegate`
   */
  createSignedDelegateAction(input: NearSignedDelegateInput): Promise<string>;
};

/**
 * Result of a `storage_balance_of` query that distinguishes a token which does
 * not implement NEP-145 from one that does but has no registration for the
 * account (spec §9).
 */
export type NearStorageBalanceResult =
  | { supported: false }
  | { supported: true; registered: boolean };

/**
 * Facilitator signer abstraction for relayer-sponsored settlement.
 *
 * The relayer account is selected from this facilitator-local configuration and
 * is never read from the client-facing payment payload (spec §3). All view
 * methods MUST read against final finality (spec "Implementing Verification
 * with NEAR RPC") and MUST surface failures by throwing or returning `null`
 * so the scheme can fail closed.
 */
export type FacilitatorNearSigner = {
  /**
   * Relayer account IDs managed by this facilitator.
   */
  getRelayerIds(): readonly string[];

  /**
   * Current final block height, used for nonce upper-bound and expiry checks.
   */
  getCurrentBlockHeight(network: string): Promise<bigint>;

  /**
   * `view_account`. Resolves to `null` when the account does not exist.
   */
  viewAccount(input: { network: string; accountId: string }): Promise<NearAccountView | null>;

  /**
   * `view_access_key`. Resolves to `null` when the key does not exist for the
   * account.
   */
  viewAccessKey(input: {
    network: string;
    accountId: string;
    publicKey: string;
  }): Promise<NearAccessKeyView | null>;

  /**
   * `ft_balance_of` on the token contract. Returns the balance in atomic units.
   */
  ftBalanceOf(input: { network: string; token: string; accountId: string }): Promise<bigint>;

  /**
   * `storage_balance_of` on the token contract (NEP-145).
   */
  storageBalanceOf(input: {
    network: string;
    token: string;
    accountId: string;
  }): Promise<NearStorageBalanceResult>;

  /**
   * Wrap the signed delegate action in an outer relayer transaction, submit it,
   * and wait until the inner `ft_transfer` receipt has finished executing
   * (spec §7 / Settlement).
   */
  submitSignedDelegateAction(input: {
    network: string;
    relayerId: string;
    signedDelegateAction: string;
  }): Promise<NearSettlementOutcome>;
};
