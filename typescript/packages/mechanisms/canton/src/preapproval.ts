/**
 * Merchant setup: make sure a merchant holds a live Canton Coin
 * `TransferPreapproval`.
 *
 * The `exact` scheme settles a payment in one transaction only when the
 * merchant has pre-approved incoming transfers (spec: Merchant Onboarding).
 * Without a live preapproval, verification refuses the payment. A preapproval is
 * time-bounded, so a merchant creates it once and renews it before it expires.
 *
 * {@link ensureTransferPreapproval} does both for a merchant that is an
 * external party hosted on its own participant: the merchant is the provider and
 * the receiver, signs with its own key, and pays the preapproval fee from its
 * own Canton Coin. The prepared transaction comes from the merchant's own
 * participant, which it trusts, so it is signed as prepared.
 */
import { createPrivateKey, randomUUID } from "node:crypto";
import { CantonClient } from "./ledger/client.js";
import { recomputeHash } from "./ledger/canton-hash.js";
import { signPreparedTransactionHash } from "./ledger/external-party.js";
import { ScanClient, type MiningRoundContract } from "./ledger/scan.js";
import { TransferFactoryService } from "./ledger/transfer-factory.js";
import {
  selectInputHoldings,
  type CantonLedgerConfig,
  type CantonScanConfig,
} from "./signer-factory.js";

/** Fee funding: holdings are taken largest-first until they cover this many CC
 *  (the choice returns the rest as change), and never more than this many. */
const FEE_INPUT_TARGET_CC = "50.0";
const MAX_FEE_INPUTS = 20;
const DEFAULT_RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

/** The merchant's participant, Scan, and own signing key. */
export interface TransferPreapprovalSetupConfig extends CantonLedgerConfig, CantonScanConfig {
  /** The merchant party: receiver and provider of the preapproval. */
  party: string;
  /** The merchant's Ed25519 private key as a PKCS8 PEM string. */
  privateKeyPem: string;
  /** The merchant's topology fingerprint. Defaults to the namespace of `party`. */
  fingerprint?: string;
}

/** What {@link ensureTransferPreapproval} should achieve. */
export interface EnsureTransferPreapprovalOptions {
  /** Expiry for a preapproval this call creates or renews. */
  expiresAt: Date;
  /** Renew a live preapproval that expires within this many ms. Default 7 days. */
  renewWithinMs?: number;
}

/** What {@link ensureTransferPreapproval} did. */
export interface EnsureTransferPreapprovalResult {
  action: "unchanged" | "created" | "renewed";
  /** The preapproval's expiry after the call. */
  expiresAt: string;
  /** The updateId of the create or renew transaction, when one ran. */
  updateId?: string;
}

/**
 * Make sure the merchant holds a live Canton Coin `TransferPreapproval`: create
 * one when it has none, renew it when it expires within `renewWithinMs`, and
 * otherwise leave it as it is.
 *
 * Throws when the merchant's live preapproval belongs to another provider and
 * needs renewing (only that provider can renew it), and when the merchant holds
 * no Canton Coin to pay the fee. If the create or renew was submitted but its
 * outcome could not be read, it throws `SubmissionOutcomeUnknownError`: check
 * the preapproval before calling again, since each call pays a fee.
 *
 * @param config - The merchant's participant, Scan, party and key.
 * @param options - The expiry to set and the renewal window.
 * @returns What was done and the resulting expiry.
 */
