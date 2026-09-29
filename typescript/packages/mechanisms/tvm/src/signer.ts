import {
  Address,
  beginCell,
  Cell,
  contractAddress,
  external,
  internal,
  storeMessage,
  storeMessageRelaxed,
  type StateInit,
} from "@ton/core";
import { keyPairFromSecretKey, keyPairFromSeed, sign, type KeyPair } from "@ton/crypto";
import { randomInt } from "crypto";
import {
  DEFAULT_HIGHLOAD_SUBWALLET_ID,
  DEFAULT_HIGHLOAD_TIMEOUT,
  DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
  DEFAULT_RELAY_AMOUNT,
  DEFAULT_SETTLEMENT_BATCH_MAX_SIZE,
  DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
  DEFAULT_TONCENTER_TIMEOUT_SECONDS,
  DEFAULT_W5R1_SUBWALLET_NUMBER,
  HIGHLOAD_V3_CODE_HASH,
  HIGHLOAD_V3_CODE_HEX,
  INTERNAL_SIGNED_OP,
  SEND_MODE_IGNORE_ERRORS,
  SEND_MODE_PAY_FEES_SEPARATELY,
  TVM_MAINNET,
  TVM_PROVIDER_TONCENTER,
  TVM_TESTNET,
} from "./constants";
import {
  loadHighloadQueryState,
  MAX_USABLE_QUERY_SEQNO,
  queryIdIsProcessed,
  seqnoToQueryId,
  serializeInternalTransfer,
} from "./codecs/highload-v3";
import { addressFromStateInit, buildW5R1StateInit, makeW5R1WalletId } from "./codecs/w5";
import { createTvmProviderClient, type TvmProviderClient } from "./provider";
import type { TvmAccountState, TvmJettonWalletData, TvmRelayRequest } from "./types";

export type ClientTvmSigner = {
  address: string;
  network: string;
  walletId: number;
  stateInit: StateInit;
  publicKey: string;
  apiKey?: string;
  provider?: string;
  providerBaseUrl?: string;
  providerTimeoutSeconds?: number;
  providerEmulationTimeoutSeconds?: number;
  signMessage: (message: Buffer) => Buffer | Promise<Buffer>;
  signTransfer: (
    seqno: number,
    validUntil: number,
    messages: { address: string; amount: bigint; body: Cell | null }[],
    options?: { includeStateInit?: boolean },
  ) => Promise<string>;
};

export interface ClientTvmSignerOptions {
  network?: string;
  subwalletNumber?: number;
  workchain?: number;
  apiKey?: string;
  provider?: string;
  providerBaseUrl?: string;
  providerTimeoutSeconds?: number;
  providerEmulationTimeoutSeconds?: number;
}

export interface FacilitatorTvmSigner {
  getAddresses(): string[];
  getAddressesForNetwork(network: string): string[];
  getAccountState(address: string, network: string): Promise<TvmAccountState>;
  getJettonWallet(asset: string, owner: string, network: string): Promise<string>;
  getJettonWalletData(address: string, network: string): Promise<TvmJettonWalletData>;
  buildRelayExternalBoc(
    network: string,
    relayRequest: TvmRelayRequest,
    options?: { forEmulation?: boolean },
  ): Promise<Buffer>;
  buildRelayExternalBocBatch(
    network: string,
    relayRequests: TvmRelayRequest[],
    options?: { forEmulation?: boolean },
  ): Promise<Buffer>;
  emulateExternalMessage(network: string, externalBoc: Buffer): Promise<Record<string, unknown>>;
  sendExternalMessage(network: string, externalBoc: Buffer): Promise<string>;
  waitForTraceConfirmation(
    network: string,
    traceExternalHashNorm: string,
    options: { timeoutSeconds: number },
  ): Promise<Record<string, unknown>>;
}

export type HighloadV3ConfigOptions = {
  secretKey: Buffer;
  apiKey?: string;
  subwalletId?: number;
  timeout?: number;
  relayAmount?: bigint;
  providerBaseUrl?: string;
  providerTimeoutSeconds?: number;
  providerEmulationTimeoutSeconds?: number;
  workchain?: number;
  provider?: string;
};

export class HighloadV3Config {
  readonly secretKey: Buffer;
  readonly apiKey?: string;
  readonly subwalletId: number;
  readonly timeout: number;
  readonly relayAmount: bigint;
  readonly providerBaseUrl?: string;
  readonly providerTimeoutSeconds: number;
  readonly providerEmulationTimeoutSeconds: number;
  readonly workchain: number;
  readonly provider: string;

