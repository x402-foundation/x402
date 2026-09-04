/**
 * Settlement simulation (x402 v2 / SNIP-9).
 *
 * Proves the payment would move exactly `amount` from the payer to `payTo` on
 * `asset` and nothing else, via starknet_simulateTransactions (skip-validate,
 * skip-fee-charge, v3 INVOKE).
 *
 * Path selection is DETERMINISTIC and non-poisonable - no shared cache, no
 * revert-string heuristics:
 *
 *  - Full-topology: the bound Caller calls execute_from_outside_v2 on the payer.
 *    Possible only when that Caller is an account the facilitator holds keys
 *    for, since nothing else satisfies the payer account's caller check. Any
 *    revert here is a real payment failure.
 *
 *  - Inner-transfer fallback: when the Caller is an address the facilitator
 *    cannot originate a transaction from (a forwarder contract, which cannot
 *    send an INVOKE at all), full-topology simulation is structurally
 *    impossible. We instead simulate the exact `transfer` from the payer. This
 *    proves the transfer itself succeeds for the exact amount; the signature,
 *    nonce, caller, and time window are verified individually by the caller,
 *    and the executing sponsor/paymaster performs its own full-topology
 *    estimation at settlement. Residual risk is gas spent on a reverted
 *    settlement, never fund loss.
 */

import {
  outsideExecution,
  transaction,
  RpcError,
  TransactionType,
  OutsideExecutionVersion,
  type Call,
} from "starknet";
import type { PaymentRequirements } from "@x402/core/types";
import { READ_BLOCK, TRANSFER_EVENT_SELECTOR } from "../../constants";
import type { CanonicalOutsideExecutionMessage } from "../../typed-data";
import { feltEquals } from "../../utils";

/**
 * Minimal read surface of a Starknet RPC provider used by the settlement
 * simulation. An RpcProvider satisfies this structurally.
 */
export interface SimulationProvider {
  getClassHashAt(address: string, blockIdentifier?: string): Promise<string>;
  getNonceForAddress(address: string, blockIdentifier?: string): Promise<string>;
  getContractVersion(
    address: string,
    classHash?: undefined,
    options?: { blockIdentifier?: string },
  ): Promise<{ cairo?: string }>;
  getSimulateTransaction(
    invocations: unknown[],
    options?: { blockIdentifier?: string; skipValidate?: boolean; skipFeeCharge?: boolean },
  ): Promise<unknown>;
}

/**
 * Options controlling which senders the simulation may originate from.
 */
export interface SimulationOptions {
  /**
   * Accounts the facilitator holds keys for, so can originate a transaction
   * from. A permitted `Caller` that is not one of these (a forwarder contract)
   * cannot send anything, so the full call tree is not simulable from it.
   */
  originationSenders?: readonly string[];
}

/**
 * Outcome of a settlement simulation: either it proved the exact transfer, or
 * it failed with a diagnostic reason.
 */
export type SimulationResult =
  | { ok: true }
  | { ok: false; reason: string }
  /**
   * The simulation could not be performed - a node fault, not a verdict about
   * the payment. Kept distinct so the caller can report a retryable error
   * instead of blaming the payer for the facilitator's own infrastructure.
   */
  | { ok: false; fault: true; reason: string };

interface TraceEvent {
  from_address?: string;
  keys?: string[];
  data?: string[];
}

interface TraceInvocation {
  contract_address?: string;
  revert_reason?: string;
  events?: TraceEvent[];
  calls?: TraceInvocation[];
}

interface EmittedTraceEvent extends TraceEvent {
  /** The frame's contract_address (trace events carry no from_address themselves) */
  emitter?: string;
}

/**
 * Simulate the settlement and prove it moves exactly the required transfer.
 *
 * Prefers the full execute_from_outside_v2 topology from a controllable sender;
 * when the bound Caller is a forwarder the facilitator cannot originate from,
 * falls back to simulating the inner transfer directly from the payer.
 *
 * @param provider - The Starknet read provider
 * @param message - The canonical OutsideExecution message, as hashed and signed
 * @param signature - The felt-array signature over the canonical typed data
 * @param payer - The payer account contract address
 * @param requirements - The payment requirements (asset, payTo, amount)
 * @param options - The accounts the facilitator can originate a transaction from
 * @returns Ok when the exact transfer is proven, otherwise a failure reason
 */
