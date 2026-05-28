import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from '@x402/core/types'
import { Address, beginCell, Cell } from '@ton/core'
import { TonClient, JettonMaster, WalletContractV5R1 } from '@ton/ton'
import { ClientTvmSigner } from '../../signer'
import { TvmPaymentPayload } from '../../types'
import {
  DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
  DEFAULT_VALID_UNTIL_OFFSET,
  SUPPORTED_NETWORKS,
  TVM_MAINNET,
  TVM_TESTNET,
} from '../../constants'
import { normalizeTonAddress } from '../../utils'

const TONCENTER_MAINNET_RPC_URL = 'https://toncenter.com/api/v2/jsonRPC'
const TONCENTER_TESTNET_RPC_URL = 'https://testnet.toncenter.com/api/v2/jsonRPC'

/**
 * Configuration for TVM client scheme.
 */
export interface ExactTvmClientConfig {
  /** TON RPC endpoint URL (default: toncenter.com free tier) */
  rpcUrl?: string
  /** Optional API key for higher rate limits */
  apiKey?: string
}

/**
 * Build a TEP-74 jetton_transfer body cell.
 */
function buildJettonTransferBody(
  destination: string,
  amount: bigint,
  responseDestination?: string,
  forwardTonAmount = 0n,
  forwardPayload?: string,
): Cell {
  if (forwardTonAmount < 0n) {
    throw new Error('Forward TON amount should be >= 0')
  }

  const builder = beginCell()
    .storeUint(0x0f8a7ea5, 32) // op: jetton_transfer
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(Address.parse(destination))
    .storeAddress(responseDestination ? Address.parse(responseDestination) : null)
    .storeBit(false) // no custom_payload
    .storeCoins(forwardTonAmount)

  if (forwardPayload) {
    const cells = Cell.fromBoc(Buffer.from(forwardPayload, 'base64'))
    if (cells.length !== 1) {
      throw new Error('forwardPayload must contain exactly one cell')
    }
    builder.storeBit(true).storeRef(cells[0])
  } else {
    builder.storeUint(0, 2)
  }

  return builder.endCell()
}

function defaultRpcUrl(network: string): string {
  if (network === TVM_TESTNET) return TONCENTER_TESTNET_RPC_URL
  return TONCENTER_MAINNET_RPC_URL
}

/**
 * TVM client implementation for the Exact payment scheme.
 *
 * Resolves signing data (seqno, Jetton wallet) via TON RPC,
 * then signs locally and returns the payment payload.
 */
export class ExactTvmScheme implements SchemeNetworkClient {
  readonly scheme = 'exact'
  private readonly rpcUrl: string
  private readonly apiKey?: string

  constructor(
    private readonly signer: ClientTvmSigner,
    options?: ExactTvmClientConfig,
  ) {
    this.rpcUrl = options?.rpcUrl ?? TONCENTER_MAINNET_RPC_URL
    this.apiKey = options?.apiKey
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const network = String(paymentRequirements.network)
    if (!SUPPORTED_NETWORKS.has(network)) {
      throw new Error(`Unsupported TVM network: ${network}`)
    }
    if (this.signer.network !== network) {
      throw new Error(
        `Signer network ${this.signer.network} does not match requirements network ${network}`,
      )
    }
    if (paymentRequirements.extra?.areFeesSponsored !== true) {
      throw new Error('Exact TVM scheme requires extra.areFeesSponsored to be true')
    }

    const asset = normalizeTonAddress(paymentRequirements.asset)
    const payTo = normalizeTonAddress(paymentRequirements.payTo)
    const payer = normalizeTonAddress(this.signer.address)
    const responseDestination =
      typeof paymentRequirements.extra?.responseDestination === 'string'
        ? normalizeTonAddress(paymentRequirements.extra.responseDestination)
        : undefined
    const forwardTonAmount = BigInt(String(paymentRequirements.extra?.forwardTonAmount ?? '0'))
    const forwardPayload =
      typeof paymentRequirements.extra?.forwardPayload === 'string'
        ? paymentRequirements.extra.forwardPayload
        : undefined

    // Create TON RPC client
    const client = new TonClient({
      endpoint: this.rpcUrl === TONCENTER_MAINNET_RPC_URL ? defaultRpcUrl(network) : this.rpcUrl,
      apiKey: this.apiKey,
    })

    // Resolve client's Jetton wallet address via RPC
    const jettonMaster = client.open(JettonMaster.create(Address.parseRaw(asset)))
    const jettonWalletAddress = await jettonMaster.getWalletAddress(Address.parseRaw(payer))

    // Get client wallet seqno via RPC
    const wallet = client.open(
      WalletContractV5R1.create({
        workchain: 0,
        publicKey: Buffer.from(this.signer.publicKey, 'hex'),
      }),
    )
    const seqno = await wallet.getSeqno()
    const accountState = await client.getContractState(Address.parseRaw(payer))
    const includeStateInit = accountState.state !== 'active'

    // Build jetton transfer body
    const jettonBody = buildJettonTransferBody(
      payTo,
      BigInt(paymentRequirements.amount),
      responseDestination,
      forwardTonAmount,
      forwardPayload,
    )

    const timeoutSeconds = paymentRequirements.maxTimeoutSeconds ?? DEFAULT_VALID_UNTIL_OFFSET
    const validUntil =
      Math.floor(Date.now() / 1000) +
      (timeoutSeconds > 10 ? timeoutSeconds - 5 : Math.ceil(timeoutSeconds / 2))

    // Sign the W5R1 transfer — returns internal message BoC
    const messagesToSign = [
      {
        address: jettonWalletAddress.toRawString(),
        amount: DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT + forwardTonAmount,
        body: jettonBody,
      },
    ]

    const settlementBoc = await this.signer.signTransfer(seqno, validUntil, messagesToSign, {
      includeStateInit,
    })

    // Minimal payload: BoC + asset. Everything else derived by facilitator.
    const tvmPayload: TvmPaymentPayload = {
      settlementBoc,
      asset,
    }

    return {
      x402Version,
      payload: tvmPayload as unknown as Record<string, unknown>,
    }
  }
}