  constructor(options: HighloadV3ConfigOptions) {
    this.secretKey = normalizePrivateKeyBytes(options.secretKey);
    this.apiKey = options.apiKey;
    this.subwalletId = options.subwalletId ?? DEFAULT_HIGHLOAD_SUBWALLET_ID;
    this.timeout = options.timeout ?? DEFAULT_HIGHLOAD_TIMEOUT;
    this.relayAmount = options.relayAmount ?? DEFAULT_RELAY_AMOUNT;
    this.providerBaseUrl = options.providerBaseUrl;
    this.providerTimeoutSeconds =
      options.providerTimeoutSeconds ?? DEFAULT_TONCENTER_TIMEOUT_SECONDS;
    this.providerEmulationTimeoutSeconds =
      options.providerEmulationTimeoutSeconds ?? DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS;
    this.workchain = options.workchain ?? 0;
    this.provider = options.provider ?? TVM_PROVIDER_TONCENTER;
  }

  static fromPrivateKey(
    privateKey: string | Buffer,
    options: Omit<HighloadV3ConfigOptions, "secretKey"> = {},
  ): HighloadV3Config {
    return new HighloadV3Config({ ...options, secretKey: parsePrivateKey(privateKey) });
  }
}

export function toClientTvmSigner(
  keyPair: KeyPair,
  options?: boolean | ClientTvmSignerOptions,
): ClientTvmSigner {
  const network =
    typeof options === "boolean"
      ? options
        ? TVM_TESTNET
        : TVM_MAINNET
      : (options?.network ?? TVM_MAINNET);
  const workchain = typeof options === "boolean" ? 0 : (options?.workchain ?? 0);
  const subwalletNumber =
    typeof options === "boolean" ? DEFAULT_W5R1_SUBWALLET_NUMBER : (options?.subwalletNumber ?? 0);
  const signerOptions = typeof options === "boolean" ? undefined : options;
  const walletId = makeW5R1WalletId(network, workchain, subwalletNumber);
  const stateInit = buildW5R1StateInit(keyPair.publicKey, walletId);
  const address = addressFromStateInit(stateInit, workchain);

  return {
    address,
    network,
    walletId,
    stateInit,
    publicKey: keyPair.publicKey.toString("hex"),
    apiKey: signerOptions?.apiKey,
    provider: signerOptions?.provider,
    providerBaseUrl: signerOptions?.providerBaseUrl,
    providerTimeoutSeconds: signerOptions?.providerTimeoutSeconds,
    providerEmulationTimeoutSeconds: signerOptions?.providerEmulationTimeoutSeconds,

    signMessage(message: Buffer): Buffer {
      return sign(message, keyPair.secretKey);
    },

    async signTransfer(
      seqno: number,
      validUntil: number,
      messages: { address: string; amount: bigint; body: Cell | null }[],
      transferOptions?: { includeStateInit?: boolean },
    ): Promise<string> {
      const actions = serializeOutListCells(
        messages.map(message => {
          const outMessage = internal({
            to: Address.parseRaw(message.address),
            value: message.amount,
            bounce: true,
            body: message.body ?? undefined,
          });
          return serializeSendMsgActionCell(
            beginCell().store(storeMessageRelaxed(outMessage)).endCell(),
            SEND_MODE_PAY_FEES_SEPARATELY,
          );
        }),
      );
      const unsignedBody = beginCell()
        .storeUint(INTERNAL_SIGNED_OP, 32)
        .storeUint(walletId, 32)
        .storeUint(validUntil, 32)
        .storeUint(seqno, 32)
        .storeMaybeRef(actions)
        .storeBit(false)
        .endCell();
      const transferBody = beginCell()
        .storeSlice(unsignedBody.beginParse())
        .storeBuffer(sign(unsignedBody.hash(), keyPair.secretKey), 64)
        .endCell();

      const settlementMessage = internal({
        to: Address.parseRaw(address),
        value: 0n,
        bounce: true,
        init: transferOptions?.includeStateInit ? stateInit : undefined,
        body: transferBody,
      });

      return beginCell()
        .store(storeMessageRelaxed(settlementMessage))
        .endCell()
        .toBoc()
        .toString("base64");
    },
  };
}

export function toFacilitatorTvmSigner(
  configs: Record<string, HighloadV3Config> | HighloadV3Config,
  network = TVM_MAINNET,
): FacilitatorHighloadV3Signer {
  return new FacilitatorHighloadV3Signer(
    configs instanceof HighloadV3Config ? { [network]: configs } : configs,
  );
}

export class FacilitatorHighloadV3Signer implements FacilitatorTvmSigner {
  private readonly clients = new Map<string, TvmProviderClient>();
  private readonly wallets = new Map<string, WalletContext>();
  private readonly queryIds = new Map<string, number>();

  constructor(private readonly configs: Record<string, HighloadV3Config>) {
    for (const [network, config] of Object.entries(configs)) {
      this.wallets.set(network, WalletContext.fromConfig(config));
      this.queryIds.set(network, randomInt(MAX_USABLE_QUERY_SEQNO + 1));
    }
  }

