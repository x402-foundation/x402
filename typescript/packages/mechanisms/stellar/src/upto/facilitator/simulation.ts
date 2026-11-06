import { Address, scValToBigInt, xdr } from "@stellar/stellar-sdk";
import { SETTLED_EVENT, UptoContractError } from "../constants";
import { reject, type UptoRejection } from "../errors";

/** A host error from a diagnostic event: `topics = ["error", ScError]`, `data = message [, args]`. */
export interface HostError {
  /** The contract whose frame raised it, when known. */
  readonly contract: string | undefined;
  /** Contract, Auth, Crypto, Budget, … */
  readonly type: string;
  /** The contract error number, or the error code's name (e.g. `ExistingValue`). */
  readonly code: number | string;
  readonly message: string | undefined;
  /** The first argument, when it is an address (e.g. the account a token error names). */
  readonly subject: string | undefined;
}

/** Who is who in a settlement. */
export interface SettlementParties {
  readonly contract: string;
  readonly token: string;
  readonly payer: string;
  readonly recipient: string;
  readonly authority: string;
  readonly facilitatorAddresses: ReadonlySet<string>;
}

/**
 * The address an `ScVal` holds, if any.
 *
 * @param value - The value
 * @returns The address, or `undefined`
 */
function addressOf(value: xdr.ScVal | undefined): string | undefined {
  try {
    return value === undefined ? undefined : Address.fromScVal(value).toString();
  } catch {
    return undefined;
  }
}

/**
 * The contract that emitted an event.
 *
 * @param event - The event
 * @returns Its address, or `undefined` for a host event
 */
function contractOf(event: xdr.ContractEvent): string | undefined {
  const id = event.contractId();
  return id ? Address.contract(id as unknown as Buffer).toString() : undefined;
}

/**
 * Extracts the host errors of a failed simulation's diagnostic events, oldest first.
 *
 * @param events - The diagnostic events
 * @returns The host errors
 */
export function hostErrors(events: readonly xdr.DiagnosticEvent[]): HostError[] {
  const errors: HostError[] = [];
  for (const diagnostic of events) {
    try {
      const event = diagnostic.event();
      const body = event.body().v0();
      const topics = body.topics();
      const data = body.data();
      if (topics[0]?.sym().toString() !== "error") continue;
      const error = topics[1]?.error();
      if (error === undefined) continue;
      const contractError = error.switch() === xdr.ScErrorType.sceContract();
      const [first, second] =
        data.switch() === xdr.ScValType.scvVec() ? (data.vec() ?? []) : [data];
      errors.push({
        contract: contractOf(event),
        type: error.switch().name.replace(/^sce/, ""),
        code: contractError ? error.contractCode() : error.code().name.replace(/^scec/, ""),
        message: first?.switch() === xdr.ScValType.scvString() ? first.str().toString() : undefined,
        subject: addressOf(second),
      });
    } catch {
      // Not an error event.
    }
  }
  return errors;
}

/**
 * Host errors named in a simulation's error string, for RPC answers without diagnostic events: the
 * host's event log (newest first), or else the error that ended the simulation.
 *
 * @param message - The simulation's error string
 * @returns The host errors, oldest first
 */