export async function simulateSettlement(
  provider: SimulationProvider,
  message: CanonicalOutsideExecutionMessage,
  signature: string[],
  payer: string,
  requirements: PaymentRequirements,
  options?: SimulationOptions,
): Promise<SimulationResult> {
  const originationSenders = options?.originationSenders ?? [];
  const caller = message.Caller;

  // Can we simulate the real execute_from_outside_v2 topology? Only when the
  // bound Caller is an account we can originate a transaction from, since the
  // payer's account checks the caller. ANY_CALLER never reaches here: rule 1
  // rejects it as a feePayer before verification simulates.
  const canWrapperSimulate = originationSenders.some(s => feltEquals(caller, s));

  if (canWrapperSimulate) {
    const call = outsideExecution.buildExecuteFromOutsideCall({
      outsideExecution: {
        caller,
        nonce: message.Nonce,
        execute_after: Number(message["Execute After"]),
        execute_before: Number(message["Execute Before"]),
        calls: message.Calls.map(c => ({
          to: c.To,
          selector: c.Selector,
          calldata: c.Calldata,
        })),
      },
      signature,
      signerAddress: payer,
      version: OutsideExecutionVersion.V2,
    });

    // The bound Caller is the only sender that satisfies the payer account's
    // caller check, and we just established we can originate from it.
    const result = await simulateInvoke(provider, caller, call, payer, requirements);
    if (result.outcome === "ok") return { ok: true };
    if (result.outcome === "payment-failure") return { ok: false, reason: result.reason };
    // Fault or structural: the announced sender is not a usable account, or the
    // node would not say. Either is a fact about this facilitator, not about the
    // payment - and a feePayer the facilitator cannot settle through must not
    // verify (spec rule 1), so neither buys the weaker inner-transfer evidence.
    return { ok: false, fault: true, reason: result.reason };
  }

  // Inner-transfer fallback: simulate the exact transfer directly from the payer.
  const inner = message.Calls[0];
  const transferCall = [
    {
      contractAddress: inner.To,
      entrypoint: "transfer",
      calldata: inner.Calldata,
    },
  ];
  const fallback = await simulateInvoke(provider, payer, transferCall, payer, requirements);
  if (fallback.outcome === "ok") return { ok: true };
  if (fallback.outcome === "fault") return { ok: false, fault: true, reason: fallback.reason };
  return {
    ok: false,
    reason:
      fallback.outcome === "payment-failure"
        ? fallback.reason
        : `inner-transfer simulation unavailable: ${fallback.reason}`,
  };
}

type InvokeSimulationOutcome =
  | { outcome: "ok" }
  | { outcome: "payment-failure"; reason: string }
  | { outcome: "structural"; reason: string }
  | { outcome: "fault"; reason: string };

/**
 * Simulate a single v3 INVOKE from `sender` and classify the outcome.
 *
 * Distinguishes a real payment failure (revert or unexpected transfers) from a
 * structural problem with the sender itself (not deployed / not an account) and
 * from a node that did not answer, so the caller can report each as what it is.
 *
 * @param provider - The Starknet read provider
 * @param sender - The address originating the simulated INVOKE
 * @param call - The call array to execute
 * @param payer - The payer account contract address
 * @param requirements - The payment requirements (asset, payTo, amount)
 * @returns The classified simulation outcome
 */
