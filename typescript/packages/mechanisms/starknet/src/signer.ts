import {
  Account,
  OutsideExecutionVersion,
  PaymasterRpc,
  RpcProvider,
  TimeoutError,
  outsideExecution,
  type Signature,
  type TypedData,
} from "starknet";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  READ_BLOCK,
  getStarknetRpcUrl,
} from "./constants";
import type { OutsideExecutionTypedData } from "./typed-data";

/**
 * Client-side signer for the Starknet `exact` scheme. The client builds the
 * SNIP-9 OutsideExecution itself and signs its SNIP-12 typed data; any object
 * exposing the account address and a typed-data signer satisfies this seam.
 */
export interface ClientStarknetSigner {
  /**
   * The payer's account contract address.
   */
  readonly address: string;

  /**
   * Sign SNIP-12 typed data, returning the felt-array signature.
   *
   * @param typedData - The SNIP-12 typed data to sign
   * @returns The signature (felt array, or a starknet.js Signature)
   */
  signMessage(typedData: TypedData): Promise<Signature> | Signature;
}

/**
 * Facilitator-side signer for the Starknet `exact` scheme. It settles a signed
 * OutsideExecution by causing a call to `execute_from_outside_v2` on the payer's
 * account whose onchain caller is the announced `feePayer`. Whether that
 * happens via the facilitator's own funded account or a SNIP-29 paymaster /
 * forwarder is a facilitator-local detail hidden behind this seam.
 */
export interface FacilitatorStarknetSigner {
  /**
   * The `feePayer` addresses this facilitator can settle from. Each is a valid
   * value for `PaymentRequirements.extra.feePayer` and the SNIP-9 `Caller`.
   */
  getAddresses(): readonly string[];

  /**
   * The subset of `getAddresses()` this facilitator can originate a transaction
   * FROM, i.e. accounts it holds keys for. This is deliberately distinct from
   * `getAddresses()`: a forwarder contract is a valid `Caller` the payer's
   * account accepts, but nothing can send a transaction as it.
   *
   * Only these addresses may originate a verification simulation of the full
   * `execute_from_outside_v2` call tree. When the announced `feePayer` is not
   * one of them, verification deterministically falls back to simulating the
   * inner transfer from the payer (spec rule 8). Omitting this method means the
   * signer originates from none of its announced addresses.
   *
   * @returns The originatable account addresses
   */
  getOriginationSenders?(): readonly string[];

  /**
   * The accounts that actually sign the settlement INVOKE, for the `/supported`
   * `signers` map. Equals `getAddresses()` in the direct-executor case, but on
   * the paymaster path the announced feePayer is a forwarder CONTRACT that can
   * never sign anything - the relayer behind it does. Omit when the two
   * coincide.
   *
   * @returns The signing account addresses
   */
  getSettlementSigners?(): readonly string[];

  /**
   * Broadcast a signed OutsideExecution, returning the settlement transaction
   * hash. Does not wait for confirmation.
   *
   * The returned hash MUST settle this authorization alone. An implementation
   * that batches several authorizations into one transaction breaks two
   * guarantees the facilitator relies on: the receipt is then checked for
   * exactly one payer-sent `Transfer` and would show several, and a hash is
   * bound to a single (payer, nonce), so the second authorization sharing it is
   * refused. Both fail in the safe direction - a landed payment reported as
   * unpaid - but the payment is still lost to the merchant, so do not batch.
   *
   * @param params - The settlement inputs
   * @param params.payer - The payer's account contract address
   * @param params.typedData - The canonical OutsideExecution typed data
   * @param params.signature - The felt-array signature over the typed data
   * @param network - The CAIP-2 network identifier
   * @returns The broadcast transaction hash, settling only this authorization
   */
  executeFromOutside(
    params: { payer: string; typedData: OutsideExecutionTypedData; signature: string[] },
    network: string,
  ): Promise<{ transactionHash: string }>;
}

/**
 * Creates a client signer from a starknet.js Account.
 *
 * @param account - The payer's Account
 * @returns A ClientStarknetSigner wrapping the account
 */
