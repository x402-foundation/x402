import { HEDERA_STAKING_REWARD_ACCOUNT } from "../../constants";
import { errorMessage } from "../../internal";
import type {
  HederaContractLog,
  HederaNftTransferEntry,
  HederaTransactionRecord,
  HederaTransferEntry,
} from "../../types";
import { isHbarAsset, isValidHederaEntityId, normalizeHederaAccountIdentifier } from "../../utils";
import {
  ErrSettlementCheckFailed,
  ErrSettlementFeePayerDebitMismatch,
  ErrSettlementPayeeCreditMismatch,
  ErrSettlementPayerDebitMismatch,
  ErrSettlementStatusNotSuccess,
  ErrSettlementUnexpectedDebit,
  ErrSettlementUnexpectedTransfer,
} from "./errors";
import { toLongZeroAddress } from "./executeTransferCall";

/**
 * Status of a successful transaction.
 */
export const SUCCESS_STATUS = "SUCCESS";

/**
 * Key of the HBAR list among the merged transfer lists. Token lists are keyed by token id.
 */
const HBAR_LIST = "HBAR";

const SIGNED_INTEGER = /^-?\d+$/;
const UNSIGNED_INTEGER = /^\d+$/;
const ADDRESS_TOPIC = /^0x[0-9a-fA-F]{64}$/;

/**
 * Transfer events whose sender a log reveals, with the topic index of `from`
 * (ERC-20/721 and ERC-1155 layouts).
 */
const TRANSFER_EVENTS = [
  {
    signature: "Transfer(address,address,uint256)",
    topic: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    fromTopicIndex: 1,
  },
  {
    signature: "TransferSingle(address,address,address,uint256,uint256)",
    topic: "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
    fromTopicIndex: 2,
  },
  {
    signature: "TransferBatch(address,address,address,uint256[],uint256[])",
    topic: "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
    fromTopicIndex: 2,
  },
] as const;

/**
 * The payment a `transferExecutor` settlement must show in its consensus record.
 */
export type TransferExecutorSettlementExpectation = {
  /**
   * `"0.0.0"` for HBAR, otherwise the HTS token id.
   */
  asset: string;
  /**
   * Amount in base units.
   */
  amount: string;
  /**
   * Account id debited `amount` (`payload.payer`).
   */
  payer: string;
  /**
   * `payTo` resolved to its account id.
   */
  payToAccountId: string;
  /**
   * Account that submitted the transaction and paid its fee.
   */
  feePayer: string;
  /**
   * Every account the facilitator controls.
   */
  facilitatorAccounts: readonly string[];
  /**
   * EVM addresses of the facilitator accounts (long-zero and alias), any case.
   */
  facilitatorEvmAddresses: readonly string[];
};

/**
 * Outcome of the settlement record checks.
 */
export type TransferExecutorSettlementVerdict =
  | { ok: true }
  | { ok: false; errorReason: string; errorMessage: string };

type SettlementFailure = Extract<TransferExecutorSettlementVerdict, { ok: false }>;

/**
 * Net change per normalized account id.
 */
type NetChanges = Map<string, bigint>;

/**
 * Transfer lists of a record with its children merged in.
 */
type MergedRecord = {
  /**
   * Keyed by `HBAR_LIST` or by normalized token id. Always holds the HBAR list.
   */
  lists: Map<string, NetChanges>;
  nfts: HederaNftTransferEntry[];
};

/**
 * The expectation, parsed and normalized for comparison with the record.
 */
type ExpectedPayment = {
  /**
   * Key of the asset's list in `MergedRecord.lists`.
   */
  assetList: string;
  isHbar: boolean;
  amount: bigint;
  fee: bigint;
  payer: string;
  payTo: string;
  feePayer: string;
  facilitatorAccounts: Set<string>;
  /**
   * Lowercase 0x-hex.
   */
  facilitatorEvmAddresses: Set<string>;
};

/**
 * Judges a `transferExecutor` settlement from its consensus record
 * (scheme_exact_hedera.md, Phase 4 rule 3). Pure; never throws.
 *
 * The first failing check wins: status, payee credit, facilitator accounts (lists, then logs),
 * payer debit, fee payer debit, third-party debits, extra credits, other lists and NFTs.
 *
 * @param record - Normalized record, children and logs included
 * @param expected - The payment the record must show
 * @returns `{ ok: true }`, or the first failing check's code and message
 */
