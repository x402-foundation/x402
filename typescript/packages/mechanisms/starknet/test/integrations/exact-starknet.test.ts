/**
 * Offline Starknet `exact` integration flow.
 *
 * Wires the reference client, resource server, and facilitator through the real
 * @x402/core classes against an in-memory Starknet node injected via the
 * facilitator's `providerFactory` seam, so the suite runs with no network.
 *
 * The mock node is a small state machine rather than a canned response table:
 * it decodes the `__execute__` calldata it is handed, applies SNIP-9
 * `execute_from_outside_v2` (caller binding + nonce consumption) and SNIP-2
 * `transfer` against real balances, verifies `is_valid_signature` with real
 * STARK ECDSA, and serves simulation traces, receipts, and event logs derived
 * from that state. A payment therefore only succeeds here if it would move
 * exactly the required tokens onchain.
 */
import { describe, expect, it } from "vitest";
import {
  OutsideExecutionVersion,
  ec,
  encode,
  hash,
  num,
  outsideExecution,
  transaction,
  typedData as snTypedData,
  type RpcProvider,
  type TypedData,
} from "starknet";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { type FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  STARKNET_ERROR_REASONS,
  STARKNET_SEPOLIA_CAIP2,
  TRANSFER_SELECTOR,
  USDC_SEPOLIA,
  VALID_SIGNATURE_MAGIC,
} from "../../src/constants";
import { ExactStarknetScheme as ExactStarknetClient } from "../../src/exact/client";
import { ExactStarknetScheme as ExactStarknetFacilitator } from "../../src/exact/facilitator";
import { ExactStarknetScheme as ExactStarknetServer } from "../../src/exact/server";
import type { ClientStarknetSigner, FacilitatorStarknetSigner } from "../../src/signer";
import type { OutsideExecutionTypedData } from "../../src/typed-data";
import { feltEquals } from "../../src/utils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK = STARKNET_SEPOLIA_CAIP2 as Network;
const ASSET = USDC_SEPOLIA;
const AMOUNT = "10000"; // 0.01 USDC (6 decimals)
const MAX_TIMEOUT_SECONDS = 300;

// Throwaway test keys. The payer holds tokens and no gas; the facilitator
// account is the announced feePayer and pays every settlement fee.
const PAYER_PRIVATE_KEY = "0x0578c3e35c9e4b3a2b1f4c8d9e0a1b2c3d4e5f60718293a4b5c6d7e8f9012345";
const PAYER = "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24";
const FEE_PAYER_PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FEE_PAYER = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
const PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";

const EXECUTE_FROM_OUTSIDE_SELECTOR = hash.getSelectorFromName("execute_from_outside_v2");
const TRANSFER_EVENT_KEY = hash.getSelectorFromName("Transfer");
const U128_MASK = (1n << 128n) - 1n;

const resource = {
  url: "https://example.com/weather",
  description: "Weather data",
  mimeType: "application/json",
};

// ---------------------------------------------------------------------------
// In-memory Starknet node
// ---------------------------------------------------------------------------

interface DecodedCall {
  to: string;
  selector: string;
  calldata: string[];
}

interface ChainEvent {
  from_address: string;
  keys: string[];
  data: string[];
}

interface ExecutionOutcome {
  events: ChainEvent[];
  revertReason?: string;
}

/**
 * Normalizes a felt to its numeric key. Starknet addresses have no canonical
 * padding or case, so raw strings are never safe map keys.
 *
 * @param felt - The felt value to normalize
 * @returns The felt's decimal representation
 */
function feltKey(felt: string): string {
  return BigInt(felt).toString();
}

/**
 * Decodes `[calls_len, (to, selector, calldata_len, ...calldata)*]` - the Cairo
 * 1 call-array serialization used by both `__execute__` and the SNIP-9 payload.
 *
 * @param felts - The felt array to read from
 * @param offset - Index of the `calls_len` felt
 * @returns The decoded calls
 */
function decodeCallArray(felts: string[], offset: number): DecodedCall[] {
  const count = Number(BigInt(felts[offset]));
  const calls: DecodedCall[] = [];
  let cursor = offset + 1;
  for (let i = 0; i < count; i++) {
    const length = Number(BigInt(felts[cursor + 2]));
    calls.push({
      to: num.toHex(BigInt(felts[cursor])),
      selector: num.toHex(BigInt(felts[cursor + 1])),
      calldata: felts.slice(cursor + 3, cursor + 3 + length).map(felt => num.toHex(BigInt(felt))),
    });
    cursor += 3 + length;
  }
  return calls;
}

