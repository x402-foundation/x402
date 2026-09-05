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
  maxDeposit?: string;
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
 * Parses a server-announced `extra.minDeposit` when it is a valid deposit target.
 *
 * @param value - Wire value from payment requirement `extra`.
 * @param requestAmount - Per-request voucher amount in token base units.
 * @returns Parsed minimum deposit target, or `undefined` when invalid or below `requestAmount`.
 */
export function parseAnnouncedMinDeposit(
  value: unknown,
  requestAmount: bigint,
): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = BigInt(value);
  if (parsed <= 0n || parsed < requestAmount) {
    return undefined;
  }

  return parsed;
}

/**
 * Derives the deposit ceiling as `depositMultiplier ×` the resolved spend cap.
 *
 * @param maxAmountPerPayment - Atomic spend cap from payment payload context.
 * @param depositMultiplier - Policy multiplier (default 5).
 * @returns Atomic deposit ceiling, or `undefined` when the payment is uncapped.
 */
export function maxDepositFromSpendCap(
  maxAmountPerPayment: unknown,
  depositMultiplier = 5,
): bigint | undefined {
  if (
    typeof maxAmountPerPayment !== "string" ||
    !/^\d+$/.test(maxAmountPerPayment) ||
    BigInt(maxAmountPerPayment) <= 0n
  ) {
    return undefined;
  }
  return BigInt(maxAmountPerPayment) * BigInt(depositMultiplier);
}

/**
 * Clamps a computed deposit to `maxDeposit`. Throws when the voucher gap exceeds the cap.
 *
 * @param deposit - Proposed deposit in token base units.
 * @param needed - Minimum deposit to cover the next voucher.
 * @param maxDeposit - Atomic ceiling (`depositMultiplier ×` spend cap). Omitted when uncapped.
 * @returns Deposit amount string in token base units.
 */
export function applyMaxDeposit(deposit: bigint, needed: bigint, maxDeposit?: bigint): string {
  if (maxDeposit === undefined) {
    return deposit.toString();
  }
  if (needed > maxDeposit) {
    throw new Error(
      `Required deposit ${needed.toString()} exceeds depositMultiplier × spendControls.maxAmountPerPayment (${maxDeposit.toString()}). ` +
        `Raise maxAmountPerPayment or depositMultiplier.`,
    );
  }
  return (deposit > maxDeposit ? maxDeposit : deposit).toString();
}

/**
 * Computes the deposit amount from the voucher gap, server hint, or deposit multiplier.
 *
 * @param policy - Deposit policy controlling multiplier.
 * @param requestAmount - Amount requested for this operation, in token base units.
 * @param needed - Minimum deposit to cover the next voucher (`maxClaimableAmount - balance`).
 * @param extra - Payment requirement `extra` (may contain `minDeposit`).
 * @param maxDeposit - Atomic ceiling (`depositMultiplier ×` spend cap). Omitted when uncapped.
 * @returns Deposit amount string in token base units.
 */
export function depositAmountForRequest(
  policy: BatchSettlementDepositPolicy | undefined,
  requestAmount: bigint,
  needed: bigint,
  extra: Record<string, unknown> | undefined,
  maxDeposit?: bigint,
): string {
  const announced = parseAnnouncedMinDeposit(extra?.minDeposit, requestAmount);
  const multiplier = BigInt(policy?.depositMultiplier ?? 5);
  const target = announced ?? multiplier * requestAmount;
  const deposit = needed > target ? needed : target;
  return applyMaxDeposit(deposit, needed, maxDeposit);
}