export function checkTransferExecutorSettlement(
  record: HederaTransactionRecord,
  expected: TransferExecutorSettlementExpectation,
): TransferExecutorSettlementVerdict {
  try {
    if (record.status !== SUCCESS_STATUS) {
      return fail(ErrSettlementStatusNotSuccess, `record status is ${record.status}, not SUCCESS`);
    }
    const payment = parseExpectedPayment(record, expected);
    const merged = mergeRecord(record);
    return (
      checkPayeeCredit(merged, payment) ??
      checkFacilitatorDebits(merged, payment) ??
      checkFacilitatorLogs(record.logs, merged, payment) ??
      checkPayerDebit(merged, payment) ??
      checkFeePayerDebit(merged, payment) ??
      checkThirdPartyDebits(merged, payment) ??
      checkExtraCredits(merged, payment) ??
      checkOtherLists(merged, payment) ?? { ok: true }
    );
  } catch (error) {
    return fail(
      ErrSettlementCheckFailed,
      `settlement record could not be checked: ${errorMessage(error)}`,
    );
  }
}

/**
 * Payee credit: `payTo`'s net credit in `asset` is exactly `amount`.
 *
 * @param merged - Merged record
 * @param payment - Expected payment
 * @returns The failure, or undefined when the check holds
 */
function checkPayeeCredit(
  merged: MergedRecord,
  payment: ExpectedPayment,
): SettlementFailure | undefined {
  const credited = netOf(listOf(merged, payment.assetList), payment.payTo);
  if (credited !== payment.amount) {
    return fail(
      ErrSettlementPayeeCreditMismatch,
      `payTo ${payment.payTo} net credit in ${payment.assetList}: expected ${payment.amount}, ` +
        `record shows ${credited}`,
    );
  }
  return undefined;
}

/**
 * Facilitator safety over the lists: a facilitator account loses at most the fee
 * in HBAR when it is the fee payer, plus `amount` in `asset` when it is also the
 * payer. Any other facilitator account loses nothing, even when it is the payer.
 *
 * @param merged - Merged record
 * @param payment - Expected payment
 * @returns The failure, or undefined when the check holds
 */
function checkFacilitatorDebits(
  merged: MergedRecord,
  payment: ExpectedPayment,
): SettlementFailure | undefined {
  for (const [list, net] of merged.lists) {
    for (const account of payment.facilitatorAccounts) {
      const debit = -netOf(net, account);
      const isFeePayer = account === payment.feePayer;
      const allowed =
        (list === HBAR_LIST && isFeePayer ? payment.fee : 0n) +
        (list === payment.assetList && isFeePayer && account === payment.payer
          ? payment.amount
          : 0n);
      if (debit <= allowed) {
        continue;
      }
      if (list === HBAR_LIST && account === payment.payer && payerPaysFeeInAsset(payment)) {
        const { amount, fee } = payment;
        return fail(
          ErrSettlementUnexpectedTransfer,
          `facilitator account ${account} is the payer and the fee payer: expected an HBAR debit ` +
            `of at most amount ${amount} + fee ${fee} = ${allowed}, record shows ${debit} ` +
            `(amount part ${debit - fee}, fee part ${fee})`,
        );
      }
      return fail(
        ErrSettlementUnexpectedTransfer,
        `facilitator account ${account} debited ${debit} in ${list}: expected at most ${allowed}`,
      );
    }
  }
  return undefined;
}

/**
 * Facilitator safety over the logs: no transfer event moves funds out of a
 * facilitator address. Logs emitted by a token whose list the record carries are skipped,
 * because the lists already judge those movements. A transfer event whose sender can't be
 * decoded fails closed, because it can't show that it moved nothing out of a facilitator address.
 * Logs are judged in order, so the first failing log wins.
 *
 * @param logs - Contract logs, nested calls included
 * @param merged - Merged record
 * @param payment - Expected payment
 * @returns The failure, or undefined when the check holds
 */
