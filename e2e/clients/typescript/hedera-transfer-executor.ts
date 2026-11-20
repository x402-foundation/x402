import type { ClientHederaSigner } from "@x402/hedera";

type EnvLookup = (key: string) => string | undefined;

/**
 * Adds the `transferExecutor` authorization hook to the e2e Hedera client signer.
 *
 * The hook hands over `HEDERA_TE_EXECUTOR_ID` and `HEDERA_TE_AUTHORIZATION` as given: the
 * authorization format belongs to the executor, so it is prepared outside the suite. It is
 * single-use: the executor consumes it on the first successful settlement, so one value pays
 * one scenario. `HEDERA_TE_PAYER_ACCOUNT_ID` (default `CLIENT_HEDERA_ACCOUNT_ID`) becomes
 * `payload.payer`; `cryptoTransfer` payments still sign from `CLIENT_HEDERA_ACCOUNT_ID`.
 *
 * @param signer - The `cryptoTransfer` signer built from `CLIENT_HEDERA_*`
 * @param env - Env lookup
 * @returns The signer, with the hook when `HEDERA_TE_EXECUTOR_ID` is set
 */
export function withTransferExecutorAuthorization(
  signer: ClientHederaSigner,
  env: EnvLookup = key => process.env[key],
): ClientHederaSigner {
  const executor = env("HEDERA_TE_EXECUTOR_ID")?.trim();
  if (!executor) {
    return signer;
  }
  return {
    ...signer,
    accountId: env("HEDERA_TE_PAYER_ACCOUNT_ID")?.trim() || signer.accountId,
    createTransferExecutorAuthorization: async () => {
      const authorization = env("HEDERA_TE_AUTHORIZATION")?.trim();
      if (!authorization) {
        throw new Error("HEDERA_TE_AUTHORIZATION is required to pay a transferExecutor route");
      }
      return { executor, authorization };
    },
  };
}
