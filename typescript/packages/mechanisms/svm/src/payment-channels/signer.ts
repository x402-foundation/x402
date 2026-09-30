import { address, type Address, type Signature } from "@solana/kit";
import type { Network } from "@x402/core/types";

import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../signer";
import { createRpcClient } from "../utils";
import { fetchMaybeChannel } from "./generated/accounts/channel";

/** One signature touching an account, newest-first as returned by RPC. */
export type ChannelAccountSignature = {
  signature: string;
  /** RPC error for a failed transaction, or null when it succeeded. */
  err: unknown;
};

/**
 * {@link FacilitatorSvmSigner} narrowed to the caps payment-channel
 * facilitator work requires: reading a channel, a slot, and a blockhash, and
 * resolving a kit signer. Exact-only signers omit these methods, so they stay
 * off the base type. `upto` and batch settlement both use this set.
 *
 * History reads are optional and are not provided by {@link toFacilitatorSvmSigner}.
 * A batch facilitator with a receiver-authorizer store does not need them.
 * {@link channelHistoryReads} serves them from an RPC. A null `getTransaction`
 * means that open was pruned.
 */
export type PaymentChannelFacilitatorSigner = FacilitatorSvmSigner & {
  getAccountInfo: NonNullable<FacilitatorSvmSigner["getAccountInfo"]>;
  getLatestBlockhash: NonNullable<FacilitatorSvmSigner["getLatestBlockhash"]>;
  getSlot: NonNullable<FacilitatorSvmSigner["getSlot"]>;
  getSigner(feePayer: Address): FacilitatorSigningCapabilities;
  getSignaturesForAddress?(
    accountAddress: string,
    network: string,
    options?: { before?: string; limit?: number },
  ): Promise<readonly ChannelAccountSignature[]>;
  /** Confirmed transaction wire bytes (base64), or null when unknown. */
  getTransaction?(signature: string, network: string): Promise<string | null>;
};

const PAYMENT_CHANNEL_FACILITATOR_METHODS = [
  "getSigner",
  "getAccountInfo",
  "getLatestBlockhash",
  "getSlot",
] as const satisfies readonly (keyof PaymentChannelFacilitatorSigner)[];

/**
 * Assert a facilitator signer exposes every cap payment-channel facilitator
 * work needs.
 *
 * @param signer - Facilitator signer to validate
 * @param label - Component name for error messages
 * @throws Error when a required capability is missing
 */
export function assertPaymentChannelFacilitatorSigner(
  signer: FacilitatorSvmSigner,
  label: string,
): asserts signer is PaymentChannelFacilitatorSigner {
  for (const method of PAYMENT_CHANNEL_FACILITATOR_METHODS) {
    if (typeof signer[method] !== "function") {
      throw new Error(`${label} requires ${method} on the signer.`);
    }
  }
}

/**
 * Kit-compatible RPC adapter so generated account fetch helpers read through
 * the facilitator signer.
 *
 * @param signer - Payment-channel facilitator signer
 * @param network - CAIP-2 network identifier
 * @returns Minimal RPC surface for {@link fetchMaybeChannel}
 */
export function accountFetchRpc(
  signer: PaymentChannelFacilitatorSigner,
  network: string,
): Parameters<typeof fetchMaybeChannel>[0] {
  return {
    getAccountInfo: (
      accountAddress: Address,
      config?: { commitment?: string; encoding?: string },
    ) => ({
      send: async () => ({
        context: { slot: 0n },
        value: await signer.getAccountInfo(accountAddress.toString(), network, {
          commitment: config?.commitment,
          encoding: config?.encoding,
        }),
      }),
    }),
  } as Parameters<typeof fetchMaybeChannel>[0];
}

/** RPC that can page account signatures and return base64 transaction bytes. */
export type ChannelHistoryReads = {
  getSignaturesForAddress: NonNullable<PaymentChannelFacilitatorSigner["getSignaturesForAddress"]>;
  getTransaction: NonNullable<PaymentChannelFacilitatorSigner["getTransaction"]>;
};

/**
 * Read confirmed transaction history from an RPC.
 *
 * A network omitted from `rpcUrlByNetwork` uses the public cluster default.
 * That default does not promise to retain an open for the life of a channel.
 *
 * @param rpcUrlByNetwork - Optional full-history RPC URL per CAIP-2 network
 * @returns History reads for a {@link PaymentChannelFacilitatorSigner}
 */
export function channelHistoryReads(
  rpcUrlByNetwork: Partial<Record<string, string>> = {},
): ChannelHistoryReads {
  return {
    async getSignaturesForAddress(accountAddress, network, options) {
      const rpc = createRpcClient(network as Network, rpcUrlByNetwork[network]);
      const config: { before?: Signature; limit?: number } = {};
      if (options?.before !== undefined) config.before = options.before as Signature;
      if (options?.limit !== undefined) config.limit = options.limit;
      const page = await rpc.getSignaturesForAddress(address(accountAddress), config).send();
      return page.map(item => ({
        err: item.err,
        signature: String(item.signature),
      }));
    },
    async getTransaction(signature, network) {
      const result = await createRpcClient(network as Network, rpcUrlByNetwork[network])
        .getTransaction(signature as Signature, {
          commitment: "confirmed",
          encoding: "base64",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      if (!result) return null;
      const transaction = (result as { transaction?: unknown }).transaction;
      if (Array.isArray(transaction) && typeof transaction[0] === "string") {
        return transaction[0];
      }
      return null;
    },
  };
}