  getAddresses(): string[] {
    return [...this.wallets.values()].map(wallet => wallet.address);
  }

  getAddressesForNetwork(network: string): string[] {
    const wallet = this.wallets.get(network);
    if (!wallet) {
      throw new Error(`Unsupported network: ${network}`);
    }
    return [wallet.address];
  }

  close(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }

  async getAccountState(address: string, network: string): Promise<TvmAccountState> {
    return this.client(network).getAccountState(address);
  }

  async getJettonWallet(asset: string, owner: string, network: string): Promise<string> {
    return this.client(network).getJettonWallet(asset, owner);
  }

  async getJettonWalletData(address: string, network: string): Promise<TvmJettonWalletData> {
    return this.client(network).getJettonWalletData(address);
  }

  async buildRelayExternalBoc(
    network: string,
    relayRequest: TvmRelayRequest,
    options: { forEmulation?: boolean } = {},
  ): Promise<Buffer> {
    return this.buildRelayExternalBocBatch(network, [relayRequest], options);
  }

  async buildRelayExternalBocBatch(
    network: string,
    relayRequests: TvmRelayRequest[],
    { forEmulation = false }: { forEmulation?: boolean } = {},
  ): Promise<Buffer> {
    if (!relayRequests.length) {
      throw new Error("relayRequests must not be empty");
    }
    if (relayRequests.length > DEFAULT_SETTLEMENT_BATCH_MAX_SIZE) {
      throw new Error(`relayRequests must not exceed ${DEFAULT_SETTLEMENT_BATCH_MAX_SIZE}`);
    }

    const walletContext = this.walletContext(network);
    const queryId = await this.selectQueryId(network, forEmulation);
    const createdAt = Math.floor(Date.now() / 1000) - 5;
    const forwardActions: Cell[] = [];

    for (const relayRequest of relayRequests) {
      const forwardValue =
        relayRequest.relayAmount ??
        walletContext.config.relayAmount + (relayRequest.forwardTonAmount ?? 0n);
      const forwardMessage = internal({
        to: Address.parseRaw(relayRequest.destination),
        value: forwardValue,
        bounce: true,
        init: relayRequest.stateInit ?? undefined,
        body: relayRequest.body,
      });
      forwardActions.push(
        serializeSendMsgActionCell(
          beginCell().store(storeMessageRelaxed(forwardMessage)).endCell(),
          SEND_MODE_PAY_FEES_SEPARATELY + SEND_MODE_IGNORE_ERRORS,
        ),
      );
    }

    const messageToSend = this.packActionsMessage(walletContext, forwardActions, queryId);
    const messageInner = beginCell()
      .storeUint(walletContext.config.subwalletId, 32)
      .storeRef(messageToSend)
      .storeUint(1, 8)
      .storeUint(queryId, 23)
      .storeUint(createdAt, 64)
      .storeUint(walletContext.config.timeout, 22)
      .endCell();
    const externalBody = beginCell()
      .storeBuffer(sign(messageInner.hash(), walletContext.config.secretKey), 64)
      .storeRef(messageInner)
      .endCell();

    let externalStateInit: StateInit | undefined;
    if (walletContext.deployed !== true) {
      const facilitatorAccount = await this.getAccountState(walletContext.address, network);
      walletContext.deployed = facilitatorAccount.isActive;
      if (facilitatorAccount.isUninitialized) {
        externalStateInit = walletContext.stateInit;
      }
    }

    const externalMessage = external({
      to: Address.parseRaw(walletContext.address),
      init: externalStateInit,
      body: externalBody,
    });
    return beginCell().store(storeMessage(externalMessage)).endCell().toBoc();
  }

  async emulateExternalMessage(
    network: string,
    externalBoc: Buffer,
  ): Promise<Record<string, unknown>> {
    return this.client(network).emulateTrace(externalBoc, {
      timeout: this.config(network).providerEmulationTimeoutSeconds,
    });
  }

  async sendExternalMessage(network: string, externalBoc: Buffer): Promise<string> {
    return this.client(network).sendMessage(externalBoc);
  }

