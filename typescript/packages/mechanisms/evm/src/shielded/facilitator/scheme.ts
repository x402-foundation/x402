import type {
  PaymentPayload,
  PaymentRequirements,
  Network,
} from "@x402/core/types";
import type { SchemeNetworkFacilitator } from "@x402/core/types/mechanisms";
import type { VerifyResponse, SettleResponse } from "@x402/core/types/facilitator";
import type {
  ShieldedPayload,
  ShieldedProvider,
  ShieldedFacilitatorConfig,
  ReplayStore,
} from "../types.js";
import { TRANSFER_EVENT_TOPIC } from "../constants.js";
import {
  INVALID_TX_HASH,
  TRANSACTION_NOT_FOUND,
  TRANSACTION_REVERTED,
  NO_MATCHING_TRANSFER,
  TX_ALREADY_USED,
} from "./errors.js";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

class MemoryReplayStore implements ReplayStore {
  private used = new Set<string>();
  has(key: string) { return this.used.has(key); }
  add(key: string) { this.used.add(key); }
}

function getChainId(network: string): number {
  return parseInt(network.split(":")[1], 10);
}

export class ShieldedEvmFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "eip155:*";

  private provider: ShieldedProvider;
  private poolContracts: Record<number, string[]>;
  private replayStore: ReplayStore;

  constructor(config: ShieldedFacilitatorConfig) {
    this.provider = config.provider;
    this.poolContracts = config.poolContracts;
    this.replayStore = config.replayStore ?? new MemoryReplayStore();
  }

  getExtra(network: string): Record<string, unknown> | undefined {
    const chainId = getChainId(network);
    const pools = this.poolContracts[chainId];
    if (!pools || pools.length === 0) return undefined;
    return {
      assetTransferMethod: "shielded",
      poolContracts: pools,
    };
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const raw = payload.payload as ShieldedPayload;
    const txHash = raw?.txHash ?? "";

    // 1. Validate txHash format
    if (!TX_HASH_RE.test(txHash)) {
      return { isValid: false, invalidReason: INVALID_TX_HASH };
    }

    // 2. Check replay
    if (await this.replayStore.has(txHash)) {
      return { isValid: false, invalidReason: TX_ALREADY_USED };
    }

    // 3. Fetch receipt
    let receipt;
    try {
      receipt = await this.provider.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      return { isValid: false, invalidReason: TRANSACTION_NOT_FOUND };
    }

    if (!receipt) {
      return { isValid: false, invalidReason: TRANSACTION_NOT_FOUND };
    }

    // 4. Non-reverted = ZK proof was accepted by pool contract
    if (receipt.status === "reverted") {
      return { isValid: false, invalidReason: TRANSACTION_REVERTED };
    }

    // 5. Find matching Transfer event
    const chainId = getChainId(requirements.network);
    const pools = (
      (requirements.extra?.poolContracts as string[]) ??
      this.poolContracts[chainId] ??
      []
    ).map((a) => a.toLowerCase());

    const asset = requirements.asset.toLowerCase();
    const payTo = requirements.payTo.toLowerCase();
    const requiredAmount = BigInt(requirements.amount);

    let matchedPool: string | undefined;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== asset) continue;
      if (log.topics[0] !== TRANSFER_EVENT_TOPIC) continue;
      if (log.topics.length < 3) continue;

      const from = "0x" + log.topics[1].slice(26).toLowerCase();
      const to = "0x" + log.topics[2].slice(26).toLowerCase();
      const value = BigInt(log.data);

      if (pools.includes(from) && to === payTo && value >= requiredAmount) {
        matchedPool = from;
        break;
      }
    }

    if (!matchedPool) {
      return { isValid: false, invalidReason: NO_MATCHING_TRANSFER };
    }

    // 6. Mark txHash as used
    await this.replayStore.add(txHash);

    // 7. Track nullifiers if provided (defense-in-depth on top of on-chain nullifier set)
    const nullifiers = raw.nullifiers ?? [];
    for (const nullifier of nullifiers) {
      if (await this.replayStore.has(`nullifier:${nullifier}`)) {
        return { isValid: false, invalidReason: TX_ALREADY_USED };
      }
      await this.replayStore.add(`nullifier:${nullifier}`);
    }

    return { isValid: true, payer: matchedPool };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    // Re-verify before settling (follows SVM/EVM exact pattern)
    const valid = await this.verify(payload, requirements);
    if (!valid.isValid) {
      // If re-verify fails with tx_already_used, that's expected — we already
      // verified this payment. The replay store correctly prevents double-verify,
      // but for settle we just need to confirm it was previously verified.
      if (valid.invalidReason !== TX_ALREADY_USED) {
        return {
          success: false,
          transaction: "",
          network: requirements.network as Network,
          errorReason: valid.invalidReason,
          payer: valid.payer ?? "",
        };
      }
    }

    // Client-driven settlement — no on-chain action from facilitator
    const raw = payload.payload as ShieldedPayload;
    return {
      success: true,
      transaction: raw.txHash,
      network: requirements.network as Network,
      payer: valid.payer ?? "",
    };
  }
}
