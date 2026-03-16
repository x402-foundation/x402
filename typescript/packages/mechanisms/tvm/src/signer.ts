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

/**
 * ClientTvmSigner — Used by x402 clients to sign TON payment authorizations.
 *
 * Wraps a W5R1 wallet and provides methods to:
 * - Get the wallet address and public key
 * - Sign W5R1 transfers and produce settlement BOCs
 */
export type ClientTvmSigner = {
  /** Wallet address in raw format (0:hex) */
  address: string;
  /** Public key as hex string */
  publicKey: string;
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
 * Creates a ClientTvmSigner from a TON keypair.
 *
 * @param keyPair - The ed25519 keypair (from mnemonicToPrivateKey)
 * @param testnet - Whether to use testnet (default: false)
 * @returns A ClientTvmSigner instance
 */
export function toClientTvmSigner(
  keyPair: KeyPair,
  testnet?: boolean,
): ClientTvmSigner {
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  return {
    address: wallet.address.toRawString(),
    publicKey: keyPair.publicKey.toString("hex"),

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
              to: wallet.address,
              init: seqno === 0 ? wallet.init : undefined,
              body: transferBody,
            }),
          ),
        )
        .endCell();

      return extMessage.toBoc().toString("base64");
    },
  };
}
