/**
 * Settlement-path proofs read from the payer-signed prepared transaction.
 *
 * Every contract a transaction uses but does not create travels in
 * `Metadata.input_contracts` with its template, signatories and arguments. The
 * payer's signature covers them, and at execution the confirming participants
 * re-interpret the transaction and authenticate each input contract against its
 * contract id. A payload that misstates a factory, a holding or a preapproval is
 * therefore rejected by the ledger, and nothing moves.
 *
 * That makes the input contracts a source verify can trust for what they state,
 * so the facilitator needs no Scan read to pin the factory, find the delivery
 * path or sum the inputs. What only stakeholders can see, whether an input is
 * still active, is enforced atomically when the transaction executes.
 */
import {
  entryByDeclOrder,
  leafOf,
  PREAPPROVAL_TEMPLATE,
  recordEntries,
  type DecodedInputContract,
  type DecodedPrepared,
  type RecordEntry,
} from "../../prepared-transfer.js";
import type { CantonErrorCode } from "../../types.js";

/** Canton Coin's transfer factory, signed by the DSO alone. */
const AMULET_FACTORY_TEMPLATE = "Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules";
/** A DA Registry Utility receiver's preapproval, which is that token's factory. */
const REGISTRY_FACTORY_TEMPLATE =
  "Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval";
const REGISTRY_TRANSFER_RULE_TEMPLATE = "Utility.Registry.V0.Rule.Transfer:TransferRule";
const REGISTRY_DIRECT_TRANSFER_CHOICE = "TransferRule_DirectTransfer";
const AMULET_HOLDING_TEMPLATE = "Splice.Amulet:Amulet";
/** The choice the Canton Coin transfer factory delivers through a preapproval with. */
const PREAPPROVAL_SEND_CHOICE = "TransferPreapproval_SendV2";
const REGISTRY_HOLDING_TEMPLATE = "Utility.Registry.Holding.V0.Holding:Holding";

/** Ledger Decimal precision shared by Canton Coin and Registry Utility tokens. */
const LEDGER_DECIMALS = 10;

/** Which instrument family the transfer settles through. */
export type TransferKind = "amulet" | "registry";

/** What the facilitator expects of this transfer. */
export interface SettlementPathExpectation {
  payer: string;
  payTo: string;
  instrumentId: { admin: string; id: string };
  /** The transfer amount as a ledger Decimal ("0.0100000000"). */
  amount: string;
  /** The transfer's declared input holding contract ids. */
  inputHoldingCids: readonly string[];
  /** The contract id the transfer's root exercise targets. */
  rootContractId: string;
  /** Registrars this facilitator settles CIP-56 transfers for. */
  trustedRegistrars: ReadonlySet<string>;
  nowMs: number;
}

/** The proven settlement path, or the reason it could not be proven. */
export type SettlementPathResult =
  | { ok: true; kind: TransferKind; preapprovalProvider?: string }
  | { ok: false; reason: CantonErrorCode };

/**
 * Prove the transfer settles through the instrument's real factory, delivers
 * directly to `payTo`, and spends the payer's own holdings covering the amount.
 *
 * @param pt - The decoded, payer-signed prepared transaction.
 * @param expect - The facilitator's expectations for this payment.
 * @returns The transfer kind and preapproval provider, or the failure reason.
 */
export function proveSettlementPath(
  pt: DecodedPrepared,
  expect: SettlementPathExpectation,
): SettlementPathResult {
  // One entry per contract: a second entry under the same id could disagree
  // with the first about what the contract holds.
  const ids = pt.inputContracts.map(ic => ic.contractId);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: "invalid_exact_canton_malformed_payload" };
  }
  const factory = pt.inputContracts.find(ic => ic.contractId === expect.rootContractId);
  const kind = factory ? factoryKind(factory, expect) : undefined;
  if (!factory || !kind) {
    return { ok: false, reason: "invalid_exact_canton_malformed_payload" };
  }

  let preapprovalProvider: string | undefined;
  if (kind === "amulet") {
    const preapproval = proveAmuletPreapproval(pt, expect);
    if (!preapproval.ok) return preapproval;
    preapprovalProvider = preapproval.provider;
  } else if (!proveRegistryDirectDelivery(pt, expect.instrumentId.admin)) {
    return { ok: false, reason: "invalid_exact_canton_preapproval_missing" };
  }

  if (!inputsCoverAmount(pt, expect, kind)) {
    return { ok: false, reason: "invalid_exact_canton_insufficient_inputs" };
  }
  return { ok: true, kind, ...(preapprovalProvider ? { preapprovalProvider } : {}) };
}

