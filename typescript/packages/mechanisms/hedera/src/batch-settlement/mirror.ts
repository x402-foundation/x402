import { fetchJson, isPayToAssociated, mirrorNodeUrlForNetwork } from "../preflight";
import { HEDERA_ENTITY_ID_REGEX } from "../constants";
import {
  isLongZeroAddress,
  longZeroAddressToEntityId,
  type MirrorAccountSummary,
} from "./addresses";

/** Mirror Node token allowance entry (`/accounts/{owner}/allowances/tokens`). */
type MirrorTokenAllowance = {
  amount: number | string;
  amount_granted: number | string;
  owner: string;
  spender: string;
  token_id: string;
};

/** Mirror Node contract result (`/contracts/results/{id}`) subset. */
export type MirrorContractResult = {
  hash: string;
  result: string;
  error_message: string | null;
  status: string;
  gas_used: number;
  logs: { address: string; topics: string[]; data: string }[];
};

/** Typed Mirror Node REST helpers used by the batch-settlement roles. */
export interface HederaMirrorNodeClient {
  readonly baseUrl: string;
  /** Account summary by id or EVM address. */
  getAccount(accountIdOrEvmAddress: string): Promise<MirrorAccountSummary>;
  /** Remaining HTS fungible-token allowance `owner` granted to `spender` (both ids or long-zero addresses). */
  getTokenAllowance(owner: string, spender: string, tokenId: string): Promise<bigint>;
  /** True when `account` is associated with `tokenId` or has a free auto-association slot. */
  canReceiveToken(accountIdOrEvmAddress: string, tokenId: string): Promise<boolean>;
  /** Contract execution result by Hedera transaction id or EVM hash. */
  getContractResult(transactionIdOrHash: string): Promise<MirrorContractResult>;
}

/** Options for {@link createHederaMirrorNodeClient}. */
export type HederaMirrorNodeClientOptions = {
  /** Explicit base URL; overrides `network`. */
  mirrorNodeUrl?: string;
  /** CAIP-2 network used to pick the public Mirror Node when `mirrorNodeUrl` is omitted. */
  network?: string;
};

/**
 * Normalizes an account reference (`0.0.x`, long-zero address, or alias) for Mirror Node paths.
 *
 * @param ref - Account id or EVM address.
 * @returns Value accepted by `/api/v1/accounts/{id}` style endpoints.
 */
function accountRef(ref: string): string {
  if (HEDERA_ENTITY_ID_REGEX.test(ref)) return ref;
  if (isLongZeroAddress(ref)) return longZeroAddressToEntityId(ref);
  return ref;
}

/**
 * Converts an id/address to an entity id for query parameters that only accept `0.0.x`.
 *
 * @param ref - Entity id or long-zero address.
 * @returns Entity id.
 */
function entityRef(ref: string): string {
  if (HEDERA_ENTITY_ID_REGEX.test(ref)) return ref;
  if (isLongZeroAddress(ref)) return longZeroAddressToEntityId(ref);
  throw new Error(`Expected a Hedera entity id or long-zero address, got ${ref}`);
}

/**
 * Creates a Mirror Node REST client.
 *
 * @param options - URL or network selection.
 * @returns Client instance.
 */
export function createHederaMirrorNodeClient(
  options: HederaMirrorNodeClientOptions = {},
): HederaMirrorNodeClient {
  const baseUrl =
    options.mirrorNodeUrl ??
    (options.network ? mirrorNodeUrlForNetwork(options.network) : undefined);
  if (!baseUrl) {
    throw new Error("createHederaMirrorNodeClient requires mirrorNodeUrl or network");
  }

  return {
    baseUrl,
    async getAccount(accountIdOrEvmAddress) {
      return fetchJson<MirrorAccountSummary>(
        `${baseUrl}/api/v1/accounts/${encodeURIComponent(accountRef(accountIdOrEvmAddress))}`,
      );
    },
    async getTokenAllowance(owner, spender, tokenId) {
      const spenderId = entityRef(spender);
      const page = await fetchJson<{ allowances: MirrorTokenAllowance[] }>(
        `${baseUrl}/api/v1/accounts/${encodeURIComponent(accountRef(owner))}/allowances/tokens?spender.id=${encodeURIComponent(spenderId)}&token.id=${encodeURIComponent(tokenId)}`,
      );
      const entry = page.allowances.find(a => a.token_id === tokenId && a.spender === spenderId);
      return entry ? BigInt(entry.amount) : 0n;
    },
    async canReceiveToken(accountIdOrEvmAddress, tokenId) {
      return isPayToAssociated(baseUrl, accountRef(accountIdOrEvmAddress), tokenId);
    },
    async getContractResult(transactionIdOrHash) {
      return fetchJson<MirrorContractResult>(
        `${baseUrl}/api/v1/contracts/results/${encodeURIComponent(transactionIdOrHash)}`,
      );
    },
  };
}