/**
 * Decodes the SNIP-9 v2 `execute_from_outside_v2` calldata:
 * `[caller, nonce, execute_after, execute_before, calls..., signature...]`.
 *
 * @param calldata - The entry point calldata
 * @returns The bound caller, the nonce, and the authorized calls
 */
function decodeOutsideExecution(calldata: string[]): {
  caller: string;
  nonce: string;
  calls: DecodedCall[];
} {
  return {
    caller: num.toHex(BigInt(calldata[0])),
    nonce: num.toHex(BigInt(calldata[1])),
    calls: decodeCallArray(calldata, 4),
  };
}

/**
 * An in-memory Starknet node: account contracts, SNIP-2 token balances, SNIP-9
 * nonces, and the transaction / event history the facilitator reads back.
 */
class MockStarknetNode {
  private readonly balances = new Map<string, bigint>();
  private readonly publicKeys = new Map<string, string>();
  private readonly consumedNonces = new Set<string>();
  private readonly transactions = new Map<string, { calldata: string[]; reverted: boolean }>();
  private readonly emitted: Array<ChainEvent & { transaction_hash: string }> = [];

  /**
   * Deploys an account contract whose `is_valid_signature` accepts signatures
   * from the given key.
   *
   * @param address - The account contract address
   * @param privateKey - The key the account's owner signs with
   */
  deployAccount(address: string, privateKey: string): void {
    this.publicKeys.set(
      feltKey(address),
      encode.buf2hex(ec.starkCurve.getPublicKey(privateKey, false)),
    );
  }

  /**
   * Mints token balance to an address.
   *
   * @param address - The holder address
   * @param amount - The amount to credit in atomic units
   */
  credit(address: string, amount: bigint): void {
    this.balances.set(feltKey(address), this.balanceOf(address) + amount);
  }

  /**
   * Reads a token balance.
   *
   * @param address - The holder address
   * @returns The balance in atomic units
   */
  balanceOf(address: string): bigint {
    return this.balances.get(feltKey(address)) ?? 0n;
  }

  /**
   * Executes a signed OutsideExecution the way a funded facilitator account
   * would, and records the resulting transaction and events.
   *
   * @param sender - The account originating the INVOKE (the announced feePayer)
   * @param payer - The payer account the OutsideExecution runs on
   * @param typedData - The canonical OutsideExecution typed data
   * @param signature - The felt-array signature over that typed data
   * @returns The settlement transaction hash
   */
  settleOutsideExecution(
    sender: string,
    payer: string,
    typedData: OutsideExecutionTypedData,
    signature: string[],
  ): { transactionHash: string } {
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

    const calldata = transaction.getExecuteCalldata(calls, "1");
    const transactionHash = hash.computeHashOnElements(calldata);
    const outcome = this.run(sender, calldata, true);
    this.transactions.set(transactionHash, { calldata, reverted: Boolean(outcome.revertReason) });
    for (const event of outcome.events) {
      this.emitted.push({ ...event, transaction_hash: transactionHash });
    }
    return { transactionHash };
  }

