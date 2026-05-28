import { WalletContractV5R1 } from '@ton/ton'
import { KeyPair } from '@ton/crypto'
import { Address, beginCell, internal, SendMode, storeMessageRelaxed, Cell } from '@ton/core'
import { TVM_MAINNET, TVM_TESTNET } from './constants'

/**
 * ClientTvmSigner — Used by x402 clients to sign TON payment authorizations.
 *
 * Wraps a W5R1 wallet and provides methods to:
 * - Get the wallet address and public key
 * - Sign W5R1 transfers and produce settlement BOCs
 */
export type ClientTvmSigner = {
  /** Wallet address in raw format (0:hex) */
  address: string
  /** CAIP-2 TVM network this signer is bound to. */
  network: string
  /** Public key as hex string */
  publicKey: string
  /**
   * Sign a W5R1 transfer with the given messages and produce a settlement BOC.
   * Returns a base64-encoded internal message BoC (not external).
   */
  signTransfer: (
    seqno: number,
    validUntil: number,
    messages: { address: string; amount: bigint; body: Cell | null }[],
    options?: { includeStateInit?: boolean },
  ) => Promise<string> // base64 BOC
}

export interface ClientTvmSignerOptions {
  network?: string
}

/**
 * Creates a ClientTvmSigner from a TON keypair.
 *
 * @param keyPair - The ed25519 keypair (from mnemonicToPrivateKey)
 * @param testnet - Whether to use testnet (default: false)
 * @returns A ClientTvmSigner instance
 */
export function toClientTvmSigner(
  keyPair: KeyPair,
  options?: boolean | ClientTvmSignerOptions,
): ClientTvmSigner {
  const network =
    typeof options === 'boolean'
      ? options
        ? TVM_TESTNET
        : TVM_MAINNET
      : (options?.network ?? TVM_MAINNET)
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  })

  return {
    address: wallet.address.toRawString(),
    network,
    publicKey: keyPair.publicKey.toString('hex'),

    async signTransfer(
      seqno: number,
      validUntil: number,
      messages: { address: string; amount: bigint; body: Cell | null }[],
      transferOptions?: { includeStateInit?: boolean },
    ): Promise<string> {
      const transferBody = wallet.createTransfer({
        seqno,
        authType: 'internal',
        timeout: validUntil,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: messages.map((m) =>
          internal({
            to: Address.parseRaw(m.address),
            value: m.amount,
            bounce: true,
            body: m.body ?? undefined,
          }),
        ),
      })

      // Encode as internal message (not external).
      // The facilitator will extract body + stateInit and re-wrap with gas.
      const intMessage = beginCell()
        .storeWritable(
          storeMessageRelaxed(
            internal({
              to: wallet.address,
              value: 0n,
              bounce: true,
              init: transferOptions?.includeStateInit ? wallet.init : undefined,
              body: transferBody,
            }),
          ),
        )
        .endCell()

      return intMessage.toBoc().toString('base64')
    },
  }
}
