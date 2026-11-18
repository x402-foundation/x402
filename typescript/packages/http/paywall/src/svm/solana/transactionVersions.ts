import type { SolanaTransactionVersion } from "@solana/wallet-standard-features";

/**
 * Solana message versions the x402 SVM client can build.
 */
export type ClientTransactionVersion = 0 | 1;

/**
 * Versions a wallet is assumed to sign when its `solana:signTransaction`
 * feature does not declare `supportedTransactionVersions`.
 */
const DEFAULT_WALLET_VERSIONS: readonly SolanaTransactionVersion[] = ["legacy", 0];

/**
 * Derives the `transactionVersions` option for `ExactSvmScheme` from the
 * versions a wallet declares in its `solana:signTransaction` feature.
 *
 * Version 1 is offered only when the wallet lists `1`, so a facilitator that
 * advertises version 1 never asks a wallet that cannot sign it to do so.
 * Version 0 stays in the set either way, which keeps the payment on version 0
 * when the facilitator does not advertise version 1, and keeps wallets that
 * list neither version on version 0, as before.
 *
 * @param supportedTransactionVersions - The wallet's declared versions; missing means `["legacy", 0]`.
 * @returns `[0, 1]` when the wallet lists version 1, otherwise `[0]`.
 */
export function getClientTransactionVersions(
  supportedTransactionVersions: readonly SolanaTransactionVersion[] | undefined,
): readonly ClientTransactionVersion[] {
  const supported = supportedTransactionVersions ?? DEFAULT_WALLET_VERSIONS;
  return supported.includes(1) ? [0, 1] : [0];
}