  /**
   * Exposes the node through the read surface the facilitator uses. Structural
   * typing makes it interchangeable with a real RpcProvider.
   *
   * @returns The node as an RpcProvider
   */
  asProvider(): RpcProvider {
    return {
      getClassHashAt: async (address: string) => {
        if (!this.publicKeys.has(feltKey(address))) throw new Error("CONTRACT_NOT_FOUND");
        return "0x01a736d6ed154502257f02b1ccdf4d9d1089f80811cd6acad48e6b6a9d1f2003";
      },
      getContractVersion: async () => ({ cairo: "1" }),
      getNonceForAddress: async () => "0x1",
      getBlockNumber: async () => 1_000,
      callContract: async (call: {
        contractAddress: string;
        entrypoint: string;
        calldata: string[];
      }) => this.callContract(call),
      getSimulateTransaction: async (
        invocations: Array<{ contractAddress: string; calldata: string[] }>,
      ) => {
        const { contractAddress, calldata } = invocations[0];
        const outcome = this.run(contractAddress, calldata, false);
        return [
          {
            transaction_trace: {
              execute_invocation: {
                contract_address: contractAddress,
                revert_reason: outcome.revertReason,
                // Each Transfer is nested in a frame owned by the token, so the
                // facilitator has to attribute events to their emitter.
                calls: outcome.events.map(event => ({
                  contract_address: event.from_address,
                  events: [{ keys: event.keys, data: event.data }],
                })),
              },
            },
          },
        ];
      },
      waitForTransaction: async (transactionHash: string) => {
        if (!this.transactions.has(transactionHash)) throw new Error("TXN_HASH_NOT_FOUND");
        return {};
      },
      getTransactionReceipt: async (transactionHash: string) => {
        const settled = this.transactions.get(transactionHash);
        if (!settled) throw new Error("TXN_HASH_NOT_FOUND");
        return {
          execution_status: settled.reverted ? "REVERTED" : "SUCCEEDED",
          // A real receipt reports finality and block inclusion alongside the
          // execution status, and the facilitator requires both: a SUCCEEDED
          // status on a pending-block receipt is not yet a settled payment.
          finality_status: "ACCEPTED_ON_L2",
          block_number: 1_000,
          events: this.emitted
            .filter(event => event.transaction_hash === transactionHash)
            .map(({ from_address, keys, data }) => ({ from_address, keys, data })),
        };
      },
      getTransaction: async (transactionHash: string) => {
        const settled = this.transactions.get(transactionHash);
        if (!settled) throw new Error("TXN_HASH_NOT_FOUND");
        return { calldata: settled.calldata };
      },
      getEvents: async (filter: { address: string; keys: string[][] }) => ({
        events: this.emitted.filter(
          event =>
            feltEquals(event.from_address, filter.address) &&
            filter.keys.every((allowed, index) =>
              allowed.some(key => feltEquals(key, event.keys[index])),
            ),
        ),
        continuation_token: undefined,
      }),
    } as unknown as RpcProvider;
  }

  /**
   * Serves the three read entry points the facilitator calls on the payer's
   * account and on the token.
   *
   * @param call - The contract call to serve
   * @param call.contractAddress - The contract being read
   * @param call.entrypoint - The entry point name
   * @param call.calldata - The compiled entry point calldata
   * @returns The felt array the entry point returns
   */
  private callContract(call: {
    contractAddress: string;
    entrypoint: string;
    calldata: string[];
  }): string[] {
    const { contractAddress, entrypoint, calldata } = call;

    if (entrypoint === "is_valid_signature") {
      const publicKey = this.publicKeys.get(feltKey(contractAddress));
      if (!publicKey) throw new Error("CONTRACT_NOT_FOUND");
      const messageHash = `0x${BigInt(calldata[0]).toString(16).padStart(64, "0")}`;
      const signature = calldata.slice(2);
      if (signature.length !== 2) return ["0x0"];
      const parsed = new ec.starkCurve.Signature(BigInt(signature[0]), BigInt(signature[1]));
      return ec.starkCurve.verify(parsed, messageHash, publicKey)
        ? [VALID_SIGNATURE_MAGIC]
        : ["0x0"];
    }

    if (entrypoint === "is_valid_outside_execution_nonce") {
      return [this.consumedNonces.has(nonceKey(contractAddress, calldata[0])) ? "0x0" : "0x1"];
    }

    if (entrypoint === "balanceOf") {
      const balance = this.balanceOf(calldata[0]);
      return [num.toHex(balance & U128_MASK), num.toHex(balance >> 128n)];
    }

    throw new Error(`unexpected entrypoint ${entrypoint}`);
  }

  /**
   * Runs an `__execute__` calldata array from a sender. Simulation runs against
   * a copy of the state so it can never mutate the chain.
   *
   * @param sender - The address originating the INVOKE
   * @param calldata - The compiled `__execute__` calldata
   * @param commit - Whether to persist the resulting state changes
   * @returns The emitted events, or the reason execution reverted
   */
  private run(sender: string, calldata: string[], commit: boolean): ExecutionOutcome {
    const balances = commit ? this.balances : new Map(this.balances);
    const nonces = commit ? this.consumedNonces : new Set(this.consumedNonces);
    const events: ChainEvent[] = [];

    for (const call of decodeCallArray(calldata, 0)) {
      const revertReason = applyCall(call, sender, balances, nonces, events);
      if (revertReason) return { events: [], revertReason };
    }
    return { events };
  }
}

/**
 * Composes the SNIP-9 replay key from the account and its OutsideExecution
 * nonce.
 *
 * @param account - The account contract address
 * @param nonce - The SNIP-9 nonce
 * @returns The composite key
 */
function nonceKey(account: string, nonce: string): string {
  return `${feltKey(account)}:${feltKey(nonce)}`;
}

