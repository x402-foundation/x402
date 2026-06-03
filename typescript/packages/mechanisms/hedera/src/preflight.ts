import {
  AccountBalanceQuery,
  AccountId,
  AccountInfoQuery,
  Client,
  TokenId,
} from "@hiero-ledger/sdk";
import { isHbarAsset } from "./utils";

/**
 * Parameters passed to a `FacilitatorHederaSigner.preflightTransfer` hook.
 */
export type HederaPreflightParams = {
  payer: string;
  payTo: string;
  asset: string;
  amount: string;
  network: string;
};

/**
 * Result returned from a `preflightTransfer` hook.
 */
export type HederaPreflightResult = {
  ok: boolean;
  reason?: string;
  message?: string;
};

/**
 * Builds a `preflightTransfer` implementation backed by the Hiero SDK.
 *
 * Checks the payer has sufficient balance of `asset` and that `payTo` is
 * either associated with `asset` or has an available auto-association slot.
 * Implements the SHOULD in `specs/schemes/exact/scheme_exact_hedera.md` §6.
 *
 * The caller supplies `buildClient(network)` — responsible for SDK client
 * construction and operator setup (and node-URL selection, if any). The
 * returned function closes the client in a `finally` block.
 *
 * @param buildClient - Factory that produces an SDK client for a given CAIP-2 network
 * @returns A function suitable for `FacilitatorHederaSigner.preflightTransfer`
 */
export function createHederaPreflightTransfer(
  buildClient: (network: string) => Client,
): (params: HederaPreflightParams) => Promise<HederaPreflightResult> {
  return async ({ payer, payTo, asset, amount, network }) => {
    const client = buildClient(network);
    try {
      const required = BigInt(amount);
      const balance = await new AccountBalanceQuery()
        .setAccountId(AccountId.fromString(payer))
        .execute(client);

      if (isHbarAsset(asset)) {
        const payerTinybars = BigInt(balance.hbars.toTinybars().toString());
        if (payerTinybars < required) {
          return {
            ok: false,
            reason: "insufficient_balance",
            message: `payer has ${payerTinybars} tinybars, needs ${required}`,
          };
        }
        return { ok: true };
      }

      const tokenId = TokenId.fromString(asset);
      const payerTokenBal = balance.tokens?.get(tokenId);
      const held = payerTokenBal ? BigInt(payerTokenBal.toString()) : 0n;
      if (held < required) {
        return {
          ok: false,
          reason: "insufficient_balance",
          message: `payer holds ${held} of ${asset}, needs ${required}`,
        };
      }

      const payToInfo = await new AccountInfoQuery()
        .setAccountId(AccountId.fromString(payTo))
        .execute(client);
      const alreadyAssociated = payToInfo.tokenRelationships?.get(tokenId) !== undefined;
      if (alreadyAssociated) {
        return { ok: true };
      }
      const maxAuto = payToInfo.maxAutomaticTokenAssociations?.toNumber() ?? 0;
      if (maxAuto === -1) {
        return { ok: true };
      }
      const currentAuto = payToInfo.tokenRelationships
        ? Array.from(payToInfo.tokenRelationships.values()).filter(r => r.automaticAssociation)
            .length
        : 0;
      if (maxAuto > 0 && currentAuto < maxAuto) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: "pay_to_not_associated",
        message: `payTo ${payTo} is not associated with ${asset} and has no auto-association slots`,
      };
    } finally {
      client.close();
    }
  };
}