/**
 * Identify the root exercise's factory contract. Canton Coin's factory is signed
 * by the DSO (the instrument admin) alone; a registry token's is the receiver's
 * own Registry Utility preapproval for that registrar. Neither can be created by
 * the payer, so a look-alike template under the same name fails here.
 *
 * @param factory - The input contract the root exercise targets.
 * @param expect - The facilitator's expectations for this payment.
 * @returns The transfer kind, or undefined when the factory is not one of them.
 */
function factoryKind(
  factory: DecodedInputContract,
  expect: SettlementPathExpectation,
): TransferKind | undefined {
  const { admin } = expect.instrumentId;
  if (factory.templateQualifiedName === AMULET_FACTORY_TEMPLATE) {
    return sameParties(factory.signatories, [admin]) ? "amulet" : undefined;
  }
  if (factory.templateQualifiedName !== REGISTRY_FACTORY_TEMPLATE) return undefined;
  if (!expect.trustedRegistrars.has(admin)) return undefined;
  if (!sameParties(factory.signatories, [expect.payTo])) return undefined;
  const fields = readRecord(factory.argument);
  const receiver = partyAt(fields, 1, "receiver");
  const instrumentAdmin = partyAt(fields, 2, "instrumentAdmin");
  return receiver === expect.payTo && instrumentAdmin === admin ? "registry" : undefined;
}

/**
 * Canton Coin delivery: the transfer must deliver through the merchant's own
 * `TransferPreapproval`, which must be inside its validity window now:
 *
 *   1. exactly one input contract is a TransferPreapproval (two would let a
 *      decoy stand next to the real one);
 *   2. it names `payTo` as receiver and the instrument admin as DSO;
 *   3. its signatories are exactly {DSO, receiver, provider} — two parties when
 *      the merchant is its own provider, three otherwise;
 *   4. the transaction exercises `TransferPreapproval_SendV2` on that contract.
 *
 * @param pt - The decoded, payer-signed prepared transaction.
 * @param expect - The facilitator's expectations for this payment.
 * @returns The preapproval's provider, or the failure reason.
 */
function proveAmuletPreapproval(
  pt: DecodedPrepared,
  expect: SettlementPathExpectation,
): { ok: true; provider: string } | { ok: false; reason: CantonErrorCode } {
  const missing = {
    ok: false as const,
    reason: "invalid_exact_canton_preapproval_missing" as const,
  };
  const candidates = pt.inputContracts.filter(
    ic => ic.templateQualifiedName === PREAPPROVAL_TEMPLATE,
  );
  const preapproval = candidates.length === 1 ? candidates[0] : undefined;
  if (!preapproval?.contractId) return missing;
  const fields = readRecord(preapproval.argument);
  const dso = partyAt(fields, 0, "dso");
  const receiver = partyAt(fields, 1, "receiver");
  const provider = partyAt(fields, 2, "provider");
  if (dso !== expect.instrumentId.admin || receiver !== expect.payTo || !provider) return missing;
  if (!sameParties(preapproval.signatories, [dso, receiver, provider])) return missing;
  const delivered = pt.exercises.some(
    ex =>
      ex.choiceId === PREAPPROVAL_SEND_CHOICE &&
      ex.templateQualifiedName === PREAPPROVAL_TEMPLATE &&
      ex.contractId === preapproval.contractId,
  );
  if (!delivered) return missing;
  const validFromMs = timestampMsAt(fields, 3, "validFrom");
  const expiresAtMs = timestampMsAt(fields, 5, "expiresAt");
  if (validFromMs === undefined || expiresAtMs === undefined) return missing;
  if (validFromMs > expect.nowMs || expiresAtMs <= expect.nowMs) return missing;
  return { ok: true, provider };
}

