import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { Address, beginCell, external, internal, storeMessage, type Cell } from "@ton/core";
import { ClientTvmSigner } from "../../signer";
import { findDefaultAsset } from "../../defaultAssets";
import { TvmPaymentPayload } from "../../types";
import {
  DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
  DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
  DEFAULT_TONCENTER_TIMEOUT_SECONDS,
  DEFAULT_TVM_EMULATION_ADDRESS,
  DEFAULT_TVM_EMULATION_RELAY_AMOUNT,
  DEFAULT_TVM_EMULATION_SEQNO,
  DEFAULT_TVM_EMULATION_WALLET_ID,
  DEFAULT_TVM_INNER_GAS_BUFFER,
  DEFAULT_VALID_UNTIL_OFFSET,
  NATIVE_ASSET,
  SEND_MODE_IGNORE_ERRORS,
  SEND_MODE_PAY_FEES_SEPARATELY,
  SUPPORTED_NETWORKS,
  TVM_PROVIDER_TONCENTER,
  W5_EXTERNAL_SIGNED_OPCODE,
  W5_INTERNAL_SIGNED_OPCODE,
} from "../../constants";
import { isNativeAsset, normalizeAsset } from "../../codecs/common";
import { buildJettonTransferBodyFields } from "../../codecs/jetton";
import { hasJettonOnlyExtra, nativeTransferBody } from "../../codecs/native";
import { buildW5SignedBody, getW5Seqno } from "../../codecs/w5";
import { createTvmProviderClient, type TvmProviderClient } from "../../provider";
import {
  parseTraceTransactions,
  traceTransactionComputeFees,
  traceTransactionFwdFees,
  traceTransactionStorageFees,
  transactionSucceeded,
  type TvmTraceTransaction,
} from "../../trace-utils";
import { normalizeTonAddress } from "../../utils";

/**
 * Configuration for TVM client scheme.
 */
export interface ExactTvmClientConfig {
  /** Deprecated Toncenter JSON-RPC URL. Prefer providerBaseUrl. */
  rpcUrl?: string;
  /** Optional API key for the selected provider. */
  apiKey?: string;
  /** Provider selector. Defaults to Toncenter. */
  provider?: string;
  /** Optional provider REST base URL. */
  providerBaseUrl?: string;
  /** Provider request timeout in seconds. */
  providerTimeoutSeconds?: number;
  /** Provider trace emulation timeout in seconds. */
  providerEmulationTimeoutSeconds?: number;
}

/**
 * TVM client implementation for the Exact payment scheme.
 *
 * Resolves signing data and estimates the relay-required inner TON amount
 * through the configured TVM provider before locally signing a W5R1 settlement.
 */