/**
 * Applies one call against the working state, recursing through
 * `execute_from_outside_v2` into the calls it authorizes.
 *
 * @param call - The call to apply
 * @param sender - The address the call originates from
 * @param balances - The working token balances
 * @param nonces - The working set of consumed SNIP-9 nonces
 * @param events - The event list to append to
 * @returns The revert reason, or undefined when the call succeeded
 */
function applyCall(
  call: DecodedCall,
  sender: string,
  balances: Map<string, bigint>,
  nonces: Set<string>,
  events: ChainEvent[],
): string | undefined {
  if (feltEquals(call.selector, EXECUTE_FROM_OUTSIDE_SELECTOR)) {
    const account = call.to;
    const authorization = decodeOutsideExecution(call.calldata);
    if (!feltEquals(authorization.caller, sender)) return "argent/invalid-caller";
    const key = nonceKey(account, authorization.nonce);
    if (nonces.has(key)) return "argent/duplicated-outside-nonce";
    nonces.add(key);
    // The account contract executes the authorized calls as itself.
    for (const inner of authorization.calls) {
      const revertReason = applyCall(inner, account, balances, nonces, events);
      if (revertReason) return revertReason;
    }
    return undefined;
  }

  if (feltEquals(call.selector, TRANSFER_SELECTOR)) {
    const recipient = call.calldata[0];
    const amount = BigInt(call.calldata[1]) + (BigInt(call.calldata[2]) << 128n);
    const balance = balances.get(feltKey(sender)) ?? 0n;
    if (balance < amount) return "u256_sub Overflow";
    balances.set(feltKey(sender), balance - amount);
    balances.set(feltKey(recipient), (balances.get(feltKey(recipient)) ?? 0n) + amount);
    events.push({
      from_address: call.to,
      keys: [TRANSFER_EVENT_KEY, sender, recipient],
      data: [num.toHex(amount & U128_MASK), num.toHex(amount >> 128n)],
    });
    return undefined;
  }

  return `ENTRYPOINT_NOT_FOUND ${call.selector}`;
}

// ---------------------------------------------------------------------------
// Signers and wiring
// ---------------------------------------------------------------------------

/**
 * Client signer for the mock payer account. The shipped
 * `toClientStarknetSigner` wraps a starknet.js Account, which needs a live
 * provider; this suite is offline, so it satisfies the same seam directly. The
 * live suite exercises the shipped helper.
 *
 * @returns A ClientStarknetSigner signing as the mock payer
 */
function mockClientSigner(): ClientStarknetSigner {
  return {
    address: PAYER,
    signMessage: (typedData: TypedData) => {
      const signature = ec.starkCurve.sign(
        snTypedData.getMessageHash(typedData, PAYER),
        PAYER_PRIVATE_KEY,
      );
      return [num.toHex(signature.r), num.toHex(signature.s)];
    },
  };
}

/**
 * Facilitator signer for the mock feePayer account. It announces exactly one
 * address and originates from it, the direct-executor shape
 * `toFacilitatorStarknetSigner` produces.
 *
 * @param node - The in-memory node settlement executes against
 * @returns A FacilitatorStarknetSigner settling through the mock feePayer
 */
function mockFacilitatorSigner(node: MockStarknetNode): FacilitatorStarknetSigner {
  return {
    getAddresses: () => [FEE_PAYER],
    getOriginationSenders: () => [FEE_PAYER],
    executeFromOutside: async ({ payer, typedData, signature }) =>
      node.settleOutsideExecution(FEE_PAYER, payer, typedData, signature),
  };
}

/**
 * In-process facilitator client that adapts the reference facilitator for the
 * resource server used in this suite.
 */
class StarknetFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = NETWORK;
  readonly x402Version = 2;

  /**
   * Creates the adapter around a configured x402 facilitator.
   *
   * @param facilitator - Facilitator with the Starknet exact scheme registered
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload through the wrapped facilitator.
   *
   * @param paymentPayload - x402 payment payload
   * @param paymentRequirements - Payment requirements
   * @returns Verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settles a payment payload through the wrapped facilitator.
   *
   * @param paymentPayload - x402 payment payload
   * @param paymentRequirements - Payment requirements
   * @returns Settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Reports the wrapped facilitator's supported kinds.
   *
   * @returns Supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

/**
 * Reads the OutsideExecution the payer signed out of an opaque x402 payload.
 *
 * @param paymentPayload - The payload the reference client produced
 * @returns The canonical SNIP-9 typed data carried by the payload
 */