function checkFacilitatorLogs(
  logs: readonly HederaContractLog[],
  merged: MergedRecord,
  payment: ExpectedPayment,
): SettlementFailure | undefined {
  const judgedTokenAddresses = new Set(
    [...merged.lists.keys()].filter(list => list !== HBAR_LIST).map(toLongZeroAddress),
  );
  for (const log of logs) {
    if (judgedTokenAddresses.has(log.address.toLowerCase())) {
      continue;
    }
    const event = TRANSFER_EVENTS.find(
      candidate => candidate.topic === log.topics[0]?.toLowerCase(),
    );
    if (event === undefined) {
      continue;
    }
    const fromTopic = log.topics[event.fromTopicIndex];
    const from = addressFromTopic(fromTopic);
    if (from === undefined) {
      return fail(
        ErrSettlementCheckFailed,
        `${event.signature} log from ${log.address}: expected topic ${event.fromTopicIndex} (from) to be ` +
          `a 32-byte address word, record shows ${JSON.stringify(fromTopic) ?? "none"}`,
      );
    }
    if (payment.facilitatorEvmAddresses.has(from)) {
      return fail(
        ErrSettlementUnexpectedTransfer,
        `log from ${log.address} records a transfer out of facilitator address ${from}: expected none`,
      );
    }
  }
  return undefined;
}

/**
 * Payer debit: the payer's net debit in `asset` is `amount`, or
 * `amount + transactionFee` when it is also the fee payer of an HBAR payment.
 *
 * @param merged - Merged record
 * @param payment - Expected payment
 * @returns The failure, or undefined when the check holds
 */
function checkPayerDebit(
  merged: MergedRecord,
  payment: ExpectedPayment,
): SettlementFailure | undefined {
  const { payer, amount, fee } = payment;
  const debited = -netOf(listOf(merged, payment.assetList), payer);
  if (payerPaysFeeInAsset(payment)) {
    if (debited === amount + fee) {
      return undefined;
    }
    return fail(
      ErrSettlementPayerDebitMismatch,
      `payer ${payer} is the fee payer: expected HBAR debit ${amount} + fee ${fee} = ${amount + fee}, ` +
        `record shows ${debited} (amount part ${debited - fee}, fee part ${fee})`,
    );
  }
  if (debited !== amount) {
    return fail(
      ErrSettlementPayerDebitMismatch,
      `payer ${payer} net debit in ${payment.assetList}: expected ${amount}, record shows ${debited}`,
    );
  }
  return undefined;
}

/**
 * Fee payer debit: the fee payer's net HBAR debit is the transaction fee, plus
 * `amount` when it is also the payer of an HBAR payment.
 *
 * @param merged - Merged record
 * @param payment - Expected payment
 * @returns The failure, or undefined when the check holds
 */
function checkFeePayerDebit(
  merged: MergedRecord,
  payment: ExpectedPayment,
): SettlementFailure | undefined {
  const { feePayer, fee } = payment;
  const debited = -netOf(listOf(merged, HBAR_LIST), feePayer);
  const expected = payerPaysFeeInAsset(payment) ? payment.amount + fee : fee;
  if (debited !== expected) {
    return fail(
      ErrSettlementFeePayerDebitMismatch,
      `fee payer ${feePayer} net HBAR debit: expected ${expected} (transaction fee ${fee}), ` +
        `record shows ${debited}`,
    );
  }
  return undefined;
}

/**
 * Third-party debits: no account but the payer and the fee payer loses funds in
 * any fungible list.
 *
 * @param merged - Merged record
 * @param payment - Expected payment
 * @returns The failure, or undefined when the check holds
 */
function checkThirdPartyDebits(
  merged: MergedRecord,
  payment: ExpectedPayment,
): SettlementFailure | undefined {
  for (const [list, net] of merged.lists) {
    for (const [account, change] of net) {
      if (change < 0n && account !== payment.payer && account !== payment.feePayer) {
        return fail(
          ErrSettlementUnexpectedDebit,
          `${account} is neither payer nor fee payer: expected no debit in ${list}, record shows ${-change}`,
        );
      }
    }
  }
  return undefined;
}