/**
 * Registry delivery: the transfer must run `TransferRule_DirectTransfer` on the
 * registrar's own `TransferRule`, which settles in this transaction instead of
 * leaving a pending instruction for the receiver to accept.
 *
 * @param pt - The decoded, payer-signed prepared transaction.
 * @param admin - The registrar party (`instrumentId.admin`).
 * @returns Whether the direct delivery is proven.
 */
function proveRegistryDirectDelivery(pt: DecodedPrepared, admin: string): boolean {
  return pt.exercises.some(ex => {
    if (
      ex.choiceId !== REGISTRY_DIRECT_TRANSFER_CHOICE ||
      ex.templateQualifiedName !== REGISTRY_TRANSFER_RULE_TEMPLATE
    ) {
      return false;
    }
    const rule = pt.inputContracts.find(ic => ic.contractId === ex.contractId);
    if (rule?.templateQualifiedName !== REGISTRY_TRANSFER_RULE_TEMPLATE) return false;
    return (
      rule.signatories.includes(admin) &&
      partyAt(readRecord(rule.argument), 2, "registrar") === admin
    );
  });
}

/**
 * Every declared input must be one of the payer's own holdings of this
 * instrument, carried as an input contract, and together they must cover the
 * amount. A declared input with no input contract is refused: the transaction
 * could not consume it.
 *
 * Canton Coin counts `amount.initialAmount`: since CIP-0078 a transfer charges
 * no holding fee on its inputs (Splice `AmuletRules.summarizeAndConsumeInput`),
 * so the initial amount is exactly what the transfer can spend.
 *
 * @param pt - The decoded, payer-signed prepared transaction.
 * @param expect - The facilitator's expectations for this payment.
 * @param kind - The proven transfer kind.
 * @returns Whether the declared inputs are the payer's and cover the amount.
 */
function inputsCoverAmount(
  pt: DecodedPrepared,
  expect: SettlementPathExpectation,
  kind: TransferKind,
): boolean {
  const cids = expect.inputHoldingCids;
  if (cids.length === 0 || new Set(cids).size !== cids.length) return false;
  const needed = toAtomic(expect.amount);
  if (needed === undefined) return false;
  let total = 0n;
  for (const cid of cids) {
    const holding = pt.inputContracts.find(ic => ic.contractId === cid);
    const amount = holding
      ? kind === "amulet"
        ? amuletAmount(holding, expect)
        : registryHoldingAmount(holding, expect)
      : undefined;
    if (amount === undefined) return false;
    total += amount;
  }
  return total >= needed;
}

/**
 * A Canton Coin holding owned by the payer: `Splice.Amulet:Amulet`, signed by
 * the DSO and the owner. Declaration order: [0] dso [1] owner
 * [2] amount { [0] initialAmount }.
 *
 * @param holding - The input contract.
 * @param expect - The facilitator's expectations for this payment.
 * @returns The holding's amount in atomic units, or undefined when it does not qualify.
 */
function amuletAmount(
  holding: DecodedInputContract,
  expect: SettlementPathExpectation,
): bigint | undefined {
  const { admin } = expect.instrumentId;
  if (holding.templateQualifiedName !== AMULET_HOLDING_TEMPLATE) return undefined;
  if (!sameParties(holding.signatories, [admin, expect.payer])) return undefined;
  const fields = readRecord(holding.argument);
  if (partyAt(fields, 0, "dso") !== admin || partyAt(fields, 1, "owner") !== expect.payer) {
    return undefined;
  }
  const amount = fields ? entryByDeclOrder(fields, 2, "amount") : undefined;
  return numericAt(readRecord(amount?.value), 0, "initialAmount");
}

