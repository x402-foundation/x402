export const SCHEME_EXACT = "exact";

export const TVM_MAINNET = "tvm:-239";
export const TVM_TESTNET = "tvm:-3";

export const SUPPORTED_NETWORKS = new Set([TVM_MAINNET, TVM_TESTNET]);

/** USDT Jetton Master on TON mainnet */
export const USDT_MASTER = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";

/** Jetton transfer operation code */
export const JETTON_TRANSFER_OP = 0x0f8a7ea5;

/** W5R1 wallet code hash (base64) */
export const W5R1_CODE_HASH = "IINLe3KxEhR+Gy+0V7hOdNGjDwT3N9T2KmaOlVLSty8=";

/** Default settlement timeout in seconds */
export const SETTLEMENT_TIMEOUT = 15;

/** Default valid-until offset (5 minutes) */
export const DEFAULT_VALID_UNTIL_OFFSET = 5 * 60;

/** W5R1 opcode for internal (relay) signed messages */
export const INTERNAL_SIGNED_OP = 0x73696e74;

/** W5R1 opcode for external signed messages */
export const EXTERNAL_SIGNED_OP = 0x7369676e;

/** W5R1 send_msg action opcode */
export const SEND_MSG_OP = 0x0ec3c86d;

/** USDT has 6 decimals on TON */
export const USDT_DECIMALS = 6;