export async function ensureTransferPreapproval(
  config: TransferPreapprovalSetupConfig,
  options: EnsureTransferPreapprovalOptions,
): Promise<EnsureTransferPreapprovalResult> {
  const scan = new ScanClient({
    scanUrl: config.scanUrl,
    ...(config.scanToken !== undefined ? { token: config.scanToken } : {}),
    flavor: config.scanFlavor ?? "sv",
    ...(config.scanFallbackUrls ? { fallbackUrls: config.scanFallbackUrls } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const now = Date.now();
  const existing = await scan.getTransferPreapprovalByParty(config.party);
  const existingExpiryMs = existing ? Date.parse(existing.expiresAt) : NaN;
  const live = existing !== null && existingExpiryMs > now;
  const renewWithinMs = options.renewWithinMs ?? DEFAULT_RENEW_WITHIN_MS;
  if (live && existingExpiryMs - now > renewWithinMs) {
    return { action: "unchanged", expiresAt: existing.expiresAt };
  }
  if (live && existing.provider !== config.party) {
    throw new Error(
      `the preapproval of ${config.party} expires at ${existing.expiresAt} and was provided by ` +
        `${existing.provider}; only that provider can renew it`,
    );
  }

  const client = new CantonClient({
    participantUrl: config.participantUrl,
    token: config.token,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const [rules, rounds] = await Promise.all([
    scan.getAmuletRules(),
    scan.getOpenAndIssuingMiningRounds(),
  ]);
  const dso = rules.contract.payload.dso;
  const openRound = latestOpenRound(rounds.open, now);
  if (!openRound) throw new Error("no open mining round to create the preapproval against");
  const issuing = rounds.issuing.filter(r => !opensLater(r, now));
  const disclose = (c: MiningRoundContract | typeof rules.contract) => ({
    templateId: c.template_id,
    contractId: c.contract_id,
    createdEventBlob: c.created_event_blob,
    synchronizerId: rules.synchronizerId,
  });
  const context = {
    amuletRules: rules.contract.contract_id,
    context: {
      openMiningRound: openRound.contract_id,
      issuingMiningRounds: issuing.map(r => [{ number: r.payload.round.number }, r.contract_id]),
      validatorRights: [],
      featuredAppRight: null,
    },
  };
  const inputs = await feeInputs(client, config.party, dso);
  const expiresAt = options.expiresAt.toISOString();

  // A live self-provided preapproval is renewed in place; an expired or missing
  // one is replaced by a new preapproval.
  const command = live
    ? {
        templateId: "#splice-amulet:Splice.AmuletRules:TransferPreapproval",
        contractId: existing.contractId,
        choice: "TransferPreapproval_Renew",
        choiceArgument: { context, inputs, newExpiresAt: expiresAt },
      }
    : {
        templateId: "#splice-amulet:Splice.AmuletRules:AmuletRules",
        contractId: rules.contract.contract_id,
        choice: "AmuletRules_CreateTransferPreapproval",
        choiceArgument: {
          context,
          inputs,
          receiver: config.party,
          provider: config.party,
          expiresAt,
          expectedDso: dso,
        },
      };
  const prepared = await client.interactiveSubmissionPrepare({
    userId: config.userId,
    commandId: `x402-preapproval-${randomUUID()}`,
    actAs: [config.party],
    synchronizerId: rules.synchronizerId,
    commands: [{ ExerciseCommand: command }],
    disclosedContracts: [rules.contract, openRound, ...issuing].map(disclose),
  });

  const hashB64 = await recomputeHash(prepared.preparedTransaction);
  const fingerprint = config.fingerprint ?? config.party.split("::")[1];
  if (!fingerprint) {
    throw new Error(`${config.party} is not a party id (<hint>::<fingerprint>); pass fingerprint`);
  }
  const signature = signPreparedTransactionHash(
    hashB64,
    createPrivateKey(config.privateKeyPem),
    fingerprint,
  );
  const { updateId } = await new TransferFactoryService({
    client,
    userId: config.userId,
  }).execute({
    payer: config.party,
    preparedTransaction: prepared.preparedTransaction,
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    partySignatures: {
      signatures: [{ party: config.party, signatures: [{ ...signature }] }],
    },
    submissionId: `x402-preapproval-${randomUUID()}`,
  });
  return { action: live ? "renewed" : "created", expiresAt, updateId };
}

/**
 * The merchant's own Canton Coin holdings to pay the fee from.
 *
 * @param client - The merchant's participant.
 * @param party - The merchant party.
 * @param dso - The DSO party (Canton Coin's instrument admin).
 * @returns `InputAmulet` transfer inputs.
 */
async function feeInputs(
  client: CantonClient,
  party: string,
  dso: string,
): Promise<Array<{ tag: "InputAmulet"; value: string }>> {
  const holdings = await client.readHoldingsV1(party, { admin: dso, id: "Amulet" });
  if (holdings.length === 0) {
    throw new Error(
      `${party} holds no Canton Coin to pay the preapproval fee; fund it and try again`,
    );
  }
  const amounts = new Map(holdings.map(h => [h.cid, h.amount]));
  return selectInputHoldings(amounts, FEE_INPUT_TARGET_CC)
    .slice(0, MAX_FEE_INPUTS)
    .map(cid => ({ tag: "InputAmulet" as const, value: cid }));
}

/**
 * Whether a round opens after `nowMs`.
 *
 * @param round - The mining round.
 * @param nowMs - The current time.
 * @returns True when the round is not open yet.
 */
function opensLater(round: MiningRoundContract, nowMs: number): boolean {
  const opensAtMs = round.payload.opensAt ? Date.parse(round.payload.opensAt) : NaN;
  return Number.isFinite(opensAtMs) && opensAtMs > nowMs;
}

/**
 * The highest-numbered open round that is already open.
 *
 * @param rounds - The open mining rounds.
 * @param nowMs - The current time.
 * @returns The round, or undefined when none is open yet.
 */
function latestOpenRound(
  rounds: MiningRoundContract[],
  nowMs: number,
): MiningRoundContract | undefined {
  return rounds
    .filter(r => !opensLater(r, nowMs))
    .sort((a, b) => {
      const x = BigInt(a.payload.round.number);
      const y = BigInt(b.payload.round.number);
      return x < y ? 1 : x > y ? -1 : 0;
    })[0];
}
