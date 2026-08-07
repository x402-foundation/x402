import type { PaymentRequirements } from "@x402/core/types";
import type { ClientEvmSigner } from "../../signer";
import type { EvmSchemeOptions } from "../../shared/rpc";
import type { ChannelConfig } from "../types";
import { type ClientChannelStorage, InMemoryClientChannelStorage } from "./storage";
import type { BatchSettlementClientContext } from "./storage";

const DEFAULT_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Caller-tunable policy controlling how the client sizes channel deposits.
 */
export interface BatchSettlementDepositPolicy {
  depositMultiplier?: number;
}

/**
 * Return shape for custom deposit sizing.
 */
export type BatchSettlementDepositStrategyResult = string | bigint | false | undefined;

/**
 * Information supplied before the client signs a deposit authorization.
 */
export interface BatchSettlementDepositStrategyContext {
  paymentRequirements: PaymentRequirements;
  channelConfig: ChannelConfig;
  channelId: `0x${string}`;
  clientContext: BatchSettlementClientContext;
  requestAmount: string;
  maxClaimableAmount: string;
  currentBalance: string;
  minimumDepositAmount: string;
  depositAmount: string;
}

/**
 * Custom deposit sizing callback for initial deposits and top-ups.
 */
export type BatchSettlementDepositStrategy = (
  context: BatchSettlementDepositStrategyContext,
) => BatchSettlementDepositStrategyResult | Promise<BatchSettlementDepositStrategyResult>;

/**
 * Full options object accepted by `BatchSettlementEvmScheme`. Either this or a
 * bare {@link BatchSettlementDepositPolicy} can be passed as the second
 * constructor argument.
 */
export interface BatchSettlementEvmSchemeOptions {
  depositPolicy?: BatchSettlementDepositPolicy;
  /** Optional callback for app-specific deposit sizing or skipping. */
  depositStrategy?: BatchSettlementDepositStrategy;
  storage?: ClientChannelStorage;
  salt?: `0x${string}`;
  payerAuthorizer?: `0x${string}`;
  rpcUrl?: string;
  /** When set, EIP-712 vouchers are signed with this key; deposits still use the main `signer`. */
  voucherSigner?: ClientEvmSigner;
}

/**
 * Resolved options after merging defaults — used internally by the scheme,
 * recovery, and refund modules.
 */
export interface ResolvedClientOptions {
  depositPolicy?: BatchSettlementDepositPolicy;
  depositStrategy?: BatchSettlementDepositStrategy;
  storage: ClientChannelStorage;
  salt: `0x${string}`;
  payerAuthorizer?: `0x${string}`;
  voucherSigner?: ClientEvmSigner;
  extensionRpcOptions?: EvmSchemeOptions;
}

/**
 * Discriminates a full options object from a bare deposit-policy object.
 *
 * @param o - Constructor argument that may be options, deposit policy only, or undefined.
 * @returns `true` when `o` is a {@link BatchSettlementEvmSchemeOptions} object.
 */
export function isBatchSettlementEvmSchemeOptions(
  o: BatchSettlementEvmSchemeOptions | BatchSettlementDepositPolicy | undefined,
): o is BatchSettlementEvmSchemeOptions {
  return (
    o !== undefined &&
    typeof o === "object" &&
    ("storage" in o ||
      "depositPolicy" in o ||
      "depositStrategy" in o ||
      "salt" in o ||
      "payerAuthorizer" in o ||
      "rpcUrl" in o ||
      "voucherSigner" in o)
  );
}

/**
 * Normalises the constructor's second argument into a uniform options shape.
 *
 * @param second - Optional second constructor argument (options or deposit policy).
 * @returns Resolved storage, salt, deposit policy, and optional payer authorizer.
 */
export function resolveClientOptions(
  second?: BatchSettlementEvmSchemeOptions | BatchSettlementDepositPolicy,
): ResolvedClientOptions {
  if (second === undefined) {
    return { storage: new InMemoryClientChannelStorage(), salt: DEFAULT_SALT };
  }
  if (isBatchSettlementEvmSchemeOptions(second)) {
    return {
      storage: second.storage ?? new InMemoryClientChannelStorage(),
      depositPolicy: second.depositPolicy,
      depositStrategy: second.depositStrategy,
      salt: second.salt ?? DEFAULT_SALT,
      payerAuthorizer: second.payerAuthorizer,
      voucherSigner: second.voucherSigner,
      extensionRpcOptions: second.rpcUrl ? { rpcUrl: second.rpcUrl } : undefined,
    };
  }
  return {
    storage: new InMemoryClientChannelStorage(),
    depositPolicy: second,
    salt: DEFAULT_SALT,
  };
}

/**
 * Validates a {@link BatchSettlementDepositPolicy}, throwing on invalid fields.
 *
 * @param policy - The policy to validate (no-op when undefined).
 */
export function validateDepositPolicy(policy: BatchSettlementDepositPolicy | undefined): void {
  if (!policy) return;

  const m = policy.depositMultiplier;
  if (m !== undefined && (!Number.isInteger(m) || m < 3)) {
    throw new Error("depositMultiplier must be an integer >= 3");
  }
}

/**
 * Computes the deposit amount based on the deposit multiplier.
 *
 * @param policy - Deposit policy controlling multiplier (may be undefined).
 * @param requestAmount - Amount requested for this operation, in token base units.
 * @returns Deposit amount string in token base units.
 */
export function depositAmountForRequest(
  policy: BatchSettlementDepositPolicy | undefined,
  requestAmount: bigint,
): string {
  const mult = BigInt(policy?.depositMultiplier ?? 5);
  return (mult * requestAmount).toString();
}