export class ExactTvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  findDefaultAsset = findDefaultAsset;
  private readonly clients = new Map<string, TvmProviderClient>();

  constructor(
    private readonly signer: ClientTvmSigner,
    private readonly options: ExactTvmClientConfig = {},
  ) {}

  close(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const network = String(paymentRequirements.network);
    if (!SUPPORTED_NETWORKS.has(network)) {
      throw new Error(`Unsupported TVM network: ${network}`);
    }
    if (this.signer.network !== network) {
      throw new Error(
        `Signer network ${this.signer.network} does not match requirements network ${network}`,
      );
    }
    if (paymentRequirements.extra?.areFeesSponsored !== true) {
      throw new Error("Exact TVM scheme requires extra.areFeesSponsored to be true");
    }

    const client = this.client(network);
    const asset = normalizeAsset(paymentRequirements.asset);
    const payer = normalizeTonAddress(this.signer.address);
    const timeoutSeconds = paymentRequirements.maxTimeoutSeconds ?? DEFAULT_VALID_UNTIL_OFFSET;
    const validUntil =
      Math.floor(Date.now() / 1000) +
      (timeoutSeconds > 10 ? timeoutSeconds - 5 : Math.ceil(timeoutSeconds / 2));

    if (isNativeAsset(asset)) {
      return this.createNativePaymentPayload(x402Version, paymentRequirements, payer, validUntil);
    }

    const sourceWallet = await client.getJettonWallet(asset, payer);

    const account = await client.getAccountState(payer);
    const includeStateInit = !account.isActive;
    const seqno = getW5Seqno(account);

    const transferBody = buildJettonTransferBodyFields({
      amount: BigInt(paymentRequirements.amount),
      payTo: paymentRequirements.payTo,
      extra: paymentRequirements.extra ?? {},
    });
    const requiredInner = await this.estimateRequiredInnerValue({
      client,
      sourceWallet,
      requirements: paymentRequirements,
      seqno,
      validUntil,
      transferBody,
      includeStateInit,
    });

    const settlementBoc = await this.signer.signTransfer(
      seqno,
      validUntil,
      [
        {
          address: sourceWallet,
          amount: requiredInner,
          body: transferBody,
        },
      ],
      { includeStateInit },
    );

    const tvmPayload: TvmPaymentPayload = {
      settlementBoc,
      asset,
    };

    return {
      x402Version,
      payload: tvmPayload as unknown as Record<string, unknown>,
    };
  }

  /**
   * Sign one native TON transfer of exactly `amount` to `payTo`.
   *
   * @param x402Version - Protocol version
   * @param requirements - Payment requirements with `asset: "native"`
   * @param payer - Payer wallet address (raw)
   * @param validUntil - W5 request expiry (unix seconds)
   * @returns The payment payload
   */
  private async createNativePaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    payer: string,
    validUntil: number,
  ): Promise<PaymentPayloadResult> {
    const extra = (requirements.extra ?? {}) as Record<string, unknown>;
    if (hasJettonOnlyExtra(extra)) {
      throw new Error(
        "Native TON payments must not set extra.forwardTonAmount or extra.responseDestination",
      );
    }
    const amount = BigInt(requirements.amount);
    if (amount <= 0n) {
      throw new Error("Native TON payment amount must be positive");
    }
    const account = await this.client(String(requirements.network)).getAccountState(payer);
    // The payment value must come from the wallet's own balance, not the relay's gas.
    if (account.balance < amount) {
      throw new Error(
        `Wallet balance ${account.balance} nanotons is below the payment amount ${amount}`,
      );
    }

    const settlementBoc = await this.signer.signTransfer(
      getW5Seqno(account),
      validUntil,
      [
        {
          address: normalizeTonAddress(requirements.payTo),
          amount,
          body: nativeTransferBody(extra),
        },
      ],
      { includeStateInit: !account.isActive },
    );
    const tvmPayload: TvmPaymentPayload = { settlementBoc, asset: NATIVE_ASSET };
    return { x402Version, payload: tvmPayload as unknown as Record<string, unknown> };
  }

  private client(network: string): TvmProviderClient {
    const cached = this.clients.get(network);
    if (cached) return cached;

    const provider = this.options.provider ?? this.signer.provider ?? TVM_PROVIDER_TONCENTER;
    const client = createTvmProviderClient(network, {
      provider,
      apiKey: this.options.apiKey ?? this.signer.apiKey,
      baseUrl:
        this.options.providerBaseUrl ??
        this.signer.providerBaseUrl ??
        toncenterBaseUrlFromRpcUrl(this.options.rpcUrl),
      timeout:
        this.options.providerTimeoutSeconds ??
        this.signer.providerTimeoutSeconds ??
        DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    });
    this.clients.set(network, client);
    return client;
  }

  private async estimateRequiredInnerValue({
    client,
    sourceWallet,
    requirements,
    seqno,
    validUntil,
    transferBody,
    includeStateInit,
  }: {
    client: TvmProviderClient;
    sourceWallet: string;
    requirements: PaymentRequirements;
    seqno: number;
    validUntil: number;
    transferBody: Cell;
    includeStateInit: boolean;
  }): Promise<bigint> {
    const forwardTonAmount = BigInt(String(requirements.extra?.forwardTonAmount ?? "0"));
    const provisionalValue = DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT + forwardTonAmount;
    const payerOutMessage = internal({
      to: Address.parseRaw(sourceWallet),
      value: provisionalValue,
      bounce: true,
      body: transferBody,
    });
    const payerBody = await buildW5SignedBody({
      outMessage: payerOutMessage,
      seqno,
      validUntil,
      signMessage: this.signer.signMessage,
      walletId: this.signer.walletId,
      opcode: W5_INTERNAL_SIGNED_OPCODE,
    });
    const relayMessage = internal({
      to: Address.parseRaw(this.signer.address),
      value: DEFAULT_TVM_EMULATION_RELAY_AMOUNT,
      bounce: true,
      init: includeStateInit ? this.signer.stateInit : undefined,
      body: payerBody,
    });
    const externalBody = await buildW5SignedBody({
      outMessage: relayMessage,
      seqno: DEFAULT_TVM_EMULATION_SEQNO,
      validUntil,
      signMessage: this.signer.signMessage,
      walletId: DEFAULT_TVM_EMULATION_WALLET_ID,
      opcode: W5_EXTERNAL_SIGNED_OPCODE,
      sendMode: SEND_MODE_PAY_FEES_SEPARATELY + SEND_MODE_IGNORE_ERRORS,
    });
    const externalMessage = external({
      to: Address.parseRaw(DEFAULT_TVM_EMULATION_ADDRESS),
      body: externalBody,
    });
    const trace = await client.emulateTrace(
      beginCell().store(storeMessage(externalMessage)).endCell().toBoc(),
      {
        ignoreChksig: true,
        timeout:
          this.options.providerEmulationTimeoutSeconds ??
          this.signer.providerEmulationTimeoutSeconds ??
          DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
      },
    );
    const transactions = parseTraceTransactions(trace);
    const sourceWalletTransaction = findSourceWalletTransaction(
      transactions,
      sourceWallet,
      this.signer.address,
    );
    const receiverWalletTransaction = findReceiverWalletTransaction(transactions, sourceWallet);

    return (
      DEFAULT_TVM_INNER_GAS_BUFFER +
      traceTransactionFwdFees(sourceWalletTransaction, {
        expectedCount: forwardTonAmount > 0n ? 2 : 1,
      }) +
      traceTransactionComputeFees(sourceWalletTransaction) +
      traceTransactionComputeFees(receiverWalletTransaction) +
      forwardTonAmount +
      traceTransactionStorageFees(sourceWalletTransaction)
    );
  }
}

