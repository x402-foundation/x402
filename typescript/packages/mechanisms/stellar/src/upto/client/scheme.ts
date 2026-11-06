import { authorizeEntry, xdr } from "@stellar/stellar-sdk";
import { findDefaultAsset } from "../../defaultAssets";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
  type RpcConfig,
} from "../../utils";
import { DEFAULT_MAX_TIMEOUT_SECONDS, MAX_SIGNER_AUTHORIZATIONS, UPTO_SCHEME } from "../constants";
import {
  isAccountAddress,
  isAccountOrContract,
  isContractAddress,
  parseAtomicAmount,
  resolveUptoContract,
} from "../shared";
import { unsignedPayerEntry, type UptoTerms } from "../terms";
import type { ClientStellarSigner } from "../../signer";
import type { UptoStellarPayload } from "../types";
import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";

/**
 * Signs the payer's entry; required for contract-account (`C…`) payers, whose signature format
 * their own `__check_auth` defines. It may add entries of the account's delegated signers.
 */
export type UptoAuthorizeEntry = (
  entry: xdr.SorobanAuthorizationEntry,
  context: { readonly networkPassphrase: string; readonly expirationLedger: number },
) => Promise<{
  readonly authorization: xdr.SorobanAuthorizationEntry;
  readonly signerAuthorizations?: readonly xdr.SorobanAuthorizationEntry[];
}>;

export interface UptoStellarClientOptions {
  readonly rpcConfig?: RpcConfig;
  /** Settlement contracts by network, for networks without a canonical deployment. */
  readonly contracts?: Readonly<Record<string, string>>;
  /** Largest `maxTimeoutSeconds` the client signs for (default 300). */
  readonly maxTimeoutSeconds?: number;
  readonly authorizeEntry?: UptoAuthorizeEntry;
}

/**
 * Stellar client for the x402 `upto` scheme: signs one Soroban authorization entry over the terms
 * (recipient, token, maximum, expiration and settlement authority), never over the final amount.
 */
export class UptoStellarScheme implements SchemeNetworkClient {
  readonly scheme = UPTO_SCHEME;
  readonly findDefaultAsset = findDefaultAsset;

  /**
   * Creates the client for one payer.
   *
   * @param signer - The payer; its `signAuthEntry` signs `G…` payers' entries
   * @param options - See {@link UptoStellarClientOptions}
   */
  constructor(
    private readonly signer: ClientStellarSigner,
    private readonly options: UptoStellarClientOptions = {},
  ) {}

  /**
   * Creates the payload `{ authorization, signerAuthorizations? }`.
   *
   * @param x402Version - The x402 protocol version
   * @param requirements - The payment requirements; `amount` is the maximum
   * @param context - Core payment context with an optional spend limit
   * @returns The payload
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const { network, maxTimeoutSeconds } = requirements;
    const { maxAmount, facilitator } = this.validate(requirements, context);
    const contract = resolveUptoContract(network, this.options.contracts);
    if (contract === undefined) throw new Error(`no upto settlement contract on ${network}`);

    const [latest, ledgerSeconds] = await Promise.all([
      getRpcClient(network, this.options.rpcConfig).getLatestLedger(),
      getEstimatedLedgerCloseTimeSeconds(network),
    ]);
    const terms: UptoTerms = {
      expirationLedger: latest.sequence + Math.ceil(maxTimeoutSeconds / ledgerSeconds),
      facilitator,
      maxAmount,
      recipient: requirements.payTo,
      token: requirements.asset,
      validAfterLedger: 0,
    };
    const [nonce = 0n] = globalThis.crypto.getRandomValues(new BigInt64Array(1));
    const entry = unsignedPayerEntry({ contract, payer: this.signer.address, terms, nonce });
    const networkPassphrase = getNetworkPassphrase(network);
    const expirationLedger = terms.expirationLedger;

    let signed: Awaited<ReturnType<UptoAuthorizeEntry>>;
    if (this.options.authorizeEntry !== undefined) {
      signed = await this.options.authorizeEntry(entry, { networkPassphrase, expirationLedger });
    } else if (isContractAddress(this.signer.address)) {
      throw new Error("a contract-account payer needs an authorizeEntry signer");
    } else {
      const authorization = await authorizeEntry(
        entry,
        async preimage => {
          const { signedAuthEntry, error } = await this.signer.signAuthEntry(
            preimage.toXDR("base64"),
            { networkPassphrase, address: this.signer.address },
          );
          if (error !== undefined) throw new Error(`the wallet refused to sign: ${error.message}`);
          return {
            signature: Buffer.from(signedAuthEntry, "base64"),
            publicKey: this.signer.address,
          };
        },
        expirationLedger,
        networkPassphrase,
      );
      signed = { authorization };
    }

    const signerAuthorizations = (signed.signerAuthorizations ?? []).map(e => e.toXDR("base64"));
    if (signerAuthorizations.length > MAX_SIGNER_AUTHORIZATIONS) {
      throw new Error(`at most ${MAX_SIGNER_AUTHORIZATIONS} signer authorizations are allowed`);
    }
    const payload = {
      authorization: signed.authorization.toXDR("base64"),
      ...(signerAuthorizations.length > 0 ? { signerAuthorizations } : {}),
    } satisfies UptoStellarPayload;
    return { x402Version, payload };
  }

  /**
   * Refuses requirements this client cannot pay safely.
   *
   * @param requirements - The payment requirements
   * @param context - Core payment context with an optional spend limit
   * @returns The maximum and the settlement authority
   */
  private validate(
    requirements: PaymentRequirements,
    context: PaymentPayloadContext | undefined,
  ): { maxAmount: bigint; facilitator: string } {
    const { scheme, network, payTo, asset, amount, maxTimeoutSeconds } = requirements;
    const extra: Record<string, unknown> = requirements.extra ?? {};
    const facilitator = extra["facilitatorAddress"];
    const maxAmount = parseAtomicAmount(amount);
    const longest = this.options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
    if (scheme !== UPTO_SCHEME) throw new Error(`unsupported scheme: ${scheme}`);
    if (!isStellarNetwork(network)) throw new Error(`unsupported network: ${network}`);
    if (maxAmount === undefined || maxAmount === 0n) throw new Error(`invalid amount: ${amount}`);
    if (!isContractAddress(asset)) throw new Error(`invalid asset: ${asset}`);
    if (!isAccountOrContract(payTo)) throw new Error(`invalid payTo: ${payTo}`);
    if (
      !Number.isInteger(maxTimeoutSeconds) ||
      maxTimeoutSeconds <= 0 ||
      maxTimeoutSeconds > longest
    ) {
      throw new Error(`maxTimeoutSeconds must be from 1 to ${longest}`);
    }
    if (extra["areFeesSponsored"] !== true) throw new Error("extra.areFeesSponsored must be true");
    // The settlement authority is the settle operation's source, which only a G… account can be.
    if (!isAccountAddress(facilitator)) {
      throw new Error("extra.facilitatorAddress must be a G… settlement authority");
    }
    if (facilitator === this.signer.address || payTo === this.signer.address) {
      throw new Error("the payer cannot be the settlement authority or payTo");
    }
    const spendLimit = parseAtomicAmount(context?.maxAmountPerPayment);
    if (spendLimit !== undefined && maxAmount > spendLimit) {
      throw new Error(`the maximum ${maxAmount} exceeds the spend limit ${spendLimit}`);
    }
    return { maxAmount, facilitator };
  }
}