/**
 * A registry holding owned by the payer: the Registry Utility `Holding`, signed
 * by the registrar and the owner. Declaration order: [2] registrar [3] owner
 * [4] instrument { [1] id } [6] amount.
 *
 * @param holding - The input contract.
 * @param expect - The facilitator's expectations for this payment.
 * @returns The holding's amount in atomic units, or undefined when it does not qualify.
 */
function registryHoldingAmount(
  holding: DecodedInputContract,
  expect: SettlementPathExpectation,
): bigint | undefined {
  const { admin, id } = expect.instrumentId;
  if (holding.templateQualifiedName !== REGISTRY_HOLDING_TEMPLATE) return undefined;
  if (!sameParties(holding.signatories, [admin, expect.payer])) return undefined;
  const fields = readRecord(holding.argument);
  if (partyAt(fields, 2, "registrar") !== admin || partyAt(fields, 3, "owner") !== expect.payer) {
    return undefined;
  }
  const instrument = fields ? entryByDeclOrder(fields, 4, "instrument") : undefined;
  if (textAt(readRecord(instrument?.value), 1, "id") !== id) return undefined;
  return numericAt(fields, 6, "amount");
}

/**
 * Exact set equality of two party lists.
 *
 * @param actual - The parties found.
 * @param expected - The parties required.
 * @returns Whether both name exactly the same parties.
 */
function sameParties(actual: readonly string[], expected: readonly string[]): boolean {
  const a = new Set(actual);
  const e = new Set(expected);
  return a.size === e.size && [...e].every(p => a.has(p));
}

/**
 * Decode a record's fields, or undefined when the value is absent or not a record.
 *
 * @param value - An encoded Daml `Value`.
 * @returns The record's fields in declaration order.
 */
function readRecord(value: Uint8Array | undefined): RecordEntry[] | undefined {
  if (value === undefined) return undefined;
  try {
    return recordEntries(value);
  } catch {
    return undefined;
  }
}

/**
 * Read a leaf of the given kind at a field's declaration position.
 *
 * @param fields - The record's fields.
 * @param position - The field's declaration position.
 * @param label - The field's label, checked against the position.
 * @param kind - The expected leaf kind.
 * @returns The leaf's value, or undefined when absent or of another kind.
 */
function leafAt(
  fields: RecordEntry[] | undefined,
  position: number,
  label: string,
  kind: "party" | "numeric" | "text" | "timestamp",
): string | undefined {
  if (!fields) return undefined;
  try {
    const entry = entryByDeclOrder(fields, position, label);
    const leaf = entry ? leafOf(entry.value) : undefined;
    return leaf?.kind === kind ? leaf.value : undefined;
  } catch {
    return undefined;
  }
}

const partyAt = (f: RecordEntry[] | undefined, pos: number, label: string) =>
  leafAt(f, pos, label, "party");
const textAt = (f: RecordEntry[] | undefined, pos: number, label: string) =>
  leafAt(f, pos, label, "text");
const numericAt = (f: RecordEntry[] | undefined, pos: number, label: string) => {
  const v = leafAt(f, pos, label, "numeric");
  return v === undefined ? undefined : toAtomic(v);
};
const timestampMsAt = (f: RecordEntry[] | undefined, pos: number, label: string) => {
  const v = leafAt(f, pos, label, "timestamp");
  return v === undefined ? undefined : Number(BigInt(v) / 1000n);
};

/**
 * Ledger Decimal ("0.0100000000") → atomic units, exact.
 *
 * @param value - A non-negative ledger Decimal string.
 * @returns The value scaled by 10^10, or undefined when it is not a valid Decimal.
 */
function toAtomic(value: string): bigint | undefined {
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
  const [whole, frac = ""] = value.split(".");
  if (frac.length > LEDGER_DECIMALS) return undefined;
  return BigInt(whole + frac.padEnd(LEDGER_DECIMALS, "0"));
}