async function simulateInvoke(
  provider: SimulationProvider,
  sender: string,
  call: Call[],
  payer: string,
  requirements: PaymentRequirements,
): Promise<InvokeSimulationOutcome> {
  let cairoVersion: string | undefined;
  let nonce: string;
  try {
    await provider.getClassHashAt(sender, READ_BLOCK); // must be deployed
    [{ cairo: cairoVersion }, nonce] = await Promise.all([
      provider.getContractVersion(sender, undefined, { blockIdentifier: READ_BLOCK }),
      provider.getNonceForAddress(sender, READ_BLOCK),
    ]);
  } catch (error) {
    // Only the chain ANSWERING "no such contract" establishes that this sender
    // is unusable; a node that simply failed to answer proves nothing about it
    // - the same fail-closed principle the catch below already applies to the
    // simulation itself.
    if (error instanceof RpcError && error.isType("CONTRACT_NOT_FOUND")) {
      return { outcome: "structural", reason: `sender ${sender} is not a usable account` };
    }
    // A node that did not answer proves nothing about this sender, so it must
    // not buy the weaker fallback path - but it is equally not a fact about the
    // payment. Reported as a fault so the caller can answer retryably instead of
    // telling the payer its payment failed.
    return { outcome: "fault", reason: "sender preflight could not be completed" };
  }

  try {
    const calldata = transaction.getExecuteCalldata(call, cairoVersion === "0" ? "0" : "1");
    const zeroBounds = { max_amount: "0x0", max_price_per_unit: "0x0" };
    const response = (await provider.getSimulateTransaction(
      [
        {
          type: TransactionType.INVOKE,
          contractAddress: sender,
          calldata,
          signature: [],
          nonce,
          version: "0x3",
          resourceBounds: { l1_gas: zeroBounds, l2_gas: zeroBounds, l1_data_gas: zeroBounds },
          tip: 0,
          paymasterData: [],
          accountDeploymentData: [],
          nonceDataAvailabilityMode: "L1",
          feeDataAvailabilityMode: "L1",
        },
      ],
      { skipValidate: true, skipFeeCharge: true, blockIdentifier: READ_BLOCK },
    )) as Array<{ transaction_trace?: { execute_invocation?: TraceInvocation } }>;

    const invocation = response?.[0]?.transaction_trace?.execute_invocation;
    if (!invocation) {
      // A response with no readable trace is a response the facilitator could
      // not read - a fault, like every other unreadable answer, not a verdict.
      return { outcome: "fault", reason: "simulation returned no execution trace" };
    }
    const revertReason = findRevertReason(invocation);
    if (revertReason) {
      return {
        outcome: "payment-failure",
        reason: `execution would revert: ${truncate(revertReason)}`,
      };
    }
    const events = checkTransferEvents(invocation, payer, requirements);
    return events.ok ? { outcome: "ok" } : { outcome: "payment-failure", reason: events.reason };
  } catch {
    // A simulation the node could not complete is a check that "cannot be safely
    // determined", so it fails CLOSED (spec verification preamble) rather than
    // being reclassified as structural - which would silently downgrade a
    // transient node fault into the weaker inner-transfer evidence path. The
    // node's raw error text is deliberately not surfaced: it can carry the RPC
    // URL and its credentials.
    return { outcome: "fault", reason: "simulation could not be completed" };
  }
}

/** Trace-event / receipt-event shape (receipts carry from_address; traces use the frame's emitter). */
export interface EventLike {
  from_address?: string;
  keys?: string[];
  data?: string[];
  emitter?: string;
}

/**
 * Assert the event set contains exactly one `asset` Transfer of `amount` from
 * `from` to `to` and nothing else. Used both for the verify-time simulation
 * trace and the settle-time receipt (spec §8 / merchant-truth).
 *
 * @param events - The collected trace or receipt events
 * @param asset - The token contract address the Transfer must be emitted by
 * @param from - The expected sender of the Transfer (payer)
 * @param to - The expected recipient of the Transfer (payTo)
 * @param amount - The exact transfer amount in atomic units
 * @returns Ok when exactly the expected transfer is present, else a reason
 */