function findSourceWalletTransaction(
  transactions: TvmTraceTransaction[],
  sourceWallet: string,
  payer: string,
): TvmTraceTransaction {
  const expectedSourceWallet = normalizeTonAddress(sourceWallet);
  const expectedPayer = normalizeTonAddress(payer);
  for (const transaction of transactions) {
    if (normalizeAddressOrNull(transaction.account) !== expectedSourceWallet) continue;
    if (!transactionSucceeded(transaction)) continue;
    const inMsg = asRecord(transaction.in_msg);
    if (inMsg.decoded_opcode !== "jetton_transfer") continue;
    if (normalizeAddressOrNull(inMsg.source) !== expectedPayer) continue;
    return transaction;
  }
  throw new Error("Trace does not contain the expected source jetton wallet transaction");
}

function findReceiverWalletTransaction(
  transactions: TvmTraceTransaction[],
  sourceWallet: string,
): TvmTraceTransaction {
  const expectedSourceWallet = normalizeTonAddress(sourceWallet);
  for (const transaction of transactions) {
    if (!transactionSucceeded(transaction)) continue;
    const inMsg = asRecord(transaction.in_msg);
    if (inMsg.decoded_opcode !== "jetton_internal_transfer") continue;
    if (normalizeAddressOrNull(inMsg.source) !== expectedSourceWallet) continue;
    return transaction;
  }
  throw new Error("Trace does not contain the expected destination jetton wallet transaction");
}

function toncenterBaseUrlFromRpcUrl(rpcUrl?: string): string | undefined {
  if (!rpcUrl) return undefined;
  return rpcUrl.replace(/\/api\/v2\/jsonRPC\/?$/, "");
}

function normalizeAddressOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeTonAddress(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
