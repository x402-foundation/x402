import {
  HEDERA_MAINNET_CAIP2,
  HEDERA_MAINNET_MIRROR_NODE_URL,
  HEDERA_TESTNET_CAIP2,
  HEDERA_TESTNET_MIRROR_NODE_URL,
} from "./constants";
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
 * Optional configuration for the default Mirror Node preflight implementation.
 */
export type HederaPreflightConfig = {
  /**
   * Mirror Node REST API base URL (no trailing slash). Defaults to the public
   * Mirror Node for the request's CAIP-2 network.
   */
  mirrorNodeUrl?: string;
};

/**
 * Account fields read from the Mirror Node `/accounts/{id}` endpoint.
 */
type MirrorAccount = {
  balance: { balance: number };
  max_automatic_token_associations: number;
};

/**
 * A token relationship entry from the Mirror Node `/accounts/{id}/tokens` endpoint.
 */
type MirrorTokenRelationship = {
  token_id: string;
  balance: number;
  automatic_association: boolean;
};

/**
 * Paged response from the Mirror Node `/accounts/{id}/tokens` endpoint.
 */
type MirrorTokensResponse = {
  tokens: MirrorTokenRelationship[];
  links: { next: string | null };
};

/**
 * Builds a `preflightTransfer` implementation backed by the Hedera Mirror Node
 * REST API.
 *
 * The Mirror Node is the reliable source for balance and token-association
 * data; consensus-node token queries no longer return that data dependably.
 * Checks that the payer holds enough of `asset` and that `payTo` is either
 * associated with `asset` or has an available auto-association slot.
 *
 * @param config - Optional Mirror Node configuration
 * @returns A function suitable for `FacilitatorHederaSigner.preflightTransfer`
 */
export function createHederaPreflightTransfer(
  config: HederaPreflightConfig = {},
): (params: HederaPreflightParams) => Promise<HederaPreflightResult> {
  return async ({ payer, payTo, asset, amount, network }) => {
    const baseUrl = config.mirrorNodeUrl ?? mirrorNodeUrlForNetwork(network);
    const required = BigInt(amount);

    if (isHbarAsset(asset)) {
      const account = await fetchJson<MirrorAccount>(
        `${baseUrl}/api/v1/accounts/${encodeURIComponent(payer)}`,
      );
      const held = BigInt(account.balance.balance);
      if (held < required) {
        return {
          ok: false,
          reason: "insufficient_balance",
          message: `payer has ${held} tinybars, needs ${required}`,
        };
      }
      return { ok: true };
    }

    const payerTokens = await fetchJson<MirrorTokensResponse>(
      `${baseUrl}/api/v1/accounts/${encodeURIComponent(payer)}/tokens?token.id=${encodeURIComponent(asset)}`,
    );
    const held = payerTokens.tokens[0] ? BigInt(payerTokens.tokens[0].balance) : 0n;
    if (held < required) {
      return {
        ok: false,
        reason: "insufficient_balance",
        message: `payer holds ${held} of ${asset}, needs ${required}`,
      };
    }

    if (await isPayToAssociated(baseUrl, payTo, asset)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "pay_to_not_associated",
      message: `payTo ${payTo} is not associated with ${asset} and has no auto-association slots`,
    };
  };
}

/**
 * Resolves the public Mirror Node base URL for a CAIP-2 network.
 *
 * @param network - CAIP-2 network identifier
 * @returns Mirror Node REST API base URL
 */
export function mirrorNodeUrlForNetwork(network: string): string {
  if (network === HEDERA_MAINNET_CAIP2) {
    return HEDERA_MAINNET_MIRROR_NODE_URL;
  }
  if (network === HEDERA_TESTNET_CAIP2) {
    return HEDERA_TESTNET_MIRROR_NODE_URL;
  }
  throw new Error(`Unsupported Hedera network: ${network}`);
}

/**
 * Determines whether `payTo` can receive `asset`: either it is already
 * associated, or it has a free auto-association slot.
 *
 * @param baseUrl - Mirror Node REST API base URL
 * @param payTo - Destination account id
 * @param asset - HTS token id
 * @returns True when a transfer of `asset` to `payTo` will not fail association
 */
async function isPayToAssociated(baseUrl: string, payTo: string, asset: string): Promise<boolean> {
  const direct = await fetchJson<MirrorTokensResponse>(
    `${baseUrl}/api/v1/accounts/${encodeURIComponent(payTo)}/tokens?token.id=${encodeURIComponent(asset)}`,
  );
  if (direct.tokens.length > 0) {
    return true;
  }

  const account = await fetchJson<MirrorAccount>(
    `${baseUrl}/api/v1/accounts/${encodeURIComponent(payTo)}`,
  );
  const maxAuto = account.max_automatic_token_associations;
  if (maxAuto === -1) {
    return true;
  }
  if (maxAuto === 0) {
    return false;
  }

  let consumed = 0;
  let next: string | null = `/api/v1/accounts/${payTo}/tokens`;
  while (next) {
    const page: MirrorTokensResponse = await fetchJson<MirrorTokensResponse>(`${baseUrl}${next}`);
    consumed += page.tokens.filter(token => token.automatic_association).length;
    if (consumed >= maxAuto) {
      return false;
    }
    next = page.links?.next ?? null;
  }
  return consumed < maxAuto;
}

/**
 * Fetches and parses a JSON response from the Mirror Node, throwing on a
 * non-2xx status so the scheme reports preflight failure.
 *
 * @param url - Fully-qualified Mirror Node URL
 * @returns Parsed JSON body
 */
export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Mirror Node request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}
