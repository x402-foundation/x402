import { WalletContractV5R1 } from "@ton/ton";
import { KeyPair } from "@ton/crypto";
import {
  Address,
  beginCell,
  internal,
  external,
  SendMode,
  storeMessage,
  Cell,
} from "@ton/core";
import { TonApiClient } from "@ton-api/client";
import { ContractAdapter } from "@ton-api/ton-adapter";
import { isTvmTestnet } from "./utils";

/**
 * ClientTvmSigner — Used by x402 clients to sign TON payment authorizations.
 *
 * Wraps a W5R1 wallet and provides methods to:
 * - Get the wallet address and public key
 * - Build gasless estimates via TONAPI
 * - Sign W5R1 transfers and produce settlement BOCs
 */
export type ClientTvmSigner = {
  /** Wallet address in raw format (0:hex) */
  address: string;
  /** Public key as hex string */
  publicKey: string;
  /**
   * Get the current seqno from the wallet contract.
   */
  getSeqno: () => Promise<number>;
  /**
   * Get the jetton wallet address for a given master and owner.
   */
  getJettonWallet: (master: string, owner: string) => Promise<string>;
  /**
   * Get the relay address from TONAPI gasless config.
   */
  getRelayAddress: () => Promise<string>;
  /**
   * Estimate gasless fees via TONAPI.
   * Returns SignRawParams messages that the client signs.
   */
  gaslessEstimate: (
    jettonMaster: string,
    walletAddress: string,
    walletPublicKey: string,
    messages: Cell[],
  ) => Promise<{ address: string; amount: string; payload: Cell | null; stateInit?: string }[]>;
  /**
   * Sign a W5R1 transfer with the given messages and produce a settlement BOC.
   */
  signTransfer: (
    seqno: number,
    validUntil: number,
    messages: { address: string; amount: bigint; body: Cell | null }[],
  ) => Promise<string>; // base64 BOC
};

/**
 * FacilitatorTvmSigner — Used by x402 facilitators to verify and settle TON payments.
 */
export type FacilitatorTvmSigner = {
  /**
   * Submit a signed BOC to TONAPI gasless/send.
   */
  gaslessSend: (boc: string, walletPublicKey: string) => Promise<string>;
};

/**
 * Creates a ClientTvmSigner from a TON keypair.
 *
 * @param keyPair - The ed25519 keypair (from mnemonicToPrivateKey)
 * @param tonapiKey - Optional TONAPI key for higher rate limits
 * @param testnet - Whether to use testnet (default: false)
 * @returns A ClientTvmSigner instance
 */
export function toClientTvmSigner(
  keyPair: KeyPair,
  tonapiKey?: string,
  testnet?: boolean,
): ClientTvmSigner {
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  const ta = new TonApiClient({
    baseUrl: testnet ? "https://testnet.tonapi.io" : "https://tonapi.io",
    apiKey: tonapiKey,
  });
  const provider = new ContractAdapter(ta);
  const contract = provider.open(wallet);

  return {
    address: wallet.address.toRawString(),
    publicKey: keyPair.publicKey.toString("hex"),

    async getSeqno(): Promise<number> {
      return contract.getSeqno();
    },

    async getJettonWallet(master: string, owner: string): Promise<string> {
      const masterAddr = Address.parseRaw(master);
      const result = await ta.blockchain.execGetMethodForBlockchainAccount(
        masterAddr,
        "get_wallet_address",
        { args: [owner] },
      );
      const decoded = result.decoded as Record<string, string>;
      const addr = decoded.jettonWalletAddress || decoded.jetton_wallet_address;
      if (!addr) {
        throw new Error("Failed to resolve jetton wallet address");
      }
      return addr;
    },

    async getRelayAddress(): Promise<string> {
      const config = await ta.gasless.gaslessConfig();
      return config.relayAddress.toRawString();
    },

    async gaslessEstimate(
      jettonMaster: string,
      walletAddress: string,
      walletPublicKey: string,
      messages: Cell[],
    ) {
      const masterAddr = Address.parseRaw(jettonMaster);
      const walletAddr = Address.parseRaw(walletAddress);
      const params = await ta.gasless.gaslessEstimate(masterAddr, {
        walletAddress: walletAddr,
        walletPublicKey,
        messages: messages.map((boc) => ({ boc })),
      });
      return params.messages.map((m) => ({
        address: m.address.toRawString(),
        amount: m.amount.toString(),
        payload: m.payload ?? null,
        stateInit: (m as any).stateInit,
      }));
    },

    async signTransfer(
      seqno: number,
      validUntil: number,
      messages: { address: string; amount: bigint; body: Cell | null }[],
    ): Promise<string> {
      const transferBody = wallet.createTransfer({
        seqno,
        authType: "internal",
        timeout: validUntil,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
        messages: messages.map((m) =>
          internal({
            to: Address.parseRaw(m.address),
            value: m.amount,
            body: m.body ?? undefined,
          }),
        ),
      });

      const extMessage = beginCell()
        .storeWritable(
          storeMessage(
            external({
              to: contract.address,
              init: seqno === 0 ? contract.init : undefined,
              body: transferBody,
            }),
          ),
        )
        .endCell();

      return extMessage.toBoc().toString("base64");
    },
  };
}

/**
 * Creates a FacilitatorTvmSigner backed by TONAPI.
 *
 * @param tonapiKey - Optional TONAPI key for higher rate limits
 * @param network - Network identifier (e.g. "tvm:-239")
 * @returns A FacilitatorTvmSigner instance
 */
export function toFacilitatorTvmSigner(
  tonapiKey?: string,
  network?: string,
): FacilitatorTvmSigner {
  const testnet = network ? isTvmTestnet(network) : false;
  const baseUrl = testnet ? "https://testnet.tonapi.io" : "https://tonapi.io";

  return {
    async gaslessSend(boc: string, walletPublicKey: string): Promise<string> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (tonapiKey) {
        headers["Authorization"] = `Bearer ${tonapiKey}`;
      }

      const response = await fetch(`${baseUrl}/v2/gasless/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          wallet_public_key: walletPublicKey,
          boc,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`TONAPI gasless/send failed: ${response.status} ${error}`);
      }

      return `gasless-ok`;
    },
  };
}