  async waitForTraceConfirmation(
    network: string,
    traceExternalHashNorm: string,
    { timeoutSeconds }: { timeoutSeconds: number },
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const trace = await this.client(network).getTraceByMessageHash(traceExternalHashNorm);
        if (trace.is_incomplete !== true) {
          return trace;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(`Timed out waiting for complete trace ${traceExternalHashNorm}`);
  }

  private client(network: string): TvmProviderClient {
    const existing = this.clients.get(network);
    if (existing) return existing;
    const config = this.config(network);
    const client = createTvmProviderClient(network, {
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.providerBaseUrl,
      timeout: config.providerTimeoutSeconds,
    });
    this.clients.set(network, client);
    return client;
  }

  private config(network: string): HighloadV3Config {
    const config = this.configs[network];
    if (!config) {
      throw new Error(`Unsupported network: ${network}`);
    }
    return config;
  }

  private walletContext(network: string): WalletContext {
    const wallet = this.wallets.get(network);
    if (!wallet) {
      throw new Error(`Unsupported network: ${network}`);
    }
    return wallet;
  }

  private packActionsMessage(walletContext: WalletContext, actions: Cell[], queryId: number): Cell {
    let batchActions = [...actions];
    if (batchActions.length > 254) {
      const nestedMessage = this.packActionsMessage(
        walletContext,
        batchActions.slice(253),
        queryId,
      );
      batchActions = [
        ...batchActions.slice(0, 253),
        serializeSendMsgActionCell(
          nestedMessage,
          SEND_MODE_PAY_FEES_SEPARATELY + SEND_MODE_IGNORE_ERRORS,
        ),
      ];
    }

    const body = serializeInternalTransfer(serializeOutListCells(batchActions), queryId);
    const message = internal({
      to: Address.parseRaw(walletContext.address),
      value: 1_000_000_000n,
      bounce: true,
      body,
    });
    return beginCell().store(storeMessageRelaxed(message)).endCell();
  }

  private async selectQueryId(network: string, forEmulation: boolean): Promise<number> {
    const walletContext = this.walletContext(network);
    const queryState = loadHighloadQueryState(
      await this.getAccountState(walletContext.address, network),
      { expectedCodeHash: HIGHLOAD_V3_CODE_HASH },
    );
    walletContext.deployed = queryState !== null;
    let nextSeqno = this.queryIds.get(network) ?? 0;
    for (let attempt = 0; attempt <= MAX_USABLE_QUERY_SEQNO; attempt += 1) {
      const seqno = nextSeqno;
      nextSeqno = (nextSeqno + 1) % (MAX_USABLE_QUERY_SEQNO + 1);
      const queryId = seqnoToQueryId(seqno);
      if (!queryState || !queryIdIsProcessed(queryState, queryId)) {
        if (!forEmulation) {
          this.queryIds.set(network, nextSeqno);
        }
        return queryId;
      }
    }
    throw new Error("No free Highload V3 query_id available");
  }
}

class WalletContext {
  deployed: boolean | null = null;

  private constructor(
    readonly config: HighloadV3Config,
    readonly publicKey: Buffer,
    readonly address: string,
    readonly stateInit: StateInit,
  ) {}

  static fromConfig(config: HighloadV3Config): WalletContext {
    const publicKey = keyPairFromSecretKey(config.secretKey).publicKey;
    const code = Cell.fromBoc(Buffer.from(HIGHLOAD_V3_CODE_HEX, "hex"))[0];
    if (code.hash().toString("hex") !== HIGHLOAD_V3_CODE_HASH) {
      throw new Error("Unexpected highload-wallet-contract-v3 code hash");
    }
    const data = beginCell()
      .storeBuffer(publicKey, 32)
      .storeUint(config.subwalletId, 32)
      .storeUint(0, 66)
      .storeUint(config.timeout, 22)
      .endCell();
    const stateInit = { code, data };
    const address = contractAddress(config.workchain, stateInit).toRawString();
    return new WalletContext(config, publicKey, address, stateInit);
  }
}

function serializeSendMsgActionCell(message: Cell, mode: number): Cell {
  return beginCell().storeUint(0x0ec3c86d, 32).storeUint(mode, 8).storeRef(message).endCell();
}

function serializeOutListCells(actions: Cell[]): Cell {
  let outList = Cell.EMPTY;
  for (const action of actions) {
    outList = beginCell().storeRef(outList).storeBuilder(action.asBuilder()).endCell();
  }
  return outList;
}

function parsePrivateKey(privateKey: string | Buffer): Buffer {
  if (Buffer.isBuffer(privateKey)) {
    return normalizePrivateKeyBytes(privateKey);
  }
  let value = privateKey.trim();
  if (value.startsWith("0x")) {
    value = value.slice(2);
  }
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return normalizePrivateKeyBytes(Buffer.from(value, "hex"));
  }
  return normalizePrivateKeyBytes(Buffer.from(value, "base64"));
}

function normalizePrivateKeyBytes(privateKey: Buffer): Buffer {
  if (privateKey.length === 64) {
    return privateKey;
  }
  if (privateKey.length === 32) {
    return keyPairFromSeed(privateKey).secretKey;
  }
  throw new Error("TVM private key must be 32 bytes (seed) or 64 bytes (secret key)");
}

export { DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT };
