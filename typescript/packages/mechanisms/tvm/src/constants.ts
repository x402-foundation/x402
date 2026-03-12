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

/** Default maximum relay commission in nanoTON */
export const DEFAULT_MAX_RELAY_COMMISSION = 500_000;

/** Base amount of TON attached to jetton transfer internal messages */
export const BASE_JETTON_SEND_AMOUNT = 100_000_000n; // 0.1 TON

/** Default valid-until offset (5 minutes) */
export const DEFAULT_VALID_UNTIL_OFFSET = 5 * 60;

/** USDT has 6 decimals on TON */
export const USDT_DECIMALS = 6;
