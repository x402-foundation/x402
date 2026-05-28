export const SCHEME_EXACT = 'exact'

export const TVM_MAINNET = 'tvm:-239'
export const TVM_TESTNET = 'tvm:-3'

export const SUPPORTED_NETWORKS = new Set([TVM_MAINNET, TVM_TESTNET])

/** USDT Jetton Master on TON mainnet. */
export const USDT_MAINNET_MINTER =
  '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'

/** Test USDT Jetton Master on TON testnet. */
export const USDT_TESTNET_MINTER =
  '0:f418a04cf196ebc959366844a6cdf53a6fd6fff1eadafc892f05210bba31593e'

/** Backwards-compatible alias for the mainnet USDT minter. */
export const USDT_MASTER = USDT_MAINNET_MINTER

/** Jetton transfer operation code */
export const JETTON_TRANSFER_OP = 0x0f8a7ea5

/** W5R1 wallet code hash (base64) */
export const W5R1_CODE_HASH = 'IINLe3KxEhR+Gy+0V7hOdNGjDwT3N9T2KmaOlVLSty8='

/** Default settlement timeout in seconds */
export const SETTLEMENT_TIMEOUT = 15

/** Default valid-until offset (5 minutes) */
export const DEFAULT_VALID_UNTIL_OFFSET = 5 * 60

/** Default TON value attached to the client-signed Jetton wallet message. */
export const DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT = 30_000_000n

/** W5R1 opcode for internal (relay) signed messages */
export const INTERNAL_SIGNED_OP = 0x73696e74

/** W5R1 opcode for external signed messages */
export const EXTERNAL_SIGNED_OP = 0x7369676e

/** W5R1 send_msg action opcode */
export const SEND_MSG_OP = 0x0ec3c86d

/** USDT has 6 decimals on TON */
export const USDT_DECIMALS = 6

export const ERR_EXACT_TVM_UNSUPPORTED_SCHEME = 'unsupported_scheme'
export const ERR_EXACT_TVM_UNSUPPORTED_NETWORK = 'unsupported_network'
export const ERR_EXACT_TVM_NETWORK_MISMATCH = 'network_mismatch'
export const ERR_EXACT_TVM_INVALID_PAYLOAD = 'invalid_exact_tvm_payload'
export const ERR_EXACT_TVM_INVALID_ASSET = 'invalid_exact_tvm_payload_asset_mismatch'