export function toClientStarknetSigner(account: Account): ClientStarknetSigner {
  return {
    address: account.address,
    signMessage: (typedData: TypedData) => account.signMessage(typedData),
  };
}

/**
 * Configuration for a SNIP-29 paymaster-backed facilitator signer.
 */
export interface PaymasterFacilitatorConfig {
  /**
   * The `feePayer` addresses to announce. Onchain these are the SNIP-9 `Caller`
   * of the settled OutsideExecution (the paymaster's forwarder contract).
   */
  feePayerAddresses: string[];

  /**
   * The SNIP-29 paymaster JSON-RPC URL.
   */
  paymasterUrl: string;

  /**
   * The paymaster API key, sent as the `x-paymaster-api-key` header.
   */
  paymasterApiKey?: string;

  /**
   * The relayer accounts the paymaster signs settlement transactions with, if
   * known. Advertised in the `/supported` `signers` map, where the announced
   * forwarder would be misleading because it can never sign.
   */
  relayerAddresses?: string[];

  /**
   * Per-request timeout for paymaster calls, in milliseconds. Defaults to
   * 15000; must be a positive integer no greater than 2147483647.
   */
  timeoutMs?: number;
}

/**
 * Creates a facilitator signer backed by a SNIP-29 applicative paymaster in
 * sponsored fee mode. The paymaster submits `execute_from_outside_v2` on the
 * payer's account; the payer never needs gas funds.
 *
 * The announced addresses are the paymaster's forwarder contracts, so this
 * signer originates from none of them: verification simulates the inner
 * transfer from the payer instead of the full call tree.
 *
 * @param config - The feePayer addresses and paymaster connection settings
 * @returns A FacilitatorStarknetSigner that settles via the paymaster
 */
export function toFacilitatorStarknetPaymasterSigner(
  config: PaymasterFacilitatorConfig,
): FacilitatorStarknetSigner {
  const { feePayerAddresses, paymasterUrl, paymasterApiKey, relayerAddresses, timeoutMs } = config;
  if (feePayerAddresses.length === 0) {
    throw new Error("At least one feePayer address is required");
  }

  const paymaster = new PaymasterRpc({
    nodeUrl: paymasterUrl,
    headers: paymasterApiKey ? { "x-paymaster-api-key": paymasterApiKey } : undefined,
    baseFetch: timeoutFetch(resolveTimeoutMs(timeoutMs)),
  });

  return {
    getAddresses: () => [...feePayerAddresses],

    // The forwarder cannot sign; the paymaster's relayer does, and its address
    // is not knowable from here. Advertise nothing rather than a contract that
    // will never appear as a transaction sender.
    getSettlementSigners: () => (relayerAddresses ? [...relayerAddresses] : []),

    executeFromOutside: async ({ payer, typedData, signature }) => {
      const result = await paymaster.executeTransaction(
        {
          type: "invoke",
          invoke: { userAddress: payer, typedData, signature },
        },
        { version: "0x1", feeMode: { mode: "sponsored" } },
      );
      const transactionHash = result.transaction_hash;
      if (!transactionHash) {
        throw new Error("Paymaster did not return transaction_hash");
      }
      return { transactionHash };
    },
  };
}

/**
 * Creates a facilitator signer that settles from its own funded account. The
 * account calls `execute_from_outside_v2` on the payer directly, so it is both
 * the announced `feePayer` and the account transactions originate from - which
 * lets verification simulate the full call tree rather than the inner transfer.
 *
 * @param account - The facilitator's funded Starknet Account
 * @param options - Optional settings
 * @param options.tip - Transaction tip in FRI; defaults to none. starknet v8
 *   would otherwise estimate one from recent blocks on every settlement.
 * @returns A FacilitatorStarknetSigner that settles from that account
 */