/**
 * Extra credits: positive non-`payTo` HBAR changes sum to the transaction fee.
 * For a token, `payTo` is the only credit in its list and all positive HBAR changes sum
 * to the transaction fee.
 *
 * @param merged - Merged record
 * @param payment - Expected payment
 * @returns The failure, or undefined when the check holds
 */
function checkExtraCredits(
  merged: MergedRecord,
  payment: ExpectedPayment,
): SettlementFailure | undefined {
  const { payTo, fee, isHbar } = payment;
  if (!isHbar) {
    for (const [account, change] of listOf(merged, payment.assetList)) {
      if (change > 0n && account !== payTo) {
        return fail(
          ErrSettlementUnexpectedTransfer,
          `${account} credited ${change} in ${payment.assetList}: expected payTo ${payTo} to be the only credit`,
        );
      }
    }
  }
  const feeCredits = positiveSum(listOf(merged, HBAR_LIST), isHbar ? payTo : undefined);
  if (feeCredits !== fee) {
    return fail(
      ErrSettlementUnexpectedTransfer,
      `positive HBAR changes${isHbar ? ` other than payTo ${payTo}` : ""}: expected to sum to ` +
        `transaction fee ${fee}, record shows ${feeCredits}`,
    );
  }
  return undefined;
}

/**
 * Other lists: every token list but `asset`'s nets to zero for every account,
 * and no NFT moves.
 *
 * @param merged - Merged record
 * @param payment - Expected payment
 * @returns The failure, or undefined when the check holds
 */
function checkOtherLists(
  merged: MergedRecord,
  payment: ExpectedPayment,
): SettlementFailure | undefined {
  for (const [list, net] of merged.lists) {
    if (list === HBAR_LIST || list === payment.assetList) {
      continue;
    }
    for (const [account, change] of net) {
      if (change !== 0n) {
        return fail(
          ErrSettlementUnexpectedTransfer,
          `${account} net change in ${list}: expected none, record shows ${change}`,
        );
      }
    }
  }
  const [nft] = merged.nfts;
  if (nft) {
    return fail(
      ErrSettlementUnexpectedTransfer,
      `NFT ${nft.tokenId} serial ${nft.serialNumber} moved from ${nft.senderAccountId ?? "none"} ` +
        `to ${nft.receiverAccountId ?? "none"}: expected no NFT movement`,
    );
  }
  return undefined;
}

/**
 * Parses and normalizes the expectation.
 *
 * @param record - Record, for its transaction fee
 * @param expected - Expected payment
 * @returns Parsed payment
 */
function parseExpectedPayment(
  record: HederaTransactionRecord,
  expected: TransferExecutorSettlementExpectation,
): ExpectedPayment {
  const isHbar = isHbarAsset(expected.asset);
  return {
    assetList: isHbar ? HBAR_LIST : normalizeHederaAccountIdentifier(expected.asset),
    isHbar,
    amount: parseInteger(expected.amount, UNSIGNED_INTEGER, "expected amount"),
    fee: parseInteger(record.transactionFee, UNSIGNED_INTEGER, "transactionFee"),
    payer: normalizeHederaAccountIdentifier(expected.payer),
    payTo: normalizeHederaAccountIdentifier(expected.payToAccountId),
    feePayer: normalizeHederaAccountIdentifier(expected.feePayer),
    facilitatorAccounts: new Set(
      expected.facilitatorAccounts.map(normalizeHederaAccountIdentifier),
    ),
    facilitatorEvmAddresses: new Set(expected.facilitatorEvmAddresses.map(a => a.toLowerCase())),
  };
}

/**
 * Merges the transfer lists of the parent and every child entry.
 *
 * @param record - Normalized record
 * @returns Merged lists
 */