export function assertExactTransfer(
  events: EventLike[],
  asset: string,
  from: string,
  to: string,
  amount: bigint,
): SimulationResult {
  // Only Transfers emitted by the asset contract, and only those SENT BY THE
  // PAYER, count. Scoping by emitter alone is not enough: when `asset` is also
  // the v3 fee token, a real receipt carries the executor's fee Transfer from
  // the same contract, and an exactly-one test over all of them would reject a
  // perfectly good payment. Restricting to the payer preserves the rule's
  // purpose - the single-call rule (§7) means an authorized payer moves exactly
  // once, so a second payer-sent Transfer still fails. Fail closed if a Transfer
  // cannot be attributed to a contract (no emitter and no from_address).
  const assetTransfers = events.filter(e => {
    if (!e.keys?.length || !feltEquals(e.keys[0], TRANSFER_EVENT_SELECTOR)) return false;
    const emitter = e.emitter ?? e.from_address;
    return emitter !== undefined && feltEquals(emitter, asset);
  });

  // A matching-key event on the asset that fits NEITHER standard layout MUST
  // fail closed: it is a Transfer we cannot interpret, and skipping it would
  // let an unreadable event hide a second movement of the payer's tokens.
  const parsedTransfers = assetTransfers.map(parseTransferEvent);
  if (parsedTransfers.some(p => p === null)) {
    return { ok: false, reason: "asset emitted a Transfer matching neither standard layout" };
  }

  // Count only Transfers SENT BY THE PAYER. Counting every asset Transfer is
  // wrong when `asset` is also the v3 fee token: a real receipt then carries the
  // executor's fee Transfer from the same contract, and an exactly-one test over
  // all of them would reject a perfectly good payment. The single-call rule (§7)
  // means an authorized payer moves exactly once, so a second payer-sent
  // Transfer still fails here.
  const payerTransfers = parsedTransfers
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .filter(p => feltEquals(p.from, from));
  if (payerTransfers.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly 1 asset Transfer from the payer, found ${payerTransfers.length}`,
    };
  }
  const parsed = payerTransfers[0];
  if (!feltEquals(parsed.to, to) || parsed.amount !== amount) {
    return {
      ok: false,
      reason: "Transfer does not match payer → payTo for the exact amount on the asset",
    };
  }
  return { ok: true };
}

/**
 * Assert the event set CONTAINS the expected `asset` Transfer, ignoring whatever
 * else is present. This is the settlement step 5 criterion, deliberately weaker
 * than {@link assertExactTransfer}: the consuming transaction was submitted
 * outside this settlement attempt, so its full contents are not under this
 * facilitator's control and an exactly-one test would let a front-runner batch a
 * dust transfer to force a paid-but-denied outcome.
 *
 * @param events - The receipt events of the consuming transaction
 * @param asset - The token contract address the Transfer must be emitted by
 * @param from - The expected sender of the Transfer (payer)
 * @param to - The expected recipient of the Transfer (payTo)
 * @param amount - The exact transfer amount in atomic units
 * @returns True when a matching Transfer is present
 */
export function containsExactTransfer(
  events: EventLike[],
  asset: string,
  from: string,
  to: string,
  amount: bigint,
): boolean {
  return events.some(e => {
    if (!e.keys?.length || !feltEquals(e.keys[0], TRANSFER_EVENT_SELECTOR)) return false;
    const emitter = e.emitter ?? e.from_address;
    if (emitter === undefined || !feltEquals(emitter, asset)) return false;
    const parsed = parseTransferEvent(e);
    if (!parsed) return false;
    return feltEquals(parsed.from, from) && feltEquals(parsed.to, to) && parsed.amount === amount;
  });
}

/**
 * Verify the trace's events contain exactly the expected asset Transfer.
 *
 * @param invocation - The execute invocation trace frame
 * @param payer - The payer account contract address
 * @param requirements - The payment requirements (asset, payTo, amount)
 * @returns Ok when exactly the expected transfer is present, else a reason
 */
function checkTransferEvents(
  invocation: TraceInvocation,
  payer: string,
  requirements: PaymentRequirements,
): SimulationResult {
  let requiredAmount: bigint;
  try {
    requiredAmount = BigInt(requirements.amount);
  } catch {
    return { ok: false, reason: "unparsable requirements amount" };
  }
  return assertExactTransfer(
    collectEvents(invocation),
    requirements.asset,
    payer,
    requirements.payTo,
    requiredAmount,
  );
}

/**
 * Parse a Transfer event into `{ from, to, amount }`. Handles both keyed (Cairo
 * 1: keys=[sel, from, to], data=[low, high]) and unkeyed (Cairo 0: keys=[sel],
 * data=[from, to, low, high]) layouts. Exact lengths only - a matching-key
 * event fitting neither layout fails closed (spec rule 8 Transfer definition).
 *
 * @param e - The trace or receipt event
 * @returns The parsed transfer, or null when the layout is unrecognized
 */
function parseTransferEvent(e: TraceEvent): { from: string; to: string; amount: bigint } | null {
  try {
    if (e.keys?.length === 3 && e.data?.length === 2) {
      return {
        from: e.keys[1],
        to: e.keys[2],
        amount: BigInt(e.data[0]) + (BigInt(e.data[1]) << 128n),
      };
    }
    if (e.keys?.length === 1 && e.data?.length === 4) {
      return {
        from: e.data[0],
        to: e.data[1],
        amount: BigInt(e.data[2]) + (BigInt(e.data[3]) << 128n),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Recursively collect all events from a trace frame and its nested calls,
 * attributing each event to its enclosing frame's contract address.
 *
 * @param invocation - The trace invocation frame
 * @returns The flattened list of events with their emitter attributed
 */
function collectEvents(invocation: TraceInvocation): EmittedTraceEvent[] {
  const out: EmittedTraceEvent[] = (invocation.events ?? []).map(e => ({
    ...e,
    emitter: e.from_address ?? invocation.contract_address,
  }));
  for (const child of invocation.calls ?? []) {
    out.push(...collectEvents(child));
  }
  return out;
}

/**
 * Find the first revert reason anywhere in the trace frame tree.
 *
 * @param invocation - The trace invocation frame
 * @returns The revert reason string, or undefined when nothing reverted
 */
function findRevertReason(invocation: TraceInvocation): string | undefined {
  if (invocation.revert_reason) return invocation.revert_reason;
  for (const child of invocation.calls ?? []) {
    const reason = findRevertReason(child);
    if (reason) return reason;
  }
  return undefined;
}

/**
 * Truncate a diagnostic string to a bounded length.
 *
 * @param s - The string to truncate
 * @returns The string, truncated with an ellipsis when longer than 200 chars
 */
function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}