function signedTypedData(paymentPayload: PaymentPayload): OutsideExecutionTypedData {
  const { typedData } = paymentPayload.payload.outsideExecution as {
    typedData: OutsideExecutionTypedData;
  };
  return typedData;
}

/**
 * Builds a funded node plus the client and resource server wired to it.
 *
 * @param signer - The facilitator signer to register, defaulting to the mock
 *   direct executor
 * @returns The node, the x402 client, and the initialized resource server
 */
async function buildFlow(
  signer?: FacilitatorStarknetSigner,
): Promise<{ node: MockStarknetNode; client: x402Client; server: x402ResourceServer }> {
  const node = new MockStarknetNode();
  node.deployAccount(PAYER, PAYER_PRIVATE_KEY);
  node.deployAccount(FEE_PAYER, FEE_PAYER_PRIVATE_KEY);
  node.credit(PAYER, 1_000_000n);

  const client = new x402Client().register(
    "starknet:*",
    new ExactStarknetClient(mockClientSigner()),
  );
  const facilitator = new x402Facilitator().register(
    NETWORK,
    new ExactStarknetFacilitator(signer ?? mockFacilitatorSigner(node), {
      providerFactory: () => node.asProvider(),
    }),
  );
  const server = new x402ResourceServer(new StarknetFacilitatorClient(facilitator));
  server.register("starknet:*", new ExactStarknetServer());
  await server.initialize();

  return { node, client, server };
}

/**
 * Runs the resource server's requirements build, which copies the
 * facilitator-advertised `extra.feePayer` verbatim.
 *
 * @param server - The initialized resource server
 * @returns The advertised payment requirements
 */