export function hostErrorsFromMessage(message: string): HostError[] {
  const parse = (type = "", code = "") => ({
    type,
    code: /^\d+$/.test(code) ? Number(code) : code,
  });
  const logged: HostError[] = [];
  for (const line of message.split("\n")) {
    const topic = /topics:\[error, Error\((\w+), #?(\w+)\)\]/.exec(line);
    if (topic === null) continue;
    logged.unshift({
      contract: /contract:(C[A-Z2-7]{55})\b/.exec(line)?.[1],
      ...parse(topic[1], topic[2]),
      message: /data:\[?"([^"]*)"/.exec(line)?.[1],
      subject: undefined,
    });
  }
  if (logged.length > 0) return logged;
  const leading = /Error\((\w+), #?(\w+)\)/.exec(message);
  return leading === null
    ? []
    : [
        {
          contract: undefined,
          ...parse(leading[1], leading[2]),
          message: undefined,
          subject: undefined,
        },
      ];
}

const CONTRACT_ERRORS: Record<number, Parameters<typeof reject>[0]> = {
  [UptoContractError.InvalidMaxAmount]: "invalid_upto_stellar_payload_invalid_terms",
  [UptoContractError.NegativeAmount]: "invalid_upto_stellar_requirements_invalid_amount",
  [UptoContractError.AmountExceedsMax]: "invalid_upto_stellar_payload_settlement_exceeds_amount",
  [UptoContractError.NotYetValid]: "invalid_upto_stellar_payload_not_yet_valid",
  [UptoContractError.Expired]: "invalid_upto_stellar_signature_expired",
  [UptoContractError.InvalidRecipient]: "invalid_upto_stellar_requirements_invalid_pay_to",
};

/**
 * Maps a failed settlement simulation to a code (spec, rule 10). Contract errors are attributed by
 * the contract that raised them, and an account that failed authentication is a bad signature even
 * though the host reports it as `Error(Contract, #5)` in the settlement contract's frame. A contract
 * error that names no contract is never mapped by its number alone.
 *
 * @param errors - The host errors, oldest first
 * @param parties - Who is who in the settlement
 * @param simulationError - The simulation's error string
 * @returns The refusal
 */
export function classifySimulationFailure(
  errors: readonly HostError[],
  parties: SettlementParties,
  simulationError: string,
): UptoRejection {
  const payerIsContract = parties.payer.startsWith("C");
  const badSignature = (reason?: string) =>
    payerIsContract
      ? reject("invalid_upto_stellar_payload_smart_account_rejected", reason)
      : reject("invalid_upto_stellar_payload_invalid_signature", reason);
  const describe = (e: HostError) =>
    `Error(${e.type}, ${typeof e.code === "number" ? `#${e.code}` : e.code})${e.message ? `: ${e.message}` : ""}`;

  if (errors.some(e => e.type === "Auth" && e.code === "ExistingValue")) {
    return reject("invalid_upto_stellar_payload_nonce_already_used");
  }
  const authenticationFailed = errors.some(
    e => e.type === "Auth" && e.message?.includes("failed account authentication"),
  );
  const ownError = errors.find(e => e.type === "Contract" && e.contract === parties.contract);
  const ownCode = ownError === undefined ? undefined : CONTRACT_ERRORS[Number(ownError.code)];
  if (!authenticationFailed && ownCode !== undefined) return reject(ownCode);

  const accountError = errors.find(
    e =>
      payerIsContract &&
      e.contract !== undefined &&
      e.contract !== parties.token &&
      e.contract !== parties.contract &&
      (e.type === "Contract" || e.type === "Crypto"),
  );
  if (accountError !== undefined) {
    return badSignature(`The payer's smart account refused: ${describe(accountError)}.`);
  }
  if (errors.some(e => e.type === "Crypto")) return badSignature();

  const tokenError = errors.find(e => e.type === "Contract" && e.contract === parties.token);
  switch (tokenError?.code) {
    case 10:
    case 100:
      return reject("insufficient_funds");
    case 11:
      return reject("invalid_upto_stellar_payload_trustline_not_authorized");
    case 13:
      return tokenError.subject === parties.recipient
        ? reject("invalid_upto_stellar_payload_recipient_trustline_missing")
        : reject("invalid_upto_stellar_payload_payer_trustline_missing");
    case 6:
      return reject("invalid_upto_stellar_payload_account_missing");
  }

  if (errors.some(e => e.type === "Auth" && e.message?.includes("expired"))) {
    return reject("invalid_upto_stellar_signature_expired");
  }
  if (authenticationFailed) {
    const cause = errors.find(e => e.type === "Contract" && e.message !== undefined);
    return badSignature(cause && `The payer's account refused the signature: ${cause.message}.`);
  }
  if (errors.some(e => e.type === "Auth" && e.code === "InvalidAction")) {
    return reject("invalid_upto_stellar_payload_invalid_signature");
  }
  const first = errors[0];
  const detail = first === undefined ? simulationError.split("\n")[0]?.trim() : describe(first);
  return reject(
    "invalid_upto_stellar_payload_simulation_failed",
    detail ? `Simulating the settlement failed: ${detail}.` : undefined,
  );
}

/**
 * The archived entries a simulation needs restored.
 *
 * @param data - The simulated transaction data
 * @returns Their keys
 */
export function archivedKeys(data: xdr.SorobanTransactionData): xdr.LedgerKey[] {
  const ext = data.ext();
  const indices = ext.switch() === 1 ? ext.resourceExt().archivedSorobanEntries() : [];
  const readWrite = data.resources().footprint().readWrite();
  return indices.flatMap(index => readWrite[index] ?? []);
}

/**
 * Refuses archived entries (spec, rule 10), naming the settlement contract's instance or code.
 *
 * @param keys - The archived entries; at least one
 * @param contract - The settlement contract
 * @param wasmHash - Hex sha256 of its WASM, when known
 * @returns The refusal
 */
export function archivedStateRejection(
  keys: readonly xdr.LedgerKey[],
  contract: string,
  wasmHash: string | undefined,
): UptoRejection {
  const isContract = (key: xdr.LedgerKey) =>
    (key.switch() === xdr.LedgerEntryType.contractData() &&
      Address.fromScAddress(key.contractData().contract()).toString() === contract &&
      key.contractData().key().switch() === xdr.ScValType.scvLedgerKeyContractInstance()) ||
    (key.switch() === xdr.LedgerEntryType.contractCode() &&
      key.contractCode().hash().toString("hex") === wasmHash);
  return keys.some(isContract)
    ? reject("invalid_upto_stellar_settlement_contract_archived")
    : reject("invalid_upto_stellar_payload_archived_state");
}

/**
 * An `i128` amount, or the `amount` field of a map.
 *
 * @param value - The event data
 * @returns The amount, or `undefined`
 */
function amountOf(value: xdr.ScVal | undefined): bigint | undefined {
  if (value?.switch() === xdr.ScValType.scvI128()) return scValToBigInt(value);
  return value?.switch() === xdr.ScValType.scvMap()
    ? amountOf(fieldsOf(value).get("amount"))
    : undefined;
}

/**
 * The symbol-keyed fields of a map.
 *
 * @param value - The map
 * @returns Its fields
 */
function fieldsOf(value: xdr.ScVal): Map<string, xdr.ScVal> {
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of value.switch() === xdr.ScValType.scvMap() ? (value.map() ?? []) : []) {
    if (entry.key().switch() === xdr.ScValType.scvSymbol()) {
      fields.set(entry.key().sym().toString(), entry.val());
    }
  }
  return fields;
}

const BALANCE_EVENTS = new Set(["transfer", "mint", "burn", "clawback"]);

/**
 * Checks the events of a successful simulation (spec, rule 12): one `transfer` of `amount` from the
 * payer to payTo by the token (none for zero), no balance event involving a facilitator address,
 * and one matching `upto_settled`. Both the Stellar Asset Contract's and SEP-41's event shapes are
 * accepted.
 *
 * @param events - The diagnostic events
 * @param parties - Who is who in the settlement
 * @param amount - The amount being settled
 * @param maxAmount - The signed maximum
 * @returns The refusal, or `undefined`
 */
export function checkSimulationEvents(
  events: readonly xdr.DiagnosticEvent[],
  parties: SettlementParties,
  amount: bigint,
  maxAmount: bigint,
): UptoRejection | undefined {
  const moves: { contract?: string; name: string; topics: xdr.ScVal[]; data: xdr.ScVal }[] = [];
  const settled: { topics: xdr.ScVal[]; data: xdr.ScVal }[] = [];
  for (const diagnostic of events) {
    const event = diagnostic.event();
    if (
      !diagnostic.inSuccessfulContractCall() ||
      event.type() !== xdr.ContractEventType.contract()
    ) {
      continue;
    }
    const body = event.body().v0();
    const topics = body.topics();
    const data = body.data();
    if (topics[0]?.switch() !== xdr.ScValType.scvSymbol()) continue;
    const name = topics[0].sym().toString();
    const contract = contractOf(event);
    if (BALANCE_EVENTS.has(name)) moves.push({ contract, name, topics, data });
    else if (name === SETTLED_EVENT && contract === parties.contract)
      settled.push({ topics, data });
  }

  const unexpected = reject("invalid_upto_stellar_payload_unexpected_balance_change");
  const involved = moves.flatMap(move => move.topics.slice(1).map(addressOf));
  if (
    involved.some(address => address !== undefined && parties.facilitatorAddresses.has(address))
  ) {
    return unexpected;
  }
  if (moves.length !== (amount === 0n ? 0 : 1)) return unexpected;
  const [move] = moves;
  if (
    move !== undefined &&
    (move.name !== "transfer" ||
      move.contract !== parties.token ||
      addressOf(move.topics[1]) !== parties.payer ||
      addressOf(move.topics[2]) !== parties.recipient ||
      amountOf(move.data) !== amount)
  ) {
    return unexpected;
  }

  const [event, ...more] = settled;
  const fields = event === undefined ? undefined : fieldsOf(event.data);
  if (
    event === undefined ||
    fields === undefined ||
    more.length > 0 ||
    addressOf(event.topics[1]) !== parties.payer ||
    addressOf(event.topics[2]) !== parties.recipient ||
    addressOf(fields.get("token")) !== parties.token ||
    addressOf(fields.get("facilitator")) !== parties.authority ||
    amountOf(fields.get("amount")) !== amount ||
    amountOf(fields.get("max_amount")) !== maxAmount
  ) {
    return reject("invalid_upto_stellar_payload_settlement_event_mismatch");
  }
  return undefined;
}