function mergeRecord(record: HederaTransactionRecord): MergedRecord {
  const hbar: NetChanges = new Map();
  const lists = new Map<string, NetChanges>([[HBAR_LIST, hbar]]);
  const nfts: HederaNftTransferEntry[] = [];
  for (const recordEntry of [record.parent, ...record.children]) {
    addTransfers(hbar, recordEntry.hbarTransfers);
    // A staking reward payout debits 0.0.800 and credits the rewarded account in the
    // same list. Net out exactly the payouts this entry marks; anything else stays.
    for (const reward of recordEntry.stakingRewardTransfers) {
      const paid = parseInteger(reward.amount, SIGNED_INTEGER, "staking reward amount");
      addChange(hbar, reward.accountId, -paid);
      addChange(hbar, HEDERA_STAKING_REWARD_ACCOUNT, paid);
    }
    for (const [tokenId, transfers] of Object.entries(recordEntry.tokenTransfers)) {
      const token = normalizeHederaAccountIdentifier(tokenId);
      if (!isValidHederaEntityId(token)) {
        throw new Error(`token id ${JSON.stringify(tokenId)} is not a Hedera entity id`);
      }
      const net = lists.get(token) ?? new Map<string, bigint>();
      lists.set(token, net);
      addTransfers(net, transfers);
    }
    nfts.push(...recordEntry.nftTransfers);
  }
  return { lists, nfts };
}

/**
 * Adds a transfer list to running net changes.
 *
 * @param net - Net changes to update
 * @param transfers - Transfer entries
 */
function addTransfers(net: NetChanges, transfers: readonly HederaTransferEntry[]): void {
  for (const transfer of transfers) {
    addChange(
      net,
      transfer.accountId,
      parseInteger(transfer.amount, SIGNED_INTEGER, "transfer amount"),
    );
  }
}

/**
 * Adds one change to running net changes.
 *
 * @param net - Net changes to update
 * @param accountId - Account id, normalized here
 * @param change - Signed change
 */
function addChange(net: NetChanges, accountId: string, change: bigint): void {
  const account = normalizeHederaAccountIdentifier(accountId);
  net.set(account, netOf(net, account) + change);
}

/**
 * Parses a base-10 integer string strictly (`BigInt` alone accepts `""`, hex and whitespace).
 *
 * @param value - Value to parse
 * @param pattern - Accepted form
 * @param field - Field name for the error message
 * @returns The integer
 */
function parseInteger(value: string, pattern: RegExp, field: string): bigint {
  if (!pattern.test(value)) {
    throw new Error(`${field} ${JSON.stringify(value)} is not a base-10 integer`);
  }
  return BigInt(value);
}

/**
 * Whether the payer also pays the fee from the asset's own list (HBAR).
 *
 * @param payment - Expected payment
 * @returns True when one HBAR debit carries both amount and fee
 */
function payerPaysFeeInAsset(payment: ExpectedPayment): boolean {
  return payment.isHbar && payment.payer === payment.feePayer;
}

/**
 * Decodes an address from an indexed event topic.
 *
 * @param topic - Event topic, absent when the log has too few topics
 * @returns Lowercase 0x-hex address, or undefined when the topic is not a 32-byte word
 */
function addressFromTopic(topic: string | undefined): string | undefined {
  if (topic === undefined || !ADDRESS_TOPIC.test(topic)) {
    return undefined;
  }
  return `0x${topic.slice(-40).toLowerCase()}`;
}

/**
 * Reads a merged list.
 *
 * @param merged - Merged record
 * @param list - `HBAR_LIST` or a normalized token id
 * @returns The list's net changes, empty when the record carries none
 */
function listOf(merged: MergedRecord, list: string): NetChanges {
  return merged.lists.get(list) ?? new Map<string, bigint>();
}

/**
 * Sums the positive net changes.
 *
 * @param net - Net changes
 * @param excluded - Normalized account id left out of the sum
 * @returns Sum of credits
 */
function positiveSum(net: NetChanges, excluded?: string): bigint {
  let sum = 0n;
  for (const [account, change] of net) {
    if (change > 0n && account !== excluded) {
      sum += change;
    }
  }
  return sum;
}

/**
 * Reads an account's net change.
 *
 * @param net - Net changes
 * @param account - Normalized account id
 * @returns The net change, zero when absent
 */
function netOf(net: NetChanges, account: string): bigint {
  return net.get(account) ?? 0n;
}

/**
 * Builds a failed verdict.
 *
 * @param errorReason - Spec error code
 * @param errorMessage - What was expected and what the record shows
 * @returns Failed verdict
 */
function fail(errorReason: string, errorMessage: string): SettlementFailure {
  return { ok: false, errorReason, errorMessage };
}