export function toFacilitatorStarknetSigner(
  account: Account,
  options?: { tip?: bigint },
): FacilitatorStarknetSigner {
  return {
    getAddresses: () => [account.address],
    getOriginationSenders: () => [account.address],

    executeFromOutside: async ({ payer, typedData, signature }) => {
      const calls = outsideExecution.buildExecuteFromOutsideCall({
        outsideExecution: {
          caller: typedData.message.Caller,
          nonce: typedData.message.Nonce,
          execute_after: Number(typedData.message["Execute After"]),
          execute_before: Number(typedData.message["Execute Before"]),
          calls: typedData.message.Calls.map(call => ({
            to: call.To,
            selector: call.Selector,
            calldata: call.Calldata,
          })),
        },
        signature,
        signerAddress: payer,
        version: OutsideExecutionVersion.V2,
      });
      // starknet v8 estimates a tip from recent blocks unless one is given, so
      // an unset tip is a silent, market-priced surcharge on every settlement.
      // Default to none and let the operator opt in deliberately.
      const { transaction_hash: transactionHash } = await account.execute(calls, {
        tip: options?.tip ?? 0n,
      });
      if (!transactionHash) {
        throw new Error("Settlement transaction returned no transaction hash");
      }
      return { transactionHash };
    },
  };
}

/**
 * Resolve a caller-supplied timeout, rejecting values `AbortSignal.timeout`
 * cannot honor. Validated at construction rather than per request, so a
 * misconfiguration surfaces at startup instead of as requests that abort at
 * once.
 *
 * @param timeoutMs - The configured timeout, if any
 * @returns The timeout to apply, in milliseconds
 */
export function resolveTimeoutMs(timeoutMs?: number): number {
  const resolved = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `timeoutMs must be a positive integer number of milliseconds no greater than ${MAX_REQUEST_TIMEOUT_MS}, got ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Wraps fetch so every request carries its own timeout, covering the response
 * body as well as the headers.
 *
 * The abort is re-thrown as starknet's `TimeoutError` rather than left as the
 * platform's `DOMException`. Both RpcChannel and PaymasterRpc funnel every
 * rejection through an error handler that rethrows only `LibraryError` and
 * rewraps everything else as `Error(message)` - which erases the name a caller
 * would use to tell "the request timed out, outcome unknown" apart from "the
 * request definitively failed". `TimeoutError` extends `LibraryError`, so it
 * survives that handler intact. The body is read here, inside the timed scope,
 * because starknet.js reads it after this returns: an abort that fired
 * mid-stream would otherwise surface there, outside this catch, with its name
 * erased.
 *
 * @param timeoutMs - The per-request budget in milliseconds
 * @returns A fetch implementation that aborts once the budget elapses
 */
function timeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    // Never drop a caller-supplied signal: doing so would make an upstream
    // cancellation silently unobservable.
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await fetch(input, { ...init, signal });
      const body = await response.arrayBuffer();
      // An empty body is passed as null: a 204/205/304 may not carry a body
      // object at all, even an empty one.
      return new Response(body.byteLength === 0 ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new TimeoutError(`request exceeded ${timeoutMs}ms`);
      }
      throw error;
    }
  };
}

/**
 * Creates a read-only RpcProvider for a network.
 *
 * @param network - The CAIP-2 network identifier
 * @param rpcUrl - Optional custom RPC URL
 * @param timeoutMs - Per-request timeout in milliseconds. Defaults to 15000;
 *   must be a positive integer no greater than 2147483647
 * @returns An RpcProvider for the network
 */
export function createStarknetProvider(
  network: string,
  rpcUrl?: string,
  timeoutMs?: number,
): RpcProvider {
  return new RpcProvider({
    nodeUrl: rpcUrl ?? getStarknetRpcUrl(network),
    baseFetch: timeoutFetch(resolveTimeoutMs(timeoutMs)),
    // Pin the channel default too, not just the explicit reads: Account.execute
    // and the fee estimator issue their own reads (getNonce, getClassAt) with no
    // block argument. starknet v8 already defaults to `latest`, so this is a
    // deliberate, verifiable pin rather than a fix - it keeps the read block one
    // value the whole package agrees on, and stops a future SDK default from
    // silently reintroducing pre-confirmed reads.
    blockIdentifier: READ_BLOCK,
  });
}