function buildRequirements(server: x402ResourceServer): Promise<PaymentRequirements[]> {
  return server.buildPaymentRequirements({
    scheme: "exact",
    network: NETWORK,
    payTo: PAY_TO,
    price: { amount: AMOUNT, asset: ASSET },
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Starknet exact integration - client / resource server / facilitator", () => {
  it("settles a client-signed OutsideExecution and moves exactly the required amount", async () => {
    const { node, client, server } = await buildFlow();

    const accepts = await buildRequirements(server);
    expect(accepts).toHaveLength(1);
    // A Starknet 402 cannot be served without a facilitator-advertised feePayer.
    expect(accepts[0].extra?.feePayer).toBe(FEE_PAYER);

    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(paymentPayload.x402Version).toBe(2);
    expect(paymentPayload.accepted.network).toBe(NETWORK);

    expect(paymentPayload.payload.from).toBe(PAYER);
    const typedData = signedTypedData(paymentPayload);
    expect(typedData.domain.name).toBe("Account.execute_from_outside");
    // The canonical builder normalizes felts to hex, so compare numerically.
    expect(BigInt(typedData.message.Caller)).toBe(BigInt(FEE_PAYER));
    expect(typedData.message.Calls).toHaveLength(1);
    expect(BigInt(typedData.message.Calls[0].To)).toBe(BigInt(ASSET));
    expect(typedData.message.Calls[0].Calldata.map(BigInt)).toEqual([
      BigInt(PAY_TO),
      BigInt(AMOUNT),
      0n,
    ]);

    const accepted = server.findMatchingRequirements(paymentRequired.accepts, paymentPayload);
    expect(accepted).toBeDefined();

    const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
    expect(verifyResponse.invalidReason).toBeUndefined();
    expect(verifyResponse.isValid).toBe(true);
    expect(verifyResponse.payer).toBe(PAYER);

    const payToBefore = node.balanceOf(PAY_TO);
    const settleResponse = await server.settlePayment(paymentPayload, accepted!);
    expect(settleResponse.success).toBe(true);
    expect(settleResponse.network).toBe(NETWORK);
    expect(settleResponse.payer).toBe(PAYER);
    expect(settleResponse.amount).toBe(AMOUNT);
    expect(settleResponse.transaction).toMatch(/^0x[0-9a-f]+$/);

    expect(node.balanceOf(PAY_TO) - payToBefore).toBe(BigInt(AMOUNT));
    expect(node.balanceOf(PAYER)).toBe(1_000_000n - BigInt(AMOUNT));
  });

  it("rejects a payload whose transfer amount was raised after signing", async () => {
    const { node, client, server } = await buildFlow();

    const accepts = await buildRequirements(server);
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    signedTypedData(paymentPayload).message.Calls[0].Calldata[1] = "999999";

    const accepted = server.findMatchingRequirements(paymentRequired.accepts, paymentPayload);
    expect(accepted).toBeDefined();

    const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
    expect(verifyResponse.isValid).toBe(false);
    expect(verifyResponse.invalidReason).toBe(STARKNET_ERROR_REASONS.AMOUNT_MISMATCH);

    const settleResponse = await server.settlePayment(paymentPayload, accepted!);
    expect(settleResponse.success).toBe(false);
    expect(settleResponse.errorReason).toBe(STARKNET_ERROR_REASONS.AMOUNT_MISMATCH);
    expect(node.balanceOf(PAY_TO)).toBe(0n);
    expect(node.balanceOf(PAYER)).toBe(1_000_000n);
  });

  it("rejects a payload whose nonce was swapped after signing", async () => {
    const { node, client, server } = await buildFlow();

    const accepts = await buildRequirements(server);
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    // The nonce is not covered by any requirements field, so only the account's
    // onchain signature check can catch this - the message hash no longer
    // matches what the payer signed.
    signedTypedData(paymentPayload).message.Nonce = "0x5ca1ab1e";

    const accepted = server.findMatchingRequirements(paymentRequired.accepts, paymentPayload);
    const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
    expect(verifyResponse.isValid).toBe(false);
    expect(verifyResponse.invalidReason).toBe(STARKNET_ERROR_REASONS.INVALID_SIGNATURE);

    const settleResponse = await server.settlePayment(paymentPayload, accepted!);
    expect(settleResponse.success).toBe(false);
    expect(node.balanceOf(PAY_TO)).toBe(0n);
  });

  it("rejects an immediate replay as a duplicate and pays exactly once", async () => {
    const { node, client, server } = await buildFlow();

    const accepts = await buildRequirements(server);
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const accepted = server.findMatchingRequirements(paymentRequired.accepts, paymentPayload);

    const first = await server.settlePayment(paymentPayload, accepted!);
    expect(first.success).toBe(true);

    // While the duplicate guard holds, every repeat - including one identical
    // to the settled payload - is rejected: answering success again would let a
    // single payment release the resource twice. Only one transfer ever lands.
    const replay = await server.settlePayment(paymentPayload, accepted!);
    expect(replay.success).toBe(false);
    expect(replay.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
    expect(node.balanceOf(PAY_TO)).toBe(BigInt(AMOUNT));
  });

  // Reproduction of the race the maintainer demonstrated against the XRPL
  // reference PR (10 parallel /settle calls with one signed payload, all
  // returning success). Exactly one settlement may win; every concurrent
  // duplicate must be rejected before it can broadcast, and exactly one
  // transfer may land.
  it("survives N parallel settlements of one signed payload (maintainer race test)", async () => {
    const { node, client, server } = await buildFlow();

    const accepts = await buildRequirements(server);
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const accepted = server.findMatchingRequirements(paymentRequired.accepts, paymentPayload);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => server.settlePayment(paymentPayload, accepted!)),
    );

    const successes = results.filter(r => r.success);
    const duplicates = results.filter(
      r => !r.success && r.errorReason === STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT,
    );
    expect(successes).toHaveLength(1);
    expect(duplicates).toHaveLength(9);
    expect(node.balanceOf(PAY_TO)).toBe(BigInt(AMOUNT));
    expect(node.balanceOf(PAYER)).toBe(1_000_000n - BigInt(AMOUNT));
  });

  // A Starknet exact kind without extra.feePayer is invalid, and core advertises
  // whatever kind is registered - so the unannounceable facilitator is rejected
  // at construction and can never reach /supported in the first place.
  it("refuses to build a facilitator that can announce no feePayer", () => {
    const keyless: FacilitatorStarknetSigner = {
      getAddresses: () => [],
      executeFromOutside: async () => {
        throw new Error("keyless facilitator cannot settle");
      },
    };
    expect(() => new ExactStarknetFacilitator(keyless)).toThrow(
      /must announce at least one feePayer/,
    );
  });

  // Defence in depth: even if a 402 without extra.feePayer reached a client from
  // some other implementation, the client refuses to spend a signature on it.
  it("refuses to sign a 402 that carries no feePayer", async () => {
    const { client, server } = await buildFlow();

    const accepts = await buildRequirements(server);
    const stripped = accepts.map(a => ({ ...a, extra: {} }));
    const paymentRequired = await server.createPaymentRequiredResponse(stripped, resource);

    await expect(client.createPaymentPayload(paymentRequired)).rejects.toThrow(
      "extra.feePayer is required",
    );
  });
});
